//! 写作会话服务（对应 TS 侧 `session.service.ts`）。
//!
//! 会话由渲染进程在编辑器里采集（进入编辑 → 空闲 90 秒或离开），结算后通过
//! 一次 IPC 调用落库。服务层在这里做的是「让这条记录尽量能存下来」，
//! 而不是严格拒绝 —— 写作时长是既成事实，不该因为用户刚好删掉了那本书就丢失。

use rusqlite::Connection;

use crate::core::errors::AppResult;
use crate::core::logger;
use crate::db::in_transaction;
use crate::modules::books::repository as book_repository;
use crate::modules::chapters::repository as chapter_repository;

use super::models::{SessionFinishInput, SessionListQuery, WritingSession};
use super::repository;

/// 结算一次写作会话。
pub fn finish(conn: &Connection, input: &SessionFinishInput) -> AppResult<WritingSession> {
    in_transaction(conn, |conn| {
        // 归属对象可能在会话进行期间被删除（用户写着写着把书删了）。
        // 这种情况下把外键置空而不是抛错：外键约束会直接拒绝插入，
        // 于是整段写作时长凭空消失，而这恰恰是统计模块最不该丢的数据。
        let book_id = match input.book_id {
            Some(id) if book_repository::exists(conn, id)? => Some(id),
            _ => None,
        };
        let chapter_id = match input.chapter_id {
            Some(id) if chapter_repository::exists(conn, id)? => Some(id),
            _ => None,
        };

        if book_id != input.book_id || chapter_id != input.chapter_id {
            logger::warn(
                "写作会话的归属对象已不存在，已置空后保存",
                logger::fields(vec![
                    ("bookId", serde_json::json!(input.book_id)),
                    ("chapterId", serde_json::json!(input.chapter_id)),
                ]),
            );
        }

        let session = repository::insert(
            conn,
            &SessionFinishInput {
                book_id,
                chapter_id,
                ..input.clone()
            },
        )?;

        logger::debug(
            "写作会话已结算",
            logger::fields(vec![
                ("id", serde_json::json!(session.id)),
                ("durationSeconds", serde_json::json!(session.duration_seconds)),
                ("wordsWritten", serde_json::json!(session.words_written)),
                ("wordsNet", serde_json::json!(session.words_net)),
            ]),
        );

        Ok(session)
    })
}

pub fn list(conn: &Connection, query: &SessionListQuery) -> AppResult<Vec<WritingSession>> {
    repository::list(conn, query)
}
