//! 章节模块的命令层（对应 TS 侧 `chapter.controller.ts`）。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    Chapter, ChapterCreateInput, ChapterListItem, ChapterListQuery, ChapterMoveInput,
    ChapterRemovalResult, ChapterReorderInput, ChapterReorderResult, ChapterRestoreResult,
    ChapterRevision, ChapterRevisionSummary, ChapterSaveContentInput, ChapterSaveResult,
    ChapterUpdateInput, CHAPTER_STATUSES, LIMIT_CONTENT_HTML, LIMIT_REORDER_BATCH,
    LIMIT_TARGET_WORDS, LIMIT_TITLE,
};
use super::service;

/* ------------------------------------------------------------------ *
 * 入参解析
 * ------------------------------------------------------------------ */

fn parse_list_query(input: Option<Value>) -> AppResult<ChapterListQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let book_id = validator.id("bookId", "书籍 ID 非法");
    // 三态：不传 / null / 数字。见 `Validator::tri_state_id`
    let volume_id = validator.tri_state_id("volumeId", "分卷 ID 非法");

    validator.finish()?;
    Ok(ChapterListQuery { book_id, volume_id })
}

fn parse_create(input: Option<Value>) -> AppResult<ChapterCreateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let book_id = validator.id("bookId", "书籍 ID 非法");
    // 建章时「不传」与「null」同义：都表示未分卷（schema 里 default(null)）
    let volume_id = validator.optional_id("volumeId", "分卷 ID 非法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "章节标题不能为空",
        &format!("章节标题最多 {LIMIT_TITLE} 个字符"),
    );
    let target_words = validator.number(
        "targetWords",
        0,
        0,
        LIMIT_TARGET_WORDS,
        "目标字数必须是整数",
        "目标字数不能为负",
        "目标字数超出合理范围",
    );

    validator.finish()?;
    Ok(ChapterCreateInput {
        book_id,
        volume_id,
        title,
        target_words,
    })
}

fn parse_update(input: Option<Value>) -> AppResult<ChapterUpdateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let id = validator.id("id", "章节 ID 非法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "章节标题不能为空",
        &format!("章节标题最多 {LIMIT_TITLE} 个字符"),
    );
    let status = validator.required_enum("status", &CHAPTER_STATUSES, "章节状态不合法");
    let volume_id = validator.required_nullable_id("volumeId", "分卷 ID 非法");
    let target_words = validator.number(
        "targetWords",
        0,
        0,
        LIMIT_TARGET_WORDS,
        "目标字数必须是整数",
        "目标字数不能为负",
        "目标字数超出合理范围",
    );

    validator.finish()?;
    Ok(ChapterUpdateInput {
        id,
        title,
        status,
        volume_id,
        target_words,
    })
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn chapters_list(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<ChapterListItem>> {
    dispatch("查询章节列表", "chapters:list", || {
        let query = parse_list_query(input)?;
        let conn = state.connection()?;
        service::list(&conn, &query)
    })
}

#[tauri::command]
pub fn chapters_get(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Chapter> {
    dispatch("查询章节详情", "chapters:get", || {
        let id = Validator::new(&payload(input)).id("id", "章节 ID 非法");
        let conn = state.connection()?;
        service::get_by_id(&conn, id)
    })
}

#[tauri::command]
pub fn chapters_create(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterListItem> {
    dispatch("新增章节", "chapters:create", || {
        let parsed = parse_create(input)?;
        let conn = state.connection()?;
        service::create(&conn, &parsed)
    })
}

#[tauri::command]
pub fn chapters_update(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterListItem> {
    dispatch("更新章节", "chapters:update", || {
        let parsed = parse_update(input)?;
        let conn = state.connection()?;
        service::update(&conn, &parsed)
    })
}

#[tauri::command]
pub fn chapters_save_content(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterSaveResult> {
    dispatch("保存章节正文", "chapters:saveContent", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let id = validator.id("id", "章节 ID 非法");
        // 正文可以为空，但字段不能缺 —— 缺字段当成空串等于把正文清空
        let content_html = validator.required_string_allow_empty(
            "contentHtml",
            LIMIT_CONTENT_HTML,
            "正文内容缺失",
            "正文长度超出上限",
        );
        validator.finish()?;

        let conn = state.connection()?;
        let mut baselines = state.revision_baselines()?;
        service::save_content(
            &conn,
            &mut baselines,
            &ChapterSaveContentInput { id, content_html },
        )
    })
}

#[tauri::command]
pub fn chapters_remove(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterRemovalResult> {
    dispatch("删除章节", "chapters:remove", || {
        let id = Validator::new(&payload(input)).id("id", "章节 ID 非法");
        let conn = state.connection()?;
        service::remove(&conn, id)
    })
}

#[tauri::command]
pub fn chapters_reorder(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterReorderResult> {
    dispatch("调整章节顺序", "chapters:reorder", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let book_id = validator.id("bookId", "书籍 ID 非法");
        let volume_id = validator.required_nullable_id("volumeId", "分卷 ID 非法");
        let ordered_ids = validator.id_array(
            "orderedIds",
            LIMIT_REORDER_BATCH,
            "章节数量超出上限",
        );
        validator.finish()?;

        let conn = state.connection()?;
        service::reorder(
            &conn,
            &ChapterReorderInput {
                book_id,
                volume_id,
                ordered_ids,
            },
        )
    })
}

#[tauri::command]
pub fn chapters_move(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterListItem> {
    dispatch("移动章节", "chapters:move", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let id = validator.id("id", "章节 ID 非法");
        let volume_id = validator.required_nullable_id("volumeId", "分卷 ID 非法");
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
        service::move_chapter(
            &conn,
            &ChapterMoveInput {
                id,
                volume_id,
                target_index,
            },
        )
    })
}

#[tauri::command]
pub fn chapters_list_revisions(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<ChapterRevisionSummary>> {
    dispatch("查询章节历史版本", "chapters:list-revisions", || {
        let chapter_id = Validator::new(&payload(input)).id("chapterId", "章节 ID 非法");
        let conn = state.connection()?;
        service::list_revisions(&conn, chapter_id)
    })
}

#[tauri::command]
pub fn chapters_get_revision(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterRevision> {
    dispatch("查询历史版本详情", "chapters:get-revision", || {
        let id = Validator::new(&payload(input)).id("id", "版本 ID 非法");
        let conn = state.connection()?;
        service::get_revision(&conn, id)
    })
}

#[tauri::command]
pub fn chapters_restore_revision(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<ChapterRestoreResult> {
    dispatch("回档到历史版本", "chapters:restore-revision", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let chapter_id = validator.id("chapterId", "章节 ID 非法");
        let revision_id = validator.id("revisionId", "版本 ID 非法");
        validator.finish()?;

        let conn = state.connection()?;
        let mut baselines = state.revision_baselines()?;
        service::restore_revision(&conn, &mut baselines, chapter_id, revision_id)
    })
}
