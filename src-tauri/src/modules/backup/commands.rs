//! 备份的命令层（对应 TS 侧 `backup.controller.ts`）。
//!
//! 与导出同理，命令跑在独立线程上（`#[tauri::command(async)]`）不是为并发，
//! 而是为了离开主线程：`ask_target` 里的 `blocking_save_file` 在事件循环
//! 线程上会自己等自己。用 `#[tauri::command(async)]` 而不是 `async fn`、
//! 并在函数体内取 state 的原因见 `exporter/commands.rs` 顶部。

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::logger;
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::BackupDatabaseResult;
use super::service;

// 这条通道**没有入参**：它是「把当前这一份原样存下来」，没有任何可选项。
// TS 版同样忽略 `_input`，前端调用时也不传。
fn run_backup(window: &WebviewWindow, state: &AppState) -> AppResult<BackupDatabaseResult> {
    let suggested_name = service::suggested_name();

    // 弹框期间不持数据库锁，见 service.rs 顶部说明。
    let Some(target) = service::ask_target(window, &suggested_name)? else {
        // 取消不是错误：调用方据此安静地什么都不做
        return Ok(BackupDatabaseResult {
            canceled: true,
            file_path: None,
            bytes: 0,
        });
    };

    let bytes = {
        let conn = state.connection()?;
        service::write_backup(&conn, &target)?
    };

    let file_path = target.display().to_string();
    logger::info(
        "数据库已备份",
        logger::fields(vec![
            (
                "sourceFile",
                json!(state.db_file.display().to_string()),
            ),
            ("filePath", json!(file_path)),
            ("bytes", json!(bytes)),
        ]),
    );

    Ok(BackupDatabaseResult {
        canceled: false,
        file_path: Some(file_path),
        bytes,
    })
}

#[tauri::command(async)]
pub fn backup_database(app: AppHandle, window: WebviewWindow) -> IpcResponse<BackupDatabaseResult> {
    let state = app.state::<AppState>().inner();
    dispatch("备份数据库", "backup:database", || run_backup(&window, state))
}
