//! 跨进程统一响应信封。
//!
//! 对应 TS 侧的 `src/shared/result.ts`，**字段名必须逐字一致**：
//! 渲染层的 `api-client.ts` 会拆这个信封，字段名错了就会退化成
//! 「未知错误」而不是编译期报错 —— 这类错配在旧壳新前端时最难查。
//!
//! 设计要点（与 Electron 版同源）：后端永远不把异常直接抛给前端，
//! 所有命令的返回值都被包成 `IpcResponse`，失败时只回传规范化错误码
//! 与用户可读文案，堆栈与内部细节仅进后端日志。

use serde::Serialize;

/// 规范化错误码。序列化成 `VALIDATION_ERROR` 这种大写下划线形式，
/// 与 TS 侧的 `AppErrorCode` 联合类型一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppErrorCode {
    /// 入参未通过校验 —— 属于调用方问题，前端不应重试
    ValidationError,
    /// 目标资源不存在
    NotFound,
    /// 与现有数据冲突（如唯一性约束）
    Conflict,
    /// 服务端内部错误 —— 前端可有限重试
    InternalError,
    /// 未归类的异常
    Unknown,
}

impl AppErrorCode {
    /// 预期内错误（校验失败、找不到等）：日志按 warn 记录，且不算故障。
    pub fn is_expected(self) -> bool {
        !matches!(self, AppErrorCode::InternalError | AppErrorCode::Unknown)
    }
}

/// 字段级校验明细，供表单把错误定位到具体输入框。
#[derive(Debug, Clone, Serialize)]
pub struct FieldIssue {
    /// 字段路径，如 name / tags.0
    pub path: String,
    pub message: String,
}

impl FieldIssue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

/// 失败信封里的错误体。`requestId` 用 camelCase 序列化 —— 它要能被
/// 日志检索，用户报错时凭它定位到具体那一次调用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorPayload {
    pub code: AppErrorCode,
    /// 面向用户的提示文案，已做脱敏，可直接渲染
    pub message: String,
    /// 请求追踪 ID，与后端日志中的 requestId 对应
    pub request_id: String,
    /// 仅校验类错误携带
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<Vec<FieldIssue>>,
}

/// 统一响应信封。
///
/// 用 `untagged`：序列化后就是 `{"ok":true,"data":...}` 或
/// `{"ok":false,"error":{...}}`，与 TS 的 `IpcResponse<T>` 形状完全相同，
/// 而不是 Rust 默认的 `{"Success":{"ok":true,...}}` 那种带变体名的包法。
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum IpcResponse<T> {
    Success { ok: bool, data: T },
    Failure { ok: bool, error: AppErrorPayload },
}

pub fn ok<T>(data: T) -> IpcResponse<T> {
    IpcResponse::Success { ok: true, data }
}

pub fn fail<T>(error: AppErrorPayload) -> IpcResponse<T> {
    IpcResponse::Failure { ok: false, error }
}

/* ------------------------------------------------------------------ *
 * 下面这些纯函数在 TS 侧是 `shared/result.ts` 里的类型守卫。
 * Rust 侧有类型系统兜底，不再需要运行时守卫，保留文档语义即可。
 * ------------------------------------------------------------------ */
