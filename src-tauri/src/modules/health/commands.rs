//! 健康检查的命令层。
//!
//! 与 TS 侧 `health.controller.ts` 一样只做「取依赖 → 调服务 → 回信封」，
//! 不含任何业务判断。`dispatch` 负责 requestId、耗时与错误收敛。

use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::response::IpcResponse;
use crate::state::AppState;

/// 通道名沿用 TS 侧 `IpcChannel.HealthPing` 的取值（`health:ping`）。
/// Rust 函数名不能带冒号，所以函数名与通道名是两份字符串 —— 冒号那份
/// 必须逐字对齐，它是前后端对账的依据。
#[tauri::command]
pub fn health_ping(state: State<'_, AppState>) -> IpcResponse<crate::modules::health::service::HealthStatus> {
    dispatch("健康检查", "health:ping", || {
        let conn = state.connection()?;
        Ok(state.health.ping(&conn))
    })
}

#[tauri::command]
pub fn health_ready(
    state: State<'_, AppState>,
) -> IpcResponse<crate::modules::health::service::ReadinessStatus> {
    dispatch("就绪检查", "health:ready", || {
        let conn = state.connection()?;
        Ok(state.health.ready(&conn))
    })
}
