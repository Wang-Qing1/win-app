//! 数据库备份服务（对应 TS 侧 `backup.service.ts`）。
//!
//! 用 SQLite 自带的**在线备份 API**（`rusqlite::Connection::backup`）而不是
//! 直接复制 .db 文件：连接开的是 WAL 模式（见 `db/`），最新写入可能还没
//! checkpoint 到 .db 主文件里，还压在 `-wal` 边档中。直接复制主文件会漏掉
//! 这一段，备份回来的书少了最后几行；在线备份 API 会自己处理，且在备份
//! 期间不阻塞其它读写。
//!
//! TS 版用的 `db.backup()` 也是同一套东西（better-sqlite3 包的就是
//! `sqlite3_backup_*`），所以两边产出的备份文件等价。
//!
//! 为什么这里带 `&WebviewWindow`：它需要一次原生保存对话框，这是全项目
//! 仅有的两处宿主能力之一（另一处是 exporter）。
//!
//! 与导出模块同样的两段式：`ask_target` 只弹框（**不持数据库锁**），
//! `write_backup` 只写库。用户翻目录可能十几秒，那段时间里编辑器的自动
//! 保存不该排队等锁。

use std::path::{Path, PathBuf};

use rusqlite::{Connection, DatabaseName};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

use crate::core::datetime;
use crate::core::errors::{io_error, AppResult};

/// 默认文件名：`winbook-备份-YYYY-MM-DD.db`。
///
/// 日期取**本地**日历日，与其余模块（日统计、连续写作天数）同口径 ——
/// 用 UTC 的话，晚上八点之后备份出来的文件名会是「明天」。
pub fn suggested_name() -> String {
    format!(
        "winbook-备份-{}.db",
        datetime::local_date_key(datetime::today())
    )
}

/// 弹保存对话框。`Ok(None)` 表示用户取消（这不是错误）。
///
/// `window` 由命令层注入（Tauri 会把发起调用的那个窗口交给命令）：
/// 对话框挂在它下面才会是应用内模态框。
///
/// 必须从**非主线程**调用，理由同 `exporter::service::save_draft`。
pub fn ask_target(window: &WebviewWindow, suggested_name: &str) -> AppResult<Option<PathBuf>> {
    let chosen = window
        .dialog()
        .file()
        .set_title("备份数据库")
        .set_file_name(suggested_name)
        .add_filter("SQLite 数据库", &["db"])
        .set_parent(window)
        .blocking_save_file();

    let Some(chosen) = chosen else {
        return Ok(None);
    };

    let path = chosen
        .into_path()
        .map_err(|error| io_error("无法解析用户选择的备份路径", error))?;

    Ok(Some(path))
}

/// 把当前连接的整份内容写到 `target`，返回写出的字节数。
///
/// 空库也会写出一个合法的 .db（含全部表结构），所以这里不做什么
/// 「没有书就不给备份」的判断 —— 备份的意义正是把「现在这一份」原样存下来。
pub fn write_backup(conn: &Connection, target: &Path) -> AppResult<i64> {
    // rusqlite 的 Connection::backup 内部就是「开目标连接 → step 到 Done →
    // 析构时 sqlite3_backup_finish 收尾」，与 better-sqlite3 的 db.backup()
    // 一路。pages_per_step 固定 100，与 rusqlite 自己的实现保持一致。
    conn.backup(DatabaseName::Main, target, None)
        .map_err(|error| io_error(&format!("备份到 {} 失败", target.display()), error))?;

    // TS 用的是 statSync(path).size —— 以**落地后的文件**为准，而不是
    // 内存里的内容长度：备份文件里还有页头、空闲页与索引，两者不是一个数。
    let bytes = std::fs::metadata(target)
        .map_err(|error| io_error(&format!("无法读取备份文件 {}", target.display()), error))?
        .len();

    Ok(bytes as i64)
}
