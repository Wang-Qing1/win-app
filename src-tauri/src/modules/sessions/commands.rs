//! 写作会话的命令层。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    is_iso_datetime, timestamp_millis, SessionFinishInput, SessionListQuery, WritingSession,
    DEFAULT_LIST_LIMIT, LIMIT_DURATION_SECONDS, LIMIT_WORDS, MAX_LIST_LIMIT,
};
use super::service;

/// 结算入参。
///
/// 两条跨字段规则与 zod 的 `.refine` 对应，且都落在具体字段上
/// （`peakWords` / `endedAt`），前端才能把错误指到对应的输入框：
///   1. `peakWords >= startWords`：peak 的含义是「会话过程中出现过的最高字数」，
///      它的初始值就是 start。客户端算出 peak < start 说明采样逻辑有问题，
///      这种数据写进统计表会污染所有派生指标，宁可在这里拒绝。
///   2. `endedAt >= startedAt`。
fn parse_finish(input: Option<Value>) -> AppResult<SessionFinishInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    // zod 里这两个是 `number().int().positive().nullable()`，**没有默认值** ——
    // 缺字段是调用方 bug（不是「没有归属」），null 才是合法的「没有归属」
    let book_id = validator.required_nullable_id("bookId", "书籍 ID 非法");
    let chapter_id = validator.required_nullable_id("chapterId", "章节 ID 非法");

    let started_at = validator.required_string(
        "startedAt",
        usize::MAX,
        "时间格式不正确",
        "时间格式不正确",
    );
    let ended_at = validator.required_string(
        "endedAt",
        usize::MAX,
        "时间格式不正确",
        "时间格式不正确",
    );
    let duration_seconds = validator.required_number(
        "durationSeconds",
        0,
        LIMIT_DURATION_SECONDS,
        "时长必须是整数秒",
        "时长不能为负",
        "单次会话时长超出合理范围",
    );
    let start_words = validator.required_number(
        "startWords",
        0,
        LIMIT_WORDS,
        "字数必须是整数",
        "字数不能为负",
        "字数超出合理范围",
    );
    let end_words = validator.required_number(
        "endWords",
        0,
        LIMIT_WORDS,
        "字数必须是整数",
        "字数不能为负",
        "字数超出合理范围",
    );
    let peak_words = validator.required_number(
        "peakWords",
        0,
        LIMIT_WORDS,
        "字数必须是整数",
        "字数不能为负",
        "字数超出合理范围",
    );

    if !is_iso_datetime(&started_at) {
        validator.record("startedAt", "时间格式不正确");
    }
    if !is_iso_datetime(&ended_at) {
        validator.record("endedAt", "时间格式不正确");
    }

    if peak_words < start_words {
        validator.record("peakWords", "最高字数不能小于起始字数");
    }

    // 解析不出来时不再比大小：格式问题已经记在 startedAt / endedAt 上了，
    // 再补一条「结束时间不能早于开始时间」只会是误导
    if let (Some(start), Some(end)) = (
        timestamp_millis(&started_at),
        timestamp_millis(&ended_at),
    ) {
        if end < start {
            validator.record("endedAt", "结束时间不能早于开始时间");
        }
    }

    validator.finish()?;

    Ok(SessionFinishInput {
        book_id,
        chapter_id,
        started_at,
        ended_at,
        duration_seconds,
        start_words,
        end_words,
        peak_words,
    })
}

fn parse_list_query(input: Option<Value>) -> AppResult<SessionListQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    // zod 里这两个是 `.optional()`：不传表示不限。所以「取到了空串」与
    // 「没给」必须收敛成同一件事 —— 都是 None
    let from = validator.string("from", "", usize::MAX, "时间格式不正确", "时间格式不正确");
    let to = validator.string("to", "", usize::MAX, "时间格式不正确", "时间格式不正确");
    let book_id = validator.optional_id("bookId", "书籍 ID 非法");
    let limit = validator.number(
        "limit",
        DEFAULT_LIST_LIMIT,
        1,
        MAX_LIST_LIMIT,
        "条数非法",
        "条数非法",
        &format!("一次最多取 {MAX_LIST_LIMIT} 条"),
    );

    if !from.is_empty() && !is_iso_datetime(&from) {
        validator.record("from", "时间格式不正确");
    }
    if !to.is_empty() && !is_iso_datetime(&to) {
        validator.record("to", "时间格式不正确");
    }

    validator.finish()?;

    Ok(SessionListQuery {
        from: (!from.is_empty()).then_some(from),
        to: (!to.is_empty()).then_some(to),
        book_id,
        limit,
    })
}

#[tauri::command]
pub fn sessions_finish(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<WritingSession> {
    dispatch("结算写作会话", "sessions:finish", || {
        let parsed = parse_finish(input)?;
        let conn = state.connection()?;
        service::finish(&conn, &parsed)
    })
}

#[tauri::command]
pub fn sessions_list(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<WritingSession>> {
    dispatch("查询写作会话", "sessions:list", || {
        let query = parse_list_query(input)?;
        let conn = state.connection()?;
        service::list(&conn, &query)
    })
}
