//! 健康检查服务。
//!
//! `ping`  给前端启动时自检用：确认后端活着、数据库能查、schema 已就绪。
//! `ready` 给「可以开始干活了吗」判断用：逐项检查并给出失败原因。
//!
//! 这条通道是诊断用途，因此允许回传数据库路径与文件大小；
//! 业务接口一律不返回这类内部信息。
//!
//! **与 Electron 版的字段差异（重要）**：`RuntimeInfo` 里那几个
//! `electronVersion` / `nodeVersion` / `v8Version` 是旧壳的产物，
//! 换到 Tauri 后并不存在对应物。契约字段**一个都不删**（渲染层与共享类型
//! 都按它定义），但语义改成「宿主外壳版本 / WebView 内核版本」：
//!   - `electronVersion` → Tauri 版本（宿主外壳）
//!   - `chromeVersion`   → WebView2 的 Chromium 版本（同义，仍是浏览器内核）
//!   - `v8Version`       → WebView2 的 V8 版本
//!   - `nodeVersion`     → 空串（Tauri 没有 Node 运行时，不编一个假的）
//! 顺带多回两个新字段（`tauriVersion` / `webviewVersion`），
//! TS 侧接口不认识它们也无害 —— 多字段不会破坏结构类型。

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::Connection;
use serde::Serialize;

use crate::config::AppConfig;
use crate::db::migrator::get_schema_version;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub app_name: String,
    pub app_version: String,
    pub electron_version: String,
    pub chrome_version: String,
    pub node_version: String,
    pub v8_version: String,
    pub platform: String,
    pub arch: String,
    pub is_packaged: bool,
    pub locale: String,
    /// 契约外的补充字段：换壳后真正能用的版本号
    pub tauri_version: String,
    pub webview_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub file: String,
    pub size_bytes: u64,
    pub journal_mode: String,
    pub schema_version: Option<String>,
    pub book_count: i64,
    pub chapter_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub status: String,
    pub uptime_seconds: i64,
    pub runtime: RuntimeInfo,
    pub database: DatabaseInfo,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessCheck {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessStatus {
    pub ready: bool,
    pub checks: Vec<ReadinessCheck>,
}

/// WebView2 的版本号从注册表读，读一次就缓存。
///
/// 为什么不在启动时读：它只是一条诊断信息，不该让冷启动多等一次进程创建。
/// 为什么用 `reg.exe` 而不是引一个注册表 crate：为了这一个字段引入
/// `winreg` 会让依赖树多一层，而 `reg` 在所有受支持的 Windows 上都在。
fn webview_version() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| {
        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                "/v",
                "pv",
            ])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                text.split_whitespace()
                    .last()
                    .filter(|value| value.chars().next().is_some_and(|c| c.is_ascii_digit()))
                    .unwrap_or("unknown")
                    .to_string()
            }
            _ => "unknown".to_string(),
        }
    })
}

pub struct HealthService {
    started_at: std::time::Instant,
    config: AppConfig,
    db_file: PathBuf,
}

impl HealthService {
    pub fn new(config: AppConfig, db_file: PathBuf) -> Self {
        Self {
            started_at: std::time::Instant::now(),
            config,
            db_file,
        }
    }

    pub fn ping(&self, conn: &Connection) -> HealthStatus {
        HealthStatus {
            status: "ok".into(),
            uptime_seconds: self.started_at.elapsed().as_secs() as i64,
            runtime: self.runtime_info(),
            database: self.database_info(conn),
        }
    }

    pub fn ready(&self, conn: &Connection) -> ReadinessStatus {
        let mut checks = vec![ReadinessCheck {
            name: "config".into(),
            ok: true,
            detail: format!("环境={}，日志级别={:?}", self.config.env, self.config.log_level),
        }];

        checks.push(self.check_database(conn));
        checks.push(self.check_migrations(conn));

        ReadinessStatus {
            ready: checks.iter().all(|check| check.ok),
            checks,
        }
    }

    fn runtime_info(&self) -> RuntimeInfo {
        let webview = webview_version().to_string();
        RuntimeInfo {
            app_name: "winbook".into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            electron_version: tauri::VERSION.into(),
            // WebView2 就是 Chromium 内核，这个字段在新壳下依然名副其实
            chrome_version: webview.clone(),
            // Tauri 没有 Node 运行时 —— 宁可留空，也不编一个看起来像真的版本号
            node_version: String::new(),
            v8_version: webview.clone(),
            platform: "win32".into(),
            arch: std::env::consts::ARCH.into(),
            is_packaged: !cfg!(debug_assertions),
            locale: system_locale(),
            tauri_version: tauri::VERSION.into(),
            webview_version: webview,
        }
    }

    fn database_info(&self, conn: &Connection) -> DatabaseInfo {
        let size_bytes = std::fs::metadata(&self.db_file)
            .map(|meta| meta.len())
            .unwrap_or(0);

        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap_or_else(|_| "unknown".into());

        // 计数拿不到时按 0 报，不因为一次查询失败就让整个健康检查变成错误响应 ——
        // 这条通道的用途恰恰是「在出问题时仍然能回答」
        let book_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
            .unwrap_or(0);
        let chapter_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chapters WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        DatabaseInfo {
            file: self.db_file.display().to_string(),
            size_bytes,
            journal_mode,
            schema_version: get_schema_version(conn),
            book_count,
            chapter_count,
        }
    }

    fn check_database(&self, conn: &Connection) -> ReadinessCheck {
        match conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0)) {
            Ok(1) => ReadinessCheck {
                name: "database".into(),
                ok: true,
                detail: format!("连接正常，文件 {}", self.db_file.display()),
            },
            Ok(_) => ReadinessCheck {
                name: "database".into(),
                ok: false,
                detail: "数据库探测查询返回了非预期结果".into(),
            },
            Err(error) => ReadinessCheck {
                name: "database".into(),
                ok: false,
                detail: format!("数据库不可用：{error}"),
            },
        }
    }

    fn check_migrations(&self, conn: &Connection) -> ReadinessCheck {
        let version = get_schema_version(conn);
        ReadinessCheck {
            name: "migrations".into(),
            ok: version.is_some(),
            detail: match &version {
                Some(name) => format!("当前 schema 版本：{name}"),
                None => "尚未应用任何数据库迁移".into(),
            },
        }
    }
}

/// 系统区域设置。取不到就回落 zh-CN —— 这是一个中文用户为主的本地应用，
/// 而不是一个需要精确上报的国际化产品。
fn system_locale() -> String {
    std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "zh-CN".to_string())
}
