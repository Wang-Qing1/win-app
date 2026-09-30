//! 章节历史版本的存取。
//!
//! 与 `repository.rs` 分开放：两者读写的是两张不同的表、各有一套查询形状，
//! 而「版本」这一侧只有三个动作（写一版、列一页、读一版）外加一个剪枝。
//!
//! 这里**不含事务**：留快照、剪枝、回档三件事都必须与「写正文」在同一个
//! 事务里，否则会出现「正文已经改了但快照没留」或反过来的半成品状态。
//! 事务由服务层统一开。

use rusqlite::{Connection, Row};

use crate::core::errors::{AppError, AppResult};
use crate::db::sql_utils::to_number;

use super::models::{ChapterRevision, ChapterRevisionSummary};

const REVISION_COLUMNS: &str = "id,
                chapter_id   AS chapter_id,
                content_html AS content_html,
                content_text AS content_text,
                hanzi_count  AS hanzi_count,
                char_count   AS char_count,
                created_at   AS created_at";

fn read_revision(row: &Row<'_>) -> rusqlite::Result<ChapterRevision> {
    Ok(ChapterRevision {
        id: row.get("id")?,
        chapter_id: row.get("chapter_id")?,
        hanzi_count: row.get("hanzi_count")?,
        // 详情页只看这一版本身，不显示增减；delta 只在列表里有意义
        delta_hanzi: None,
        created_at: row.get("created_at")?,
        content_html: row.get("content_html")?,
        content_text: row.get("content_text")?,
        char_count: to_number(row.get::<_, Option<i64>>("char_count")?),
    })
}

/// 列某一章的版本，最新在前。
///
/// `delta_hanzi`（相对前一版增减）**不落库** —— 它由「本版与时间上更早的那一版」
/// 相减得到，是纯派生值。存起来反而会引入「剪枝删掉中间某版后，存下来的
/// delta 全部失真」这类问题；用窗口函数现算，剪枝之后自动就是对的。
pub fn list_by_chapter(
    conn: &Connection,
    chapter_id: i64,
) -> AppResult<Vec<ChapterRevisionSummary>> {
    let mut statement = conn.prepare(
        "SELECT id,
                chapter_id  AS chapter_id,
                hanzi_count AS hanzi_count,
                created_at  AS created_at,
                LEAD(hanzi_count) OVER (ORDER BY created_at DESC, id DESC) AS earlier_hanzi
           FROM chapter_revisions
          WHERE chapter_id = ?
          ORDER BY created_at DESC, id DESC",
    )?;

    let rows = statement.query_map([chapter_id], |row| {
        let hanzi_count: i64 = row.get("hanzi_count")?;
        let earlier: Option<i64> = row.get("earlier_hanzi")?;
        Ok(ChapterRevisionSummary {
            id: row.get("id")?,
            chapter_id: row.get("chapter_id")?,
            hanzi_count,
            // None 表示这是最早的一版，前面没有可比对象
            delta_hanzi: earlier.map(|value| hanzi_count - value),
            created_at: row.get("created_at")?,
        })
    })?;

    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 读一版完整内容。返回 None 表示这版已被剪枝或本就属于别的章节。
pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<ChapterRevision>> {
    let sql = format!("SELECT {REVISION_COLUMNS} FROM chapter_revisions WHERE id = ?");
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query_map([id], read_revision)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 写一版快照。返回新版本的 id。
#[allow(clippy::too_many_arguments)]
pub fn insert_snapshot(
    conn: &Connection,
    chapter_id: i64,
    content_html: &str,
    content_text: &str,
    hanzi_count: i64,
    char_count: i64,
    created_at: &str,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO chapter_revisions
           (chapter_id, content_html, content_text, hanzi_count, char_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            chapter_id,
            content_html,
            content_text,
            hanzi_count,
            char_count,
            created_at
        ],
    )
    .map_err(|error| AppError::from(error))?;

    Ok(conn.last_insert_rowid())
}

/// 剪枝：只留最新 `keep` 版。
///
/// 用 `id NOT IN (最新的 keep 个)` 而不是「按 created_at 排序删旧的」——
/// 同一秒内可能落两版（自动保存与手动保存撞在一起），此时 `created_at`
/// 无法分出先后，而 `id` 是单调的，永远能分出。排序键与 `list_by_chapter`
/// 一致（`created_at DESC, id DESC`），两边对「哪几版是新的」判断相同。
pub fn prune(conn: &Connection, chapter_id: i64, keep: i64) -> AppResult<i64> {
    let changed = conn.execute(
        "DELETE FROM chapter_revisions
          WHERE chapter_id = ?
            AND id NOT IN (
                  SELECT id FROM chapter_revisions
                   WHERE chapter_id = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT ?
                )",
        rusqlite::params![chapter_id, chapter_id, keep],
    )?;
    Ok(changed as i64)
}
