//! 检索的命令层（对应 TS 侧 `search.controller.ts`）。
//!
//! 与列表类查询一样是两步：先按 schema 收口长度与类型，再跑一遍解读规则。
//! 切词（`parse_keywords`）必须与渲染进程高亮用的实现是同一个规则，
//! 否则会出现「界面显示搜了 3 个词、后端只搜了 2 个」这种对不上的情况。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    parse_keywords, SearchQuery, SearchResult, DEFAULT_PER_SOURCE, LIMIT_RAW, MAX_PER_SOURCE,
};
use super::service;

fn parse_query(input: Option<Value>) -> AppResult<SearchQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    // 原始查询串。切词放在契约层做，客户端不必先切好再传
    let raw = validator.string(
        "keywords",
        "",
        LIMIT_RAW,
        &format!("检索词最多 {LIMIT_RAW} 个字符"),
        &format!("检索词最多 {LIMIT_RAW} 个字符"),
    );
    // 限定在某本书内检索；null 表示全库
    let book_id = validator.optional_id("bookId", "书籍 ID 非法");
    let limit = validator.number(
        "limit",
        DEFAULT_PER_SOURCE,
        1,
        MAX_PER_SOURCE,
        "每来源条数非法",
        "每来源条数非法",
        &format!("每个来源最多返回 {MAX_PER_SOURCE} 条"),
    );

    validator.finish()?;

    Ok(SearchQuery {
        keywords: parse_keywords(&raw),
        book_id,
        limit,
    })
}

#[tauri::command]
pub fn search_query(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<SearchResult> {
    dispatch("全库检索", "search:query", || {
        let query = parse_query(input)?;
        let conn = state.connection()?;
        service::query(&conn, &query)
    })
}
