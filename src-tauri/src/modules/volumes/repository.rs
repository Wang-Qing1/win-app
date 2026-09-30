//! 分卷仓储（对应 TS 侧 `volume.repository.ts`）。

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, Row};

use crate::core::errors::{AppError, AppResult};
use crate::db::sql_utils::to_number;

use super::models::{Volume, VolumeListItem};

/// 分卷的聚合子查询。
///
/// 只统计 `volume_id` 不为空的章节 —— 未分卷的章节不属于任何卷，
/// 若把它们也卷进来，每个卷的章节数都会多出同一批数字。
///
/// 同时只数还活着的章节（`deleted_at IS NULL`）：卷上的「N 章 / M 字」
/// 是给作者看进度的，把回收站里的算进去会让删掉一章之后数字不动。
const AGGREGATE_JOIN: &str = "
  LEFT JOIN (
    SELECT volume_id,
           COUNT(*)         AS chapter_count,
           SUM(hanzi_count) AS hanzi_count
      FROM chapters
     WHERE volume_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY volume_id
  ) c ON c.volume_id = v.id
";

const LIST_COLUMNS: &str = "v.id, v.book_id, v.title, v.summary, v.order_index, v.created_at, v.updated_at,
        COALESCE(c.chapter_count, 0) AS chapter_count,
        COALESCE(c.hanzi_count, 0)   AS hanzi_count";

fn read_volume(row: &Row<'_>) -> rusqlite::Result<Volume> {
    Ok(Volume {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        title: row.get("title")?,
        summary: row.get("summary")?,
        order_index: row.get("order_index")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_list_item(row: &Row<'_>) -> rusqlite::Result<VolumeListItem> {
    let volume = read_volume(row)?;
    Ok(VolumeListItem {
        id: volume.id,
        book_id: volume.book_id,
        title: volume.title,
        summary: volume.summary,
        order_index: volume.order_index,
        created_at: volume.created_at,
        updated_at: volume.updated_at,
        chapter_count: to_number(row.get::<_, Option<i64>>("chapter_count")?),
        hanzi_count: to_number(row.get::<_, Option<i64>>("hanzi_count")?),
    })
}

pub fn list_by_book(conn: &Connection, book_id: i64) -> AppResult<Vec<VolumeListItem>> {
    let sql = format!(
        "SELECT {LIST_COLUMNS}
           FROM volumes v
           {AGGREGATE_JOIN}
          WHERE v.book_id = ?
          ORDER BY v.order_index ASC, v.id ASC"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([book_id], read_list_item)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<Volume>> {
    let mut statement = conn.prepare("SELECT * FROM volumes WHERE id = ?")?;
    let mut rows = statement.query_map([id], read_volume)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 按 id 取带聚合的列表项。
///
/// 创建/更新后需要回读聚合字段（章节数、字数）来保证返回类型与列表一致。
/// 单条查询而不是「取整本书的分卷再 find」：书的卷数可能有几十个，
/// 每次写操作都全量拉一遍是没必要的小浪费。
pub fn find_list_item_by_id(conn: &Connection, id: i64) -> AppResult<Option<VolumeListItem>> {
    let sql = format!(
        "SELECT {LIST_COLUMNS}
           FROM volumes v
           {AGGREGATE_JOIN}
          WHERE v.id = ?"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query_map([id], read_list_item)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 书名之内唯一即可：不同书里各有一个「第一卷」是正常的。
pub fn find_by_title(
    conn: &Connection,
    book_id: i64,
    title: &str,
    exclude_id: Option<i64>,
) -> AppResult<Option<Volume>> {
    let (sql, params): (&str, Vec<Value>) = match exclude_id {
        None => (
            "SELECT * FROM volumes WHERE book_id = ? AND title = ? COLLATE NOCASE LIMIT 1",
            vec![Value::Integer(book_id), Value::Text(title.to_string())],
        ),
        Some(id) => (
            "SELECT * FROM volumes WHERE book_id = ? AND title = ? COLLATE NOCASE AND id <> ? LIMIT 1",
            vec![
                Value::Integer(book_id),
                Value::Text(title.to_string()),
                Value::Integer(id),
            ],
        ),
    };

    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query_map(params_from_iter(params.iter()), read_volume)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn count_by_book(conn: &Connection, book_id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM volumes WHERE book_id = ?",
        [book_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 追加到末尾时用。`COALESCE` 保证空表时从 0 开始。
pub fn next_order_index(conn: &Connection, book_id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COALESCE(MAX(order_index) + 1, 0) AS n FROM volumes WHERE book_id = ?",
        [book_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn insert(
    conn: &Connection,
    book_id: i64,
    title: &str,
    summary: &str,
    order_index: i64,
    now: &str,
) -> AppResult<Volume> {
    conn.execute(
        "INSERT INTO volumes (book_id, title, summary, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![book_id, title, summary, order_index, now, now],
    )?;

    let id = conn.last_insert_rowid();
    find_by_id(conn, id)?.ok_or_else(|| AppError::internal("新增分卷后无法回读记录"))
}

pub fn update(
    conn: &Connection,
    id: i64,
    title: &str,
    summary: &str,
    now: &str,
) -> AppResult<Option<Volume>> {
    let changed = conn.execute(
        "UPDATE volumes SET title = ?, summary = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![title, summary, now, id],
    )?;

    if changed == 0 {
        return Ok(None);
    }
    find_by_id(conn, id)
}

/// 卷下章节数：删除前用它算「这些章节会退回未分卷」的提示文案。
///
/// 只数活着的：回收站里的章节确实也会被 `SET NULL` 成未分卷，但它们
/// 本来就不在作者的工作视野里，把它们的数量报进这句提示只会让人
/// 以为「我要删掉 3 章」，而界面上只看得到 1 章。
pub fn count_chapters(conn: &Connection, volume_id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM chapters WHERE volume_id = ? AND deleted_at IS NULL",
        [volume_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn delete_by_id(conn: &Connection, id: i64) -> AppResult<bool> {
    // chapters.volume_id 是 ON DELETE SET NULL：卷下的章节会退回「未分卷」，
    // 而不是跟着卷一起消失。删一个容器不该毁掉里面的内容。
    let changed = conn.execute("DELETE FROM volumes WHERE id = ?", [id])?;
    Ok(changed > 0)
}

/// 重排：按传入顺序重写 `order_index`。
///
/// 只对确实属于这本书、且出现在 `ordered_ids` 里的卷生效。
/// 调用方（服务层）已经校验过完整性，这里再做一次归属过滤是纵深防御：
/// 万一将来有人绕过服务层直接调仓储，也不会把别的书的卷顺序改掉。
pub fn reorder(
    conn: &Connection,
    book_id: i64,
    ordered_ids: &[i64],
    now: &str,
) -> AppResult<i64> {
    let mut statement = conn.prepare(
        "UPDATE volumes SET order_index = ?, updated_at = ? WHERE id = ? AND book_id = ?",
    )?;

    let mut changed = 0i64;
    for (index, id) in ordered_ids.iter().enumerate() {
        changed += statement.execute(rusqlite::params![index as i64, now, id, book_id])? as i64;
    }
    Ok(changed)
}

/// 校验一批 id 是否全部属于指定书，用于重排前的一致性检查。
pub fn count_matching(conn: &Connection, book_id: i64, ids: &[i64]) -> AppResult<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!("SELECT COUNT(*) AS n FROM volumes WHERE book_id = ? AND id IN ({placeholders})");

    let mut params: Vec<Value> = Vec::with_capacity(ids.len() + 1);
    params.push(Value::Integer(book_id));
    params.extend(ids.iter().map(|id| Value::Integer(*id)));

    Ok(to_number(conn.query_row(
        &sql,
        params_from_iter(params.iter()),
        |row| row.get::<_, Option<i64>>(0),
    )?))
}
