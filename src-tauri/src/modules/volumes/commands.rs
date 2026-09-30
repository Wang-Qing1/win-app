//! 分卷模块的命令层。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    VolumeCreateInput, VolumeListItem, VolumeRemovalResult, VolumeReorderInput,
    VolumeReorderResult, VolumeUpdateInput, LIMIT_PER_BOOK, LIMIT_SUMMARY, LIMIT_TITLE,
};
use super::service;

fn parse_create(input: Option<Value>) -> AppResult<VolumeCreateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let book_id = validator.id("bookId", "书籍 ID 非法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "分卷名称不能为空",
        &format!("分卷名称最多 {LIMIT_TITLE} 个字符"),
    );
    let summary = validator.string(
        "summary",
        "",
        LIMIT_SUMMARY,
        &format!("分卷简介最多 {LIMIT_SUMMARY} 个字符"),
        &format!("分卷简介最多 {LIMIT_SUMMARY} 个字符"),
    );

    validator.finish()?;
    Ok(VolumeCreateInput {
        book_id,
        title,
        summary,
    })
}

fn parse_update(input: Option<Value>) -> AppResult<VolumeUpdateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let id = validator.id("id", "分卷 ID 非法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "分卷名称不能为空",
        &format!("分卷名称最多 {LIMIT_TITLE} 个字符"),
    );
    let summary = validator.string(
        "summary",
        "",
        LIMIT_SUMMARY,
        &format!("分卷简介最多 {LIMIT_SUMMARY} 个字符"),
        &format!("分卷简介最多 {LIMIT_SUMMARY} 个字符"),
    );

    validator.finish()?;
    Ok(VolumeUpdateInput {
        id,
        title,
        summary,
    })
}

#[tauri::command]
pub fn volumes_list(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<VolumeListItem>> {
    dispatch("查询分卷列表", "volumes:list", || {
        let book_id = Validator::new(&payload(input)).id("bookId", "书籍 ID 非法");
        let conn = state.connection()?;
        service::list(&conn, book_id)
    })
}

#[tauri::command]
pub fn volumes_create(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<VolumeListItem> {
    dispatch("新增分卷", "volumes:create", || {
        let parsed = parse_create(input)?;
        let conn = state.connection()?;
        service::create(&conn, &parsed)
    })
}

#[tauri::command]
pub fn volumes_update(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<VolumeListItem> {
    dispatch("更新分卷", "volumes:update", || {
        let parsed = parse_update(input)?;
        let conn = state.connection()?;
        service::update(&conn, &parsed)
    })
}

#[tauri::command]
pub fn volumes_remove(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<VolumeRemovalResult> {
    dispatch("删除分卷", "volumes:remove", || {
        let id = Validator::new(&payload(input)).id("id", "分卷 ID 非法");
        let conn = state.connection()?;
        service::remove(&conn, id)
    })
}

#[tauri::command]
pub fn volumes_reorder(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<VolumeReorderResult> {
    dispatch("调整分卷顺序", "volumes:reorder", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        let book_id = validator.id("bookId", "书籍 ID 非法");
        let ordered_ids = validator.id_array(
            "orderedIds",
            LIMIT_PER_BOOK as usize,
            "分卷数量超出上限",
        );
        validator.finish()?;

        let conn = state.connection()?;
        service::reorder(&conn, &VolumeReorderInput { book_id, ordered_ids })
    })
}
