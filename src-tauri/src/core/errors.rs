//! 应用内统一错误类型。
//!
//! 约定（与 Electron 版一致）：服务层与仓储层只抛 `AppError`，
//! 命令边界不再做错误转换。只有 `code` / `message` / `requestId` / `issues`
//! 会离开后端进程；`detail` 永远只留在日志里。
//!
//! `detail` 是 Rust 侧新增的一档：TS 里原始异常塞在 `cause` 上，
//! 而 Rust 没有那么自然的「保留 cause 但不上报」的通道，
//! 于是显式分成 `message`（可上报）与 `detail`（仅日志）两个字段。

use crate::core::response::{AppErrorCode, FieldIssue};

/// 内部错误的通用文案。
///
/// 单独提成常量是因为它有**两个码**的用法：`unclassified()` 用 `UNKNOWN`，
/// 而「底层 IO / 系统调用失败」在 TS 版是走到 `INTERNAL_ERROR` 那一支的
/// （见 `ipc-handler.ts::toErrorPayload` 的兜底分支）。文案必须一字不差，
/// 否则同一个故障在两个壳里对用户说的话不一样。
pub const INTERNAL_MESSAGE: &str = "应用内部错误，请稍后重试（若持续出现，请凭追踪 ID 查看日志）";

#[derive(Debug, Clone)]
pub struct AppError {
    pub code: AppErrorCode,
    /// 可上报给前端的用户文案
    pub message: String,
    /// 仅写进日志的细节（SQL 报错原文、底层异常等）
    pub detail: Option<String>,
    pub issues: Option<Vec<FieldIssue>>,
}

impl AppError {
    fn new(code: AppErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            issues: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ValidationError, message)
    }

    /// 带字段明细的校验失败。
    pub fn validation_issues(message: impl Into<String>, issues: Vec<FieldIssue>) -> Self {
        let mut error = Self::new(AppErrorCode::ValidationError, message);
        error.issues = Some(issues);
        error
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::Conflict, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::InternalError, message)
    }

    /// 未归类异常。**文案刻意通用**：真正的错误细节不进前端，
    /// 只留在日志里，配合 requestId 定位。
    pub fn unclassified() -> Self {
        Self::new(AppErrorCode::Unknown, INTERNAL_MESSAGE)
    }

    /// 挂上仅用于日志的细节。
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn is_expected(&self) -> bool {
        self.code.is_expected()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

/// 底层能力（写文件、系统调用、驱动）失败的统一收敛。
///
/// 这类失败在 TS 版里走的是「非 AppError 异常 → `INTERNAL_ERROR`」那一支，
/// 所以码与文案都照它来：给用户一句通用话，真正的系统报错进 `detail`
/// 只落日志 —— 那里面往往带着完整文件路径，不该出现在界面上。
pub fn io_error(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::internal(INTERNAL_MESSAGE).with_detail(format!("{context}：{error}"))
}

/// SQLite 报错一律收敛成「未归类异常」：SQL 原文可能包含表结构甚至数据片段，
/// 不能进前端。细节走 `detail` 进日志。
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError::unclassified().with_detail(format!("SQLite: {error}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError::unclassified().with_detail(format!("JSON: {error}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
