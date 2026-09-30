//! 统计的命令层（对应 TS 侧 `stats.controller.ts`）。
//!
//! 全部是只读聚合，没有写通道 —— 统计模块不产生数据，只解释数据。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    BookProgressItem, BookProgressQuery, HeatmapResult, OverviewStats, StatsTrendQuery, TrendResult,
};
use super::service;

fn parse_trend_query(input: Option<Value>) -> AppResult<StatsTrendQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let days = validator.number("days", 30, 7, 365, "统计区间过短", "统计区间过短", "统计区间过长");
    let book_id = validator.optional_id("bookId", "书籍 ID 非法");

    validator.finish()?;
    Ok(StatsTrendQuery { days, book_id })
}

fn parse_books_query(input: Option<Value>) -> AppResult<BookProgressQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let limit = validator.number("limit", 5, 1, 50, "条数非法", "条数非法", "最多取 50 本");
    // rangeDays 是「可空且有默认值」：缺省 / null 都表示不带区间统计
    let range_days = validator.optional_id("rangeDays", "统计区间非法");
    if let Some(days) = range_days {
        if !(7..=365).contains(&days) {
            validator.record("rangeDays", "统计区间应在 7 到 365 天之间");
        }
    }

    validator.finish()?;
    Ok(BookProgressQuery { limit, range_days })
}

fn parse_heatmap_query(input: Option<Value>) -> AppResult<(i64, Option<i64>)> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let days = validator.number(
        "days",
        365,
        30,
        365,
        "热力图区间至少 30 天",
        "热力图区间至少 30 天",
        "热力图区间最长一年",
    );
    let book_id = validator.optional_id("bookId", "书籍 ID 非法");

    validator.finish()?;
    Ok((days, book_id))
}

#[tauri::command]
pub fn stats_overview(state: State<'_, AppState>) -> IpcResponse<OverviewStats> {
    dispatch("查询总览统计", "stats:overview", || {
        let conn = state.connection()?;
        service::overview(&conn)
    })
}

#[tauri::command]
pub fn stats_trend(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<TrendResult> {
    dispatch("查询字数趋势", "stats:trend", || {
        let query = parse_trend_query(input)?;
        let conn = state.connection()?;
        service::trend(&conn, &query)
    })
}

#[tauri::command]
pub fn stats_books(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<BookProgressItem>> {
    dispatch("查询分书统计", "stats:books", || {
        let query = parse_books_query(input)?;
        let conn = state.connection()?;
        service::books(&conn, &query)
    })
}

#[tauri::command]
pub fn stats_heatmap(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<HeatmapResult> {
    dispatch("查询写作热力图", "stats:heatmap", || {
        let (days, book_id) = parse_heatmap_query(input)?;
        let conn = state.connection()?;
        service::heatmap(&conn, days, book_id)
    })
}
