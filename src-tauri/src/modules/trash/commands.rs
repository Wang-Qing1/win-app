//! 回收站的命令层。
//!
//! 四个通道里有两个走**严格**校验（恢复、彻底删除），两个允许降级：
//!   - `trash:list` 会静默把非法 kind 解读成「全部」—— 只读操作，
//!     降级只会让列表多几行，不会造成损害；
//!   - `trash:restore` / `trash:purge` / `trash:empty` 一律拒绝非法值 ——
//!     它们会真的写库。一个写错的 kind 若被悄悄解读成另一种，动作就会落到
//!     错误的实体上（拿章节 id 去删卡片：运气好是 NOT_FOUND，运气不好
//!     删掉一张同号的卡）。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{is_trash_kind, TrashEmptyResult, TrashItemRef, TrashListResult, TRASH_KINDS};
use super::service;

/// 恢复 / 彻底删除的共同入参：`{ kind, id }`，两者都必填且严格。
fn parse_item(input: Option<Value>) -> AppResult<(String, i64)> {
    let source = payload(input);
    let mut validator = Validator::new(&source);
    let kind = validator.required_enum("kind", &TRASH_KINDS, "回收站条目类型不合法");
    let id = validator.id("id", "条目 ID 非法");
    validator.finish()?;
    Ok((kind, id))
}

#[tauri::command]
pub fn trash_list(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<TrashListResult> {
    dispatch("查看回收站", "trash:list", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        // zod 里这个字段只是 `z.string().trim()`，没有长度上限 ——
        // 长度本身不是判断依据，`is_trash_kind` 才是
        let raw_kind = validator.string(
            "kind",
            "",
            usize::MAX,
            "回收站条目类型不合法",
            "回收站条目类型不合法",
        );
        validator.finish()?;

        let kind = if is_trash_kind(&raw_kind) {
            Some(raw_kind)
        } else {
            None
        };

        let conn = state.connection()?;
        service::list(&conn, kind.as_deref())
    })
}

#[tauri::command]
pub fn trash_restore(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<TrashItemRef> {
    dispatch("从回收站恢复", "trash:restore", || {
        let (kind, id) = parse_item(input)?;
        let conn = state.connection()?;
        service::restore(&conn, &kind, id)
    })
}

#[tauri::command]
pub fn trash_purge(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<TrashItemRef> {
    dispatch("彻底删除回收站条目", "trash:purge", || {
        let (kind, id) = parse_item(input)?;
        let conn = state.connection()?;
        service::purge(&conn, &kind, id)
    })
}

#[tauri::command]
pub fn trash_empty(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<TrashEmptyResult> {
    dispatch("清空回收站", "trash:empty", || {
        let source = payload(input);
        let mut validator = Validator::new(&source);
        // 缺省 / null → 两种都清；给了就必须合法（写操作严格校验）。
        // 用 enum_value 而不是 string + 事后判断：后者会把非法值静默当成
        // 「全部」，那正好是这里最不能容忍的一种降级
        let kind = validator.enum_value("kind", &TRASH_KINDS, "", "回收站条目类型不合法");
        validator.finish()?;

        let conn = state.connection()?;
        let kind = if kind.is_empty() { None } else { Some(kind) };
        service::empty(&conn, kind.as_deref())
    })
}
