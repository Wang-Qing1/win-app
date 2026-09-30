//! 大纲模块的命令层。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    OutlineAttachChapterInput, OutlineMaterializeInput, OutlineMaterializeResult, OutlineNode,
    OutlineNodeCreateInput, OutlineNodeMoveInput, OutlineNodeUpdateInput, OutlineRemovalResult,
    OutlineTreeResult, LIMIT_SUMMARY, LIMIT_TITLE, NODE_TYPES, STATUSES,
};
use super::service;

/* ------------------------------------------------------------------ *
 * 入参解析
 * ------------------------------------------------------------------ */

fn parse_create(input: Option<Value>) -> AppResult<OutlineNodeCreateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let book_id = validator.id("bookId", "书籍 ID 非法");
    // 建节点时「不传」与「null」同义：都表示挂在根层（schema 里 default(null)）
    let parent_id = validator.optional_id("parentId", "父节点 ID 非法");
    let node_type = validator.enum_value("nodeType", &NODE_TYPES, "event", "大纲节点类型不合法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "节点标题不能为空",
        &format!("节点标题最多 {LIMIT_TITLE} 个字符"),
    );
    let summary = validator.string(
        "summary",
        "",
        LIMIT_SUMMARY,
        &format!("节点梗概最多 {LIMIT_SUMMARY} 个字符"),
        &format!("节点梗概最多 {LIMIT_SUMMARY} 个字符"),
    );
    let status = validator.enum_value("status", &STATUSES, "planned", "大纲状态不合法");

    validator.finish()?;
    Ok(OutlineNodeCreateInput {
        book_id,
        parent_id,
        node_type,
        title,
        summary,
        status,
    })
}

fn parse_update(input: Option<Value>) -> AppResult<OutlineNodeUpdateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let id = validator.id("id", "节点 ID 非法");
    let node_type = validator.required_enum("nodeType", &NODE_TYPES, "大纲节点类型不合法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "节点标题不能为空",
        &format!("节点标题最多 {LIMIT_TITLE} 个字符"),
    );
    let summary = validator.string(
        "summary",
        "",
        LIMIT_SUMMARY,
        &format!("节点梗概最多 {LIMIT_SUMMARY} 个字符"),
        &format!("节点梗概最多 {LIMIT_SUMMARY} 个字符"),
    );
    let status = validator.required_enum("status", &STATUSES, "大纲状态不合法");

    validator.finish()?;
    Ok(OutlineNodeUpdateInput {
        id,
        node_type,
        title,
        summary,
        status,
    })
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn outline_tree(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<OutlineTreeResult> {
    dispatch("查询大纲树", "outline:tree", || {
        let book_id = Validator::new(&payload(input)).id("bookId", "书籍 ID 非法");
        let conn = state.connection()?;
        service::tree(&conn, book_id)
    })
}

#[tauri::command]
pub fn outline_create(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<OutlineNode> {
    dispatch("新增大纲节点", "outline:create", || {
        let parsed = parse_create(input)?;
        let conn = state.connection()?;
        service::create(&conn, &parsed)
    })
}

#[tauri::command]
pub fn outline_update(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<OutlineNode> {
    dispatch("更新大纲节点", "outline:update", || {
        let parsed = parse_update(input)?;
        let conn = state.connection()?;
        service::update(&conn, &parsed)
    })
}

#[tauri::command]
pub fn outline_remove(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<OutlineRemovalResult> {
    dispatch("删除大纲节点", "outline:remove", || {
        let id = Validator::new(&payload(input)).id("id", "节点 ID 非法");
        let conn = state.connection()?;
        service::remove(&conn, id)
    })
}

#[tauri::command]
pub fn outline_move(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<OutlineNode> {
    dispatch("移动大纲节点", "outline:move", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let id = validator.id("id", "节点 ID 非法");
        let parent_id = validator.required_nullable_id("parentId", "父节点 ID 非法");
        let target_index = validator.required_number(
            "targetIndex",
            0,
            i64::MAX,
            "目标位置非法",
            "目标位置非法",
            "目标位置非法",
        );
        validator.finish()?;

        let conn = state.connection()?;
        service::move_node(
            &conn,
            &OutlineNodeMoveInput {
                id,
                parent_id,
                target_index,
            },
        )
    })
}

#[tauri::command]
pub fn outline_attach_chapter(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<OutlineNode> {
    dispatch("关联大纲节点与章节", "outline:attachChapter", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let id = validator.id("id", "节点 ID 非法");
        let chapter_id = validator.required_nullable_id("chapterId", "章节 ID 非法");
        validator.finish()?;

        let conn = state.connection()?;
        service::attach_chapter(&conn, &OutlineAttachChapterInput { id, chapter_id })
    })
}

#[tauri::command]
pub fn outline_materialize(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<OutlineMaterializeResult> {
    dispatch("大纲节点落地成章节", "outline:materialize", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let id = validator.id("id", "节点 ID 非法");
        let volume_id = validator.optional_id("volumeId", "分卷 ID 非法");
        let target_words = validator.number(
            "targetWords",
            0,
            0,
            crate::modules::chapters::models::LIMIT_TARGET_WORDS,
            "目标字数必须是整数",
            "目标字数不能为负",
            "目标字数超出合理范围",
        );
        validator.finish()?;

        let conn = state.connection()?;
        service::materialize(
            &conn,
            &OutlineMaterializeInput {
                id,
                volume_id,
                target_words,
            },
        )
    })
}
