//! 配置：全部来自环境变量，启动时一次性校验。
//!
//! 对应 TS 侧的 `src/main/config/env.ts`。语义刻意逐条对齐 ——
//! 同一份 `.env` 在两种壳下必须得到同一套配置，否则「换成 Tauri 之后
//! 行为不一样」会变成一堆无从下手的差异。
//!
//! 任何一项非法立即快速失败，而不是等到运行时某个功能静默失效。
//! 业务代码永远不直接读环境变量。

use std::path::{Path, PathBuf};

use crate::core::logger::LogLevel;

/// 配置错误：单独一类，启动阶段捕获后弹窗提示而不是抛未捕获异常。
#[derive(Debug)]
pub struct ConfigError {
    pub issues: Vec<String>,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "环境变量校验失败：")?;
        for line in &self.issues {
            writeln!(f, "  · {line}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, Copy)]
pub struct WindowConfig {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub env: String,
    pub is_development: bool,
    pub is_production: bool,
    pub log_level: LogLevel,
    pub log_max_bytes: u64,
    pub log_dir: PathBuf,
    pub db_file_name: String,
    pub user_data_dir: PathBuf,
    pub window: WindowConfig,
    pub open_dev_tools: bool,
    pub disable_gpu: bool,
}

/* ------------------------------------------------------------------ *
 * 默认值（与 TS 侧 zod 的 .default() 一一对应）
 * ------------------------------------------------------------------ */
const DEFAULT_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const MIN_LOG_MAX_BYTES: u64 = 64 * 1024;
const MAX_LOG_MAX_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_DB_FILENAME: &str = "winbook.db";
const DEFAULT_WINDOW_WIDTH: u32 = 1280;
const DEFAULT_WINDOW_HEIGHT: u32 = 820;
const MIN_WINDOW_WIDTH: u32 = 640;
const MIN_WINDOW_HEIGHT: u32 = 480;
const MAX_WINDOW_DIMENSION: u32 = 10_000;

const ALLOWED_ENVS: [&str; 3] = ["development", "production", "test"];

pub fn load_config() -> Result<AppConfig, ConfigError> {
    let user_data_dir = resolve_user_data_dir();
    load_dotenv_files(&user_data_dir);

    let mut issues: Vec<String> = Vec::new();

    let env = pick_enum("NODE_ENV", "production", &ALLOWED_ENVS, &mut issues);
    let log_level_raw = pick_enum(
        "WINBOOK_LOG_LEVEL",
        "info",
        &["debug", "info", "warn", "error"],
        &mut issues,
    );
    let log_level = LogLevel::parse(&log_level_raw).unwrap_or(LogLevel::Info);

    let log_max_bytes = pick_bounded_u64(
        "WINBOOK_LOG_MAX_BYTES",
        DEFAULT_LOG_MAX_BYTES,
        MIN_LOG_MAX_BYTES,
        MAX_LOG_MAX_BYTES,
        &mut issues,
    );
    let db_file_name = pick_db_filename(&mut issues);
    let width = pick_bounded_u32(
        "WINBOOK_WINDOW_WIDTH",
        DEFAULT_WINDOW_WIDTH,
        MIN_WINDOW_WIDTH,
        MAX_WINDOW_DIMENSION,
        &mut issues,
    );
    let height = pick_bounded_u32(
        "WINBOOK_WINDOW_HEIGHT",
        DEFAULT_WINDOW_HEIGHT,
        MIN_WINDOW_HEIGHT,
        MAX_WINDOW_DIMENSION,
        &mut issues,
    );
    let open_dev_tools = pick_bool("WINBOOK_DEVTOOLS", false, &mut issues);
    let disable_gpu = pick_bool("WINBOOK_DISABLE_GPU", false, &mut issues);

    if !issues.is_empty() {
        return Err(ConfigError { issues });
    }

    let log_dir = user_data_dir.join("logs");

    Ok(AppConfig {
        is_development: env == "development",
        is_production: env == "production",
        env,
        log_level,
        log_max_bytes,
        log_dir,
        db_file_name,
        user_data_dir,
        window: WindowConfig { width, height },
        open_dev_tools,
        disable_gpu,
    })
}

/* ------------------------------------------------------------------ *
 * 取值 + 校验
 *
 * 与 zod 的差别：zod 会一次报出全部问题，这里也照做 —— 逐个 push 到
 * issues 而不是遇到第一个就 return，否则用户要改一次、跑一次、再改一次。
 * ------------------------------------------------------------------ */

fn read_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn pick_enum(key: &str, default: &str, allowed: &[&str], issues: &mut Vec<String>) -> String {
    match read_env(key) {
        None => default.to_string(),
        Some(value) => {
            if allowed.contains(&value.as_str()) {
                value
            } else {
                issues.push(format!(
                    "{key} — 取值必须是 {} 之一，当前为「{value}」",
                    allowed.join(" / ")
                ));
                default.to_string()
            }
        }
    }
}

fn pick_bounded_u64(key: &str, default: u64, min: u64, max: u64, issues: &mut Vec<String>) -> u64 {
    let Some(raw) = read_env(key) else {
        return default;
    };
    match raw.trim().parse::<u64>() {
        Ok(value) if value >= min && value <= max => value,
        Ok(value) => {
            issues.push(format!(
                "{key} — 取值需在 {min}..{max} 之间，当前为 {value}"
            ));
            default
        }
        Err(_) => {
            issues.push(format!("{key} — 不是合法的整数：「{raw}」"));
            default
        }
    }
}

fn pick_bounded_u32(key: &str, default: u32, min: u32, max: u32, issues: &mut Vec<String>) -> u32 {
    let Some(raw) = read_env(key) else {
        return default;
    };
    match raw.trim().parse::<u32>() {
        Ok(value) if value >= min && value <= max => value,
        Ok(value) => {
            issues.push(format!(
                "{key} — 取值需在 {min}..{max} 之间，当前为 {value}"
            ));
            default
        }
        Err(_) => {
            issues.push(format!("{key} — 不是合法的整数：「{raw}」"));
            default
        }
    }
}

fn pick_bool(key: &str, default: bool, issues: &mut Vec<String>) -> bool {
    match read_env(key) {
        None => default,
        Some(value) if value == "true" => true,
        Some(value) if value == "false" => false,
        Some(value) => {
            issues.push(format!("{key} — 只能是 true 或 false，当前为「{value}」"));
            default
        }
    }
}

/// 数据库文件名要拼进路径，因此必须挡住路径分隔符与 Windows 非法字符 ——
/// 否则 `WINBOOK_DB_FILENAME=../../evil.db` 就能把库写到任意位置。
fn pick_db_filename(issues: &mut Vec<String>) -> String {
    let Some(raw) = read_env("WINBOOK_DB_FILENAME") else {
        return DEFAULT_DB_FILENAME.to_string();
    };
    let value = raw.trim().to_string();

    if value.is_empty() {
        issues.push("WINBOOK_DB_FILENAME — 数据库文件名不能为空".into());
        return DEFAULT_DB_FILENAME.to_string();
    }
    if value.chars().count() > 128 {
        issues.push("WINBOOK_DB_FILENAME — 数据库文件名过长".into());
        return DEFAULT_DB_FILENAME.to_string();
    }
    if value.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        issues.push("WINBOOK_DB_FILENAME — 数据库文件名不得包含路径分隔符或非法字符".into());
        return DEFAULT_DB_FILENAME.to_string();
    }
    value
}

/* ------------------------------------------------------------------ *
 * .env 加载：极简解析（刻意不引入 dotenv）
 * 已存在于进程环境的变量优先，便于命令行临时覆盖。
 * ------------------------------------------------------------------ */

fn load_dotenv_files(user_data_dir: &Path) {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 开发期（cargo run）：项目根目录的 .env
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent() {
        candidates.push(project_root.join(".env"));
    }
    // 发布后：exe 同目录 / 用户数据目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(".env"));
        }
    }
    candidates.push(user_data_dir.join(".env"));

    for path in candidates {
        load_dotenv_file(&path);
    }
}

fn load_dotenv_file(path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(separator) = line.find('=') else {
            continue;
        };
        if separator == 0 {
            continue;
        }

        let key = line[..separator].trim();
        let mut value = line[separator + 1..].trim();
        let quoted = (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''));
        if quoted && value.len() >= 2 {
            value = &value[1..value.len() - 1];
        }

        if std::env::var(key).is_err() {
            std::env::set_var(key, value);
        }
    }

    true
}

/// 用户数据目录。
///
/// 刻意与 Electron 版保持一致（`%APPDATA%\winbook`）而不是用 Tauri 默认的
/// identifier 目录：换壳不该让用户的稿子「消失」，升级后要能直接读到老库。
fn resolve_user_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("WINBOOK_USER_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("winbook");
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
