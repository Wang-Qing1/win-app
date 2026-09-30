//! 书籍服务：承载业务规则与事务边界。
//!
//! 刻意不认识任何 Tauri / WebView 类型 —— 只吃 `&Connection`。
//! 于是同一个函数既能在命令层被调用，也能在单测（或将来可能的 CLI）里
//! 直接调用，而「同名书不能建」这类规则永远只有一份实现。

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::time::now_iso;
use crate::db::in_transaction;

use super::models::{
    Book, BookCreateInput, BookListQuery, BookListResult, BookRemovalResult, BookStats,
    BookUpdateInput,
};
use super::repository;

pub fn list(conn: &Connection, query: &BookListQuery) -> AppResult<BookListResult> {
    repository::list(conn, query)
}

pub fn get_by_id(conn: &Connection, id: i64) -> AppResult<Book> {
    repository::find_by_id(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("书籍不存在（ID: {id}）")))
}

pub fn create(conn: &Connection, input: &BookCreateInput) -> AppResult<Book> {
    in_transaction(conn, |conn| {
        if repository::find_by_title(conn, &input.title, None)?.is_some() {
            return Err(AppError::conflict(format!(
                "已存在同名书籍「{}」，请换一个书名",
                input.title
            )));
        }

        let created = repository::insert(
            conn,
            &input.title,
            &input.pen_name,
            &input.genre,
            &input.status,
            &input.summary,
            input.target_words,
            input.chapter_words,
            &input.accent_color,
            &now_iso(),
        )?;

        logger::info(
            "书籍已创建",
            logger::fields(vec![("id", serde_json::json!(created.id))]),
        );
        Ok(created)
    })
}

pub fn update(conn: &Connection, input: &BookUpdateInput) -> AppResult<Book> {
    in_transaction(conn, |conn| {
        if !repository::exists(conn, input.id)? {
            return Err(AppError::not_found(format!("书籍不存在（ID: {}）", input.id)));
        }

        if repository::find_by_title(conn, &input.title, Some(input.id))?.is_some() {
            return Err(AppError::conflict(format!(
                "已存在同名书籍「{}」，请换一个书名",
                input.title
            )));
        }

        let updated = repository::update(
            conn,
            input.id,
            &input.title,
            &input.pen_name,
            &input.genre,
            &input.status,
            &input.summary,
            input.target_words,
            input.chapter_words,
            &input.accent_color,
            &now_iso(),
        )?
        .ok_or_else(|| AppError::internal(format!("书籍更新失败（ID: {}）", input.id)))?;

        logger::info(
            "书籍已更新",
            logger::fields(vec![("id", serde_json::json!(updated.id))]),
        );
        Ok(updated)
    })
}

pub fn remove(conn: &Connection, id: i64) -> AppResult<BookRemovalResult> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("书籍不存在（ID: {id}）")))?;

        // 先数一遍将要连带删除的章节数，删完就查不到了。
        // 这个数字会出现在确认提示里 ——「删掉一本书」和「删掉一本书的 128 章」
        // 是完全不同量级的操作，用户有权在动手前看到。
        //
        // 只数还活着的章节：回收站里的章节同样会被级联删掉，但那个数字
        // 不该混进这句提示 —— 提示说的是「你将失去这本书的多少内容」，
        // 而回收站里的东西作者已经表达过一次「我不要它了」。
        let removed_chapters = repository::count_live_chapters(conn, id)?;

        if !repository::delete_by_id(conn, id)? {
            return Err(AppError::internal(format!("书籍删除失败（ID: {id}）")));
        }

        // 不记录书名：日志里只留 id，避免把用户的创作内容写进日志文件
        logger::info(
            "书籍已删除",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("removedChapters", serde_json::json!(removed_chapters)),
            ]),
        );

        Ok(BookRemovalResult {
            id,
            title: existing.title,
            removed_chapters,
        })
    })
}

pub fn stats(conn: &Connection) -> AppResult<BookStats> {
    repository::stats(conn)
}

/* ------------------------------------------------------------------ *
 * 供其它模块复用的规则（跨模块只用这几个，不开第二份查询路径）
 * ------------------------------------------------------------------ */

/// 校验书籍存在。分卷、章节、卡片、大纲都要用它 ——
/// 各自写一遍 `SELECT 1 FROM books` 就会出现四份口径，
/// 其中一份忘了带某个条件时很难发现。
pub fn assert_book_exists(conn: &Connection, book_id: i64) -> AppResult<()> {
    if repository::exists(conn, book_id)? {
        Ok(())
    } else {
        Err(AppError::not_found(format!("书籍不存在（ID: {book_id}）")))
    }
}

/// 章节保存后碰一下书籍的 `updated_at`，让书架排序反映「最近在写哪本」。
pub fn touch_book(conn: &Connection, book_id: i64) -> AppResult<()> {
    repository::touch(conn, book_id, &now_iso())
}
