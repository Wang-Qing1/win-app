//! 统计模块的契约（对应 TS 侧 `src/shared/modules/stats.ts`）。
//!
//! 这个模块**只有读，没有自己的表**。所有数字都从 books / chapters /
//! writing_sessions 聚合而来，口径的唯一来源也就不会出现第二份副本。
//!
//! 两个字数口径贯穿全局，务必分清：
//!   words_written 写作量 —— 只算写进去的正向增量，用于「今天写了多少」
//!   words_net     净增   —— 真实的字数变化，可能为负，用于进度

use serde::Serialize;

/* ------------------------------------------------------------------ *
 * 概览（首页顶部与统计页头部共用）
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewStats {
    pub book_count: i64,
    /// 状态为「连载中」的书籍数
    pub active_book_count: i64,
    pub volume_count: i64,
    pub chapter_count: i64,
    /// 全书汉字数（各章 hanzi_count 之和）
    pub total_hanzi: i64,
    /// 全书非空白字符数（含标点），用于与网文平台显示的字数对照
    pub total_chars: i64,
    pub total_duration_seconds: i64,

    /// 今日写作量：只算写进去的增量，不受删改影响
    pub today_words_written: i64,
    /// 今日净增：可能为负
    pub today_words_net: i64,
    pub today_duration_seconds: i64,
    /// 今天有过编辑的章节数
    pub today_chapter_count: i64,

    /// 连续写作天数（今天没写但昨天写了，仍算连续）
    pub streak_days: i64,
    /// 全书最近一次编辑时间，用于首页「最后编辑」提示
    pub last_edited_at: Option<String>,
    /// 今日已写汉字占目标的比例所需的分母：各连载中书的目标字数之和
    pub ongoing_target_words: i64,
}

/* ------------------------------------------------------------------ *
 * 趋势
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWordsPoint {
    /// 本地日期 YYYY-MM-DD
    pub date: String,
    pub words_written: i64,
    pub words_net: i64,
    pub duration_seconds: i64,
    /// 当天有写作记录的会话条数，用于判断「有没有写过」
    pub session_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendResult {
    pub from: String,
    pub to: String,
    pub days: Vec<DailyWordsPoint>,
    pub total_words_written: i64,
    pub total_words_net: i64,
    pub total_duration_seconds: i64,
    /// 区间内有写作记录的天数
    pub active_days: i64,
    /// 区间内平均每天写作量（按有记录的天数算，不含空白日）
    pub average_words_per_active_day: i64,
}

#[derive(Debug, Clone)]
pub struct StatsTrendQuery {
    pub days: i64,
    /// None 表示全部书籍
    pub book_id: Option<i64>,
}

/* ------------------------------------------------------------------ *
 * 分书籍进度（首页「在写书籍」与统计页对比）
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookProgressItem {
    pub book_id: i64,
    pub title: String,
    pub accent_color: String,
    pub status: String,
    pub hanzi_count: i64,
    pub target_words: i64,
    pub chapter_count: i64,
    pub last_edited_at: Option<String>,
    /// 最近编辑的那一章，供首页「继续写作」直接跳回上次停笔的地方。
    /// 没有它的话，用户每次打开应用都要自己在章节列表里找位置。
    pub last_chapter_id: Option<i64>,
    pub last_chapter_title: Option<String>,
    /// 区间内这本书贡献的写作量，用于统计页的分书对比
    pub range_words_written: i64,
    pub range_duration_seconds: i64,
}

#[derive(Debug, Clone)]
pub struct BookProgressQuery {
    /// 只返回最近编辑过的前 N 本
    pub limit: i64,
    /// Some(天) 时，每本书额外带上该区间内的写作量
    pub range_days: Option<i64>,
}

/* ------------------------------------------------------------------ *
 * 写作热力日历
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapCell {
    /// 本地日期 YYYY-MM-DD
    pub date: String,
    pub words_written: i64,
    /// 强度等级 0–4。0 表示当天没有写作。
    ///
    /// 分级在服务端算好，避免前端各处自己定义阈值导致颜色含义不一致。
    pub level: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapResult {
    pub from: String,
    pub to: String,
    pub cells: Vec<HeatmapCell>,
    pub max_words: i64,
    pub total_words_written: i64,
    pub active_days: i64,
}

/* ------------------------------------------------------------------ *
 * 强度分级
 * ------------------------------------------------------------------ */

/// 热力图与趋势柱共用的等级阈值。集中在这里，保证两处颜色含义一致。
pub fn level_of(words: i64, max_words: i64) -> i64 {
    if words <= 0 {
        return 0;
    }
    if max_words <= 0 {
        return 1;
    }
    let ratio = words as f64 / max_words as f64;
    if ratio <= 0.25 {
        1
    } else if ratio <= 0.5 {
        2
    } else if ratio <= 0.75 {
        3
    } else {
        4
    }
}
