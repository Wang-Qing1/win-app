//! 命令边界：所有对外命令都必须经过这里。
//!
//! 天然提供三件事：
//!   1. 每个请求一个 requestId，日志与前端错误信封可对账；
//!   2. 任何异常都被收敛成 `IpcResponse` 信封，堆栈不外泄；
//!   3. 成败各记一条结构化日志（含耗时），排障时按 requestId 串起来。
//!
//! 这里**不需要**路由与判重逻辑：命令清单由 `tauri::generate_handler!`
//! 在编译期展开，重名直接编译失败；没注册的名字前端只会收到「命令不存在」。
//!
//! 曾经还维护过一张「最近被拒绝的调用」登记表，那是给一份端到端自检
//! 做观测点用的。那份自检后来被移除了，登记表从此没有读取方
//! （`get_rejections` / `clear_rejections` 的注释里也写着「尚无消费方」），
//! 所以连结构体、静态变量与两个读函数一并删掉了。
//! 代价是「静默失败」少了一个观测点 —— 现在只剩日志这一条线索，
//! 按 `requestId` 去查即可。

use serde::Serialize;
use serde_json::json;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::request_id::create_request_id;
use crate::core::response::{fail, ok, AppErrorPayload, IpcResponse};

/// 命令执行的统一包装。
///
/// `label` 是人类可读名称（写进日志便于定位是哪个功能出错），
/// `channel` 是通道名（与 `src/shared/ipc-channels.ts` 的 `IpcChannel` 常量
/// 逐字一致，用于前后端日志对账）。
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
            log_failure(channel, &error, label, &request_id, started_at);

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

/// 失败路径的结构化日志。
///
/// 分两档是刻意的：`is_expected()` 为真的（校验失败、找不到记录、状态冲突）
/// 是用户输入或操作次序问题，记 `warn`；其余是真正需要人来看的内部故障，记 `error`。
/// 混成一档会让「日志里一片红」变成常态，排障时反而看不见真问题。
///
/// `detail`（SQL 报错原文、底层异常）**只进日志**，绝不进回给前端的信封。
fn log_failure(
    channel: &str,
    error: &AppError,
    label: &str,
    request_id: &str,
    started_at: std::time::Instant,
) {
    let fields = json!({
        "requestId": request_id,
        "channel": channel,
        "label": label,
        "durationMs": started_at.elapsed().as_millis() as u64,
        "code": format!("{:?}", error.code),
        "reason": error.message,
        "detail": error.detail.clone().unwrap_or_default(),
    });

    if error.is_expected() {
        logger::warn("命令调用被拒绝", fields);
    } else {
        logger::error("命令调用发生内部错误", fields);
    }
}
