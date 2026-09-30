//! 命令边界：所有对外命令都必须经过这里。
//!
//! 对应 TS 侧的 `src/main/core/ipc-handler.ts`。它天然提供四件事：
//!   1. 每个请求一个 requestId，日志与前端错误信封可对账；
//!   2. 边界校验（各输入类型的 `validate()`）在进入服务层之前完成；
//!   3. 任何异常都被收敛成 `IpcResponse` 信封，堆栈不外泄；
//!   4. 重复注册直接 panic（`tauri::generate_handler!` 层面编译期就能挡）。
//!
//! 与 TS 版的差别：那边用 `Map` 动态注册 + 运行时判重，这边命令列表是
//! 编译期宏展开的，重名在编译期就报错，所以运行时只保留「拒绝登记」这半边
//! —— 它服务的是冒烟检查，而不是路由。

use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::request_id::create_request_id;
use crate::core::response::{fail, ok, AppErrorPayload, IpcResponse};

/// 被拒绝的调用。只留最近若干条，避免长跑进程里无限增长。
#[derive(Debug, Clone, Serialize)]
pub struct IpcRejection {
    pub channel: String,
    pub code: String,
    pub reason: String,
}

const MAX_TRACKED_REJECTIONS: usize = 50;

static REJECTIONS: Mutex<Vec<IpcRejection>> = Mutex::new(Vec::new());

/// 命令执行的统一包装。
///
/// `label` 是人类可读名称（写进日志便于定位是哪个功能出错），
/// `channel` 是通道名（与 TS 侧 `IpcChannel` 常量逐字一致，
/// 用于前后端对账与拒绝登记）。
pub fn dispatch<T, F>(label: &str, channel: &str, run: F) -> IpcResponse<T>
where
    T: Serialize,
    F: FnOnce() -> AppResult<T>,
{
    let request_id = create_request_id();
    let started_at = std::time::Instant::now();

    match run() {
        Ok(data) => {
            logger::debug(
                "命令调用完成",
                json!({
                    "requestId": request_id,
                    "channel": channel,
                    "label": label,
                    "durationMs": started_at.elapsed().as_millis() as u64,
                }),
            );
            ok(data)
        }
        Err(error) => {
            report_rejection(channel, &error, label, &request_id, started_at);

            let payload = AppErrorPayload {
                code: error.code,
                message: error.message.clone(),
                request_id,
                issues: error.issues.clone(),
            };
            fail(payload)
        }
    }
}

fn report_rejection(
    channel: &str,
    error: &AppError,
    label: &str,
    request_id: &str,
    started_at: std::time::Instant,
) {
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let detail = error.detail.clone().unwrap_or_default();

    let fields = json!({
        "requestId": request_id,
        "channel": channel,
        "label": label,
        "durationMs": duration_ms,
        "code": format!("{:?}", error.code),
        "reason": error.message,
        "detail": detail,
    });

    if error.is_expected() {
        logger::warn("命令调用被拒绝", fields);
    } else {
        logger::error("命令调用发生内部错误", fields);
    }

    // 记一笔，供冒烟检查复查。前端把失败翻译成空列表或骨架屏之后，
    // 整条链路的错误就只剩日志里的一行 —— 而日志默认没人看。
    if let Ok(mut tracked) = REJECTIONS.lock() {
        if tracked.len() < MAX_TRACKED_REJECTIONS {
            tracked.push(IpcRejection {
                channel: channel.to_string(),
                code: format!("{:?}", error.code),
                reason: error.message.clone(),
            });
        }
    }
}

/// 取到目前为止被拒绝的调用（仅冒烟检查使用）。
///
/// 存在的理由：渲染层拿到失败信封后往往降级成空列表 / 骨架屏，
/// 页面上看不出任何异常，检查也就跟着绿。只有把「有没有调用被拒」
/// 单独拎出来断言，这类静默失败才会浮出水面。
///
/// **尚无消费方**：Rust 壳里的 smoke 钩子还没做。先显式放行，免得它被
/// 当成死代码清掉 —— 那会把唯一的静默失败观测点一起删掉。
/// smoke 钩子接上后，这个 `allow` 应当移除。
#[allow(dead_code)]
pub fn get_rejections() -> Vec<IpcRejection> {
    REJECTIONS.lock().map(|items| items.clone()).unwrap_or_default()
}

/// 清空登记表（仅冒烟检查使用）。保留理由同上。
#[allow(dead_code)]
pub fn clear_rejections() {
    if let Ok(mut tracked) = REJECTIONS.lock() {
        tracked.clear();
    }
}
