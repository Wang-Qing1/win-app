//! 卡片关联的命令层。
//!
//! 每个通道都返回「操作之后的完整关联列表」而不是受影响的行数或单个对象：
//! 前端拿着返回值直接替换本地状态即可，省掉一次往返，
//! 也省掉一处「点了按钮、列表却还是旧的」的时序问题。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    CardChapterLink, CardOutlineLink, CardRelation, CardRelationEdge, ChapterCardRef,
    OutlineCardRef, RELATION_LIMIT_LABEL,
};
use super::service;

/* ------------------------------------------------------------------ *
 * 入参解析
 *
 * 通道名 → 命令名仍是确定性映射（`cards:list-by-chapter`
 * → `cards_list_by_chapter`），不维护第二份手写对照表。
 * ------------------------------------------------------------------ */

/// 单 ID 入参：`{ cardId }` / `{ chapterId }` / `{ nodeId }` / `{ bookId }`。
fn parse_id(input: Option<Value>, key: &str) -> AppResult<i64> {
    let source = payload(input);
    let mut validator = Validator::new(&source);
    let id = validator.id(key, "ID 非法");
    validator.finish()?;
    Ok(id)
}

/// 双 ID 入参：`{ cardId, chapterId }` / `{ cardId, nodeId }` / `{ cardId, relatedId }`。
fn parse_pair(input: Option<Value>, first: &str, second: &str) -> AppResult<(i64, i64)> {
    let source = payload(input);
    let mut validator = Validator::new(&source);
    let left = validator.id(first, "ID 非法");
    let right = validator.id(second, "ID 非法");
    validator.finish()?;
    Ok((left, right))
}

/// 关系入参：两个 ID + 关系名。
fn parse_relation(input: Option<Value>) -> AppResult<(i64, i64, String)> {
    let source = payload(input);
    let mut validator = Validator::new(&source);
    let card_id = validator.id("cardId", "ID 非法");
    let related_id = validator.id("relatedId", "ID 非法");
    let relation = validator.required_string(
        "relation",
        RELATION_LIMIT_LABEL,
        "关系名不能为空",
        &format!("关系名最多 {RELATION_LIMIT_LABEL} 个字符"),
    );
    validator.finish()?;
    Ok((card_id, related_id, relation))
}

/* ------------------------------------------------------------------ *
 * 命令：卡片 ↔ 章节
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn cards_list_links(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardChapterLink>> {
    dispatch("查询卡片关联的章节", "cards:list-links", || {
        let card_id = parse_id(input, "cardId")?;
        let conn = state.connection()?;
        service::list_by_card(&conn, card_id)
    })
}

#[tauri::command]
pub fn cards_list_by_chapter(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<ChapterCardRef>> {
    dispatch("查询章节关联的卡片", "cards:list-by-chapter", || {
        let chapter_id = parse_id(input, "chapterId")?;
        let conn = state.connection()?;
        service::list_by_chapter(&conn, chapter_id)
    })
}

#[tauri::command]
pub fn cards_link_chapter(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardChapterLink>> {
    dispatch("把卡片关联到章节", "cards:link-chapter", || {
        let (card_id, chapter_id) = parse_pair(input, "cardId", "chapterId")?;
        let conn = state.connection()?;
        service::link(&conn, card_id, chapter_id)
    })
}

#[tauri::command]
pub fn cards_unlink_chapter(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardChapterLink>> {
    dispatch("解除卡片与章节的关联", "cards:unlink-chapter", || {
        let (card_id, chapter_id) = parse_pair(input, "cardId", "chapterId")?;
        let conn = state.connection()?;
        service::unlink(&conn, card_id, chapter_id)
    })
}

/* ------------------------------------------------------------------ *
 * 命令：卡片 ↔ 大纲节点
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn cards_list_node_links(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardOutlineLink>> {
    dispatch("查询卡片关联的大纲节点", "cards:list-node-links", || {
        let card_id = parse_id(input, "cardId")?;
        let conn = state.connection()?;
        service::list_nodes_by_card(&conn, card_id)
    })
}

#[tauri::command]
pub fn cards_list_by_node(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<OutlineCardRef>> {
    dispatch("查询大纲节点关联的卡片", "cards:list-by-node", || {
        let node_id = parse_id(input, "nodeId")?;
        let conn = state.connection()?;
        service::list_by_node(&conn, node_id)
    })
}

#[tauri::command]
pub fn cards_link_node(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardOutlineLink>> {
    dispatch("把卡片关联到大纲节点", "cards:link-node", || {
        let (card_id, node_id) = parse_pair(input, "cardId", "nodeId")?;
        let conn = state.connection()?;
        service::link_node(&conn, card_id, node_id)
    })
}

#[tauri::command]
pub fn cards_unlink_node(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardOutlineLink>> {
    dispatch("解除卡片与大纲节点的关联", "cards:unlink-node", || {
        let (card_id, node_id) = parse_pair(input, "cardId", "nodeId")?;
        let conn = state.connection()?;
        service::unlink_node(&conn, card_id, node_id)
    })
}

/* ------------------------------------------------------------------ *
 * 命令：卡片 ↔ 卡片
 *
 * 关系这一组里，写入的两个通道同样返回「操作之后的完整列表」；
 * `list-relations` 返回的是**被查询那一头**的视角，另一头由前端另失效一次。
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn cards_list_relations(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardRelation>> {
    dispatch("查询这张卡与其它卡的关系", "cards:list-relations", || {
        let card_id = parse_id(input, "cardId")?;
        let conn = state.connection()?;
        service::list_relations(&conn, card_id)
    })
}

#[tauri::command]
pub fn cards_list_book_relations(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardRelationEdge>> {
    dispatch(
        "查询一本书里的全部关系",
        "cards:list-book-relations",
        || {
            let book_id = parse_id(input, "bookId")?;
            let conn = state.connection()?;
            service::list_relations_by_book(&conn, book_id)
        },
    )
}

#[tauri::command]
pub fn cards_relate(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardRelation>> {
    dispatch("建立两张卡之间的关系", "cards:relate", || {
        let (card_id, related_id, relation) = parse_relation(input)?;
        let conn = state.connection()?;
        service::relate(&conn, card_id, related_id, &relation)
    })
}

#[tauri::command]
pub fn cards_unrelate(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<CardRelation>> {
    dispatch("解除两张卡之间的关系", "cards:unrelate", || {
        let (card_id, related_id) = parse_pair(input, "cardId", "relatedId")?;
        let conn = state.connection()?;
        service::unrelate(&conn, card_id, related_id)
    })
}
