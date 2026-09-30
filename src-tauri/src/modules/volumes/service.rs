//! 分卷服务（对应 TS 侧 `volume.service.ts`）：业务规则与事务边界。

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::time::now_iso;
use crate::db::in_transaction;
use crate::modules::books::service as book_service;

use super::models::{
    Volume, VolumeCreateInput, VolumeListItem, VolumeRemovalResult, VolumeReorderInput,
    VolumeReorderResult, VolumeUpdateInput, LIMIT_PER_BOOK,
};
use super::repository;

pub fn list(conn: &Connection, book_id: i64) -> AppResult<Vec<VolumeListItem>> {
    book_service::assert_book_exists(conn, book_id)?;
    repository::list_by_book(conn, book_id)
}

pub fn get_by_id(conn: &Connection, id: i64) -> AppResult<Volume> {
    repository::find_by_id(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("分卷不存在（ID: {id}）")))
}

pub fn create(conn: &Connection, input: &VolumeCreateInput) -> AppResult<VolumeListItem> {
    in_transaction(conn, |conn| {
        book_service::assert_book_exists(conn, input.book_id)?;

        if repository::find_by_title(conn, input.book_id, &input.title, None)?.is_some() {
            return Err(AppError::conflict(format!(
                "本书已有名为「{}」的分卷",
                input.title
            )));
        }

        if repository::count_by_book(conn, input.book_id)? >= LIMIT_PER_BOOK {
            return Err(AppError::validation(format!(
                "单本书的分卷数量不能超过 {LIMIT_PER_BOOK} 个"
            )));
        }

        let order_index = repository::next_order_index(conn, input.book_id)?;
        let created = repository::insert(
            conn,
            input.book_id,
            &input.title,
            &input.summary,
            order_index,
            &now_iso(),
        )?;

        logger::info(
            "分卷已创建",
            logger::fields(vec![
                ("id", serde_json::json!(created.id)),
                ("bookId", serde_json::json!(created.book_id)),
            ]),
        );

        // 回读一次以带上聚合字段，保证返回类型与列表接口一致
        to_list_item(conn, created.id)
    })
}

pub fn update(conn: &Connection, input: &VolumeUpdateInput) -> AppResult<VolumeListItem> {
    in_transaction(conn, |conn| {
        let existing = get_by_id(conn, input.id)?;

        if repository::find_by_title(conn, existing.book_id, &input.title, Some(input.id))?.is_some() {
            return Err(AppError::conflict(format!(
                "本书已有名为「{}」的分卷",
                input.title
            )));
        }

        let updated = repository::update(conn, input.id, &input.title, &input.summary, &now_iso())?
            .ok_or_else(|| AppError::internal(format!("分卷更新失败（ID: {}）", input.id)))?;

        logger::info(
            "分卷已更新",
            logger::fields(vec![("id", serde_json::json!(updated.id))]),
        );

        to_list_item(conn, updated.id)
    })
}

pub fn remove(conn: &Connection, id: i64) -> AppResult<VolumeRemovalResult> {
    in_transaction(conn, |conn| {
        // 只为校验存在性；文案与「不存在」错误由 get_by_id 统一给出
        get_by_id(conn, id)?;

        let detached_chapters = repository::count_chapters(conn, id)?;
        if !repository::delete_by_id(conn, id)? {
            return Err(AppError::internal(format!("分卷删除失败（ID: {id}）")));
        }

        logger::info(
            "分卷已删除",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("detachedChapters", serde_json::json!(detached_chapters)),
            ]),
        );

        Ok(VolumeRemovalResult {
            id,
            detached_chapters,
        })
    })
}

pub fn reorder(conn: &Connection, input: &VolumeReorderInput) -> AppResult<VolumeReorderResult> {
    in_transaction(conn, |conn| {
        book_service::assert_book_exists(conn, input.book_id)?;

        let total = repository::count_by_book(conn, input.book_id)?;

        // 必须提交完整顺序：只提交一部分会让没提交的卷保留下标，
        // 于是出现重复的 order_index，排序结果取决于 SQLite 的返回顺序而变得随机。
        if input.ordered_ids.len() as i64 != total {
            return Err(AppError::validation("分卷顺序提交不完整，请刷新页面后重试"));
        }

        if repository::count_matching(conn, input.book_id, &input.ordered_ids)? != total {
            return Err(AppError::validation("提交的分卷与本书不匹配，请刷新页面后重试"));
        }

        let changed = repository::reorder(conn, input.book_id, &input.ordered_ids, &now_iso())?;
        logger::info(
            "分卷顺序已更新",
            logger::fields(vec![
                ("bookId", serde_json::json!(input.book_id)),
                ("changed", serde_json::json!(changed)),
            ]),
        );

        Ok(VolumeReorderResult {
            book_id: input.book_id,
        })
    })
}

fn to_list_item(conn: &Connection, volume_id: i64) -> AppResult<VolumeListItem> {
    repository::find_list_item_by_id(conn, volume_id)?
        .ok_or_else(|| AppError::internal(format!("分卷写入后无法回读（ID: {volume_id}）")))
}
