//! 写作会话的契约（前端对应 `src/shared/modules/sessions.ts`）。
//!
//! 这是统计功能的**唯一事实源**。每次「进入编辑器 → 离开或空闲 90 秒」
//! 结算一条记录。为什么要单独记而不是直接从章节目录的字数推：章节目录只是
//! 当前快照，删掉一章就会让历史写作量凭空消失，而「我昨天写了 2000 字」
//! 是既成事实。

use serde::Serialize;

/// 单次会话时长上限（7 天）。仅防止异常数据，正常会话由空闲检测在 90 秒内结束。
pub const LIMIT_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;
/// 单次会话的字数变化上限，防止异常输入写坏统计。
pub const LIMIT_WORDS: i64 = 10_000_000;
/// 列表一次最多取多少条。
pub const MAX_LIST_LIMIT: i64 = 500;
pub const DEFAULT_LIST_LIMIT: i64 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingSession {
    pub id: i64,
    pub book_id: Option<i64>,
    pub chapter_id: Option<i64>,
    pub started_at: String,
    pub ended_at: String,
    pub duration_seconds: i64,
    pub start_words: i64,
    pub end_words: i64,
    pub peak_words: i64,
    /// 写作量 = 最高字数 − 起始字数。首页「今日写了多少」用它
    pub words_written: i64,
    /// 净增 = 结束字数 − 起始字数。书籍进度用它，**可能为负**（校对删字）
    pub words_net: i64,
}

#[derive(Debug, Clone)]
pub struct SessionFinishInput {
    pub book_id: Option<i64>,
    pub chapter_id: Option<i64>,
    pub started_at: String,
    pub ended_at: String,
    pub duration_seconds: i64,
    pub start_words: i64,
    pub end_words: i64,
    pub peak_words: i64,
}

#[derive(Debug, Clone)]
pub struct SessionListQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub book_id: Option<i64>,
    pub limit: i64,
}

/// 时间串能否解析（对应 zod 里那个 `new Date(value)` 不为 NaN 的 refine）。
///
/// JS 的 `Date` 构造函数接受的文法比 RFC3339 宽（还认 `2026/01/01` 这种），
/// 这里只收 RFC3339 与纯日期两种 —— 客户端与测试脚本发过来的都是
/// `toISOString()` 的产物、或是 `YYYY-MM-DD`，都落在这两种之内。
/// 真有人手写一个「JS 认、这里不认」的格式，症状是「明明能算的时间被拒了」，
/// 比反过来（把算不出来的时间放过去，然后在聚合时得到 NaN）安全得多。
pub fn is_iso_datetime(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
        || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// 时间串 → 毫秒时间戳。与 JS 的 `new Date(value).getTime()` 同一口径：
/// 纯日期按 **UTC** 零点解释（`new Date('2026-01-01')` 就是这么定的）。
pub fn timestamp_millis(value: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_utc().timestamp_millis());
    }
    None
}
