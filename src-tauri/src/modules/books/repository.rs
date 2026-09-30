//! 书籍仓储（对应 TS 侧 `book.repository.ts`）。
//!
//! 只负责 SQL 与行↔领域对象映射，不含任何业务判断。判断都在 `service.rs`，
//! 于是「同名书不能建」「删书要先数章节」这类规则只有一份实现。

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, Row};

use crate::core::errors::{AppError, AppResult};
use crate::db::sql_utils::{contains_pattern, to_number};

use super::models::{
    is_valid_status, Book, BookListQuery, BookListItem, BookListResult, BookStats, BOOK_STATUSES,
};

/// 排序列白名单。
/// 客户端传来的 sortBy 已在边界归一化，这里再映射成真实列名 ——
/// 从不把客户端字符串拼进 SQL。
/// hanziCount 是聚合出来的别名，SQLite 允许在 ORDER BY 里引用它。
fn sort_column(sort_by: &str) -> &'static str {
    match sort_by {
        "title" => "b.title COLLATE NOCASE",
        "createdAt" => "b.created_at",
        "hanziCount" => "hanzi_count",
        _ => "b.updated_at",
    }
}

/// 列表用的聚合子查询。
///
/// 刻意用两个独立子查询而不是 `LEFT JOIN chapters ... LEFT JOIN volumes ...`：
/// 两个一对多关联同时 JOIN 会产生笛卡尔积，章节会被按分卷数重复累加，
/// `SUM(hanzi_count)` 于是虚高 —— 而且分卷越多错得越离谱，很难第一时间发现。
/// 各自先聚合再关联，从根上避免这个问题。
///
/// 章节那一侧只数 `deleted_at IS NULL` 的：书架上的进度条、章节数、
/// 「最后编辑」都应当反映这本书**现在**有多少内容。把回收站里的章节也算进去的话，
/// 删掉一章进度条纹丝不动 —— 用户会以为删除没生效，然后反复删。
const AGGREGATE_JOINS: &str = "
  LEFT JOIN (
    SELECT book_id, COUNT(*) AS volume_count
      FROM volumes
     GROUP BY book_id
  ) v ON v.book_id = b.id
  LEFT JOIN (
    SELECT book_id,
           COUNT(*)          AS chapter_count,
           SUM(hanzi_count)  AS hanzi_count,
           MAX(updated_at)   AS last_edited_at
      FROM chapters
     WHERE deleted_at IS NULL
     GROUP BY book_id
  ) c ON c.book_id = b.id
";

const BOOK_COLUMNS: &str = "b.id, b.title, b.pen_name, b.genre, b.status, b.summary,
        b.target_words, b.chapter_words, b.accent_color, b.created_at, b.updated_at";

/// 从行里读出书籍本体。
///
/// `status` 读出来时收敛到值域内 —— 理论上不可能越界（写入侧有校验），
/// 但真出现脏数据时不该让前端崩掉，退回 `idea` 是安全的降级。
fn read_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    let raw_status: String = row.get("status")?;
    Ok(Book {
        id: row.get("id")?,
        title: row.get("title")?,
        pen_name: row.get("pen_name")?,
        genre: row.get("genre")?,
        status: if is_valid_status(&raw_status) {
            raw_status
        } else {
            "idea".to_string()
        },
        summary: row.get("summary")?,
        target_words: row.get("target_words")?,
        chapter_words: row.get("chapter_words")?,
        accent_color: row.get("accent_color")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_list_item(row: &Row<'_>) -> rusqlite::Result<BookListItem> {
    let book = read_book(row)?;
    Ok(BookListItem {
        id: book.id,
        title: book.title,
        pen_name: book.pen_name,
        genre: book.genre,
        status: book.status,
        summary: book.summary,
        target_words: book.target_words,
        chapter_words: book.chapter_words,
        accent_color: book.accent_color,
        created_at: book.created_at,
        updated_at: book.updated_at,
        volume_count: to_number(row.get::<_, Option<i64>>("volume_count")?),
        chapter_count: to_number(row.get::<_, Option<i64>>("chapter_count")?),
        hanzi_count: to_number(row.get::<_, Option<i64>>("hanzi_count")?),
        last_edited_at: row.get("last_edited_at")?,
    })
}

pub fn list(conn: &Connection, query: &BookListQuery) -> AppResult<BookListResult> {
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if !query.keyword.is_empty() {
        // 书名、笔名、题材都参与搜索 —— 写了几十本之后，靠记忆找书名的成本很高
        conditions.push(
            "(b.title LIKE ? ESCAPE '\\' OR b.pen_name LIKE ? ESCAPE '\\' OR b.genre LIKE ? ESCAPE '\\')",
        );
        let pattern = contains_pattern(&query.keyword);
        for _ in 0..3 {
            params.push(Value::Text(pattern.clone()));
        }
    }

    if let Some(status) = &query.status {
        conditions.push("b.status = ?");
        params.push(Value::Text(status.clone()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let total = to_number(conn.query_row(
        &format!("SELECT COUNT(*) AS total FROM books b {where_clause}"),
        params_from_iter(params.iter()),
        |row| row.get::<_, Option<i64>>(0),
    )?);

    // 页码越界时**夹到最后一页**而不是报错：用户删掉若干本书之后，
    // 浏览器里那条 ?page=5 的链接不应该变成一个空白错误页。
    let page_count = if total == 0 {
        0
    } else {
        (total + query.page_size - 1) / query.page_size
    };
    let safe_page = if page_count == 0 {
        1
    } else {
        query.page.min(page_count)
    };
    let offset = (safe_page - 1) * query.page_size;

    let direction = if query.sort_order == "asc" { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT {BOOK_COLUMNS},
                COALESCE(v.volume_count, 0)  AS volume_count,
                COALESCE(c.chapter_count, 0) AS chapter_count,
                COALESCE(c.hanzi_count, 0)   AS hanzi_count,
                c.last_edited_at
           FROM books b
           {AGGREGATE_JOINS}
           {where_clause}
          ORDER BY {} {direction}, b.id DESC
          LIMIT ? OFFSET ?",
        sort_column(&query.sort_by)
    );

    let mut list_params = params.clone();
    list_params.push(Value::Integer(query.page_size));
    list_params.push(Value::Integer(offset));

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(list_params.iter()), read_list_item)?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;

    Ok(BookListResult {
        items,
        total,
        page: safe_page,
        page_size: query.page_size,
        page_count,
    })
}

pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<Book>> {
    let mut statement = conn.prepare("SELECT * FROM books WHERE id = ?")?;
    let mut rows = statement.query_map([id], read_book)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 业务唯一性校验用：同名（不区分大小写）即视为重复，可排除自身。
pub fn find_by_title(conn: &Connection, title: &str, exclude_id: Option<i64>) -> AppResult<Option<Book>> {
    let (sql, params): (&str, Vec<Value>) = match exclude_id {
        None => (
            "SELECT * FROM books WHERE title = ? COLLATE NOCASE LIMIT 1",
            vec![Value::Text(title.to_string())],
        ),
        Some(id) => (
            "SELECT * FROM books WHERE title = ? COLLATE NOCASE AND id <> ? LIMIT 1",
            vec![Value::Text(title.to_string()), Value::Integer(id)],
        ),
    };

    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query_map(params_from_iter(params.iter()), read_book)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn exists(conn: &Connection, id: i64) -> AppResult<bool> {
    let found = conn.query_row("SELECT 1 AS ok FROM books WHERE id = ?", [id], |row| {
        row.get::<_, i64>(0)
    });
    match found {
        Ok(value) => Ok(value == 1),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    title: &str,
    pen_name: &str,
    genre: &str,
    status: &str,
    summary: &str,
    target_words: i64,
    chapter_words: i64,
    accent_color: &str,
    now: &str,
) -> AppResult<Book> {
    conn.execute(
        "INSERT INTO books (title, pen_name, genre, status, summary, target_words, chapter_words, accent_color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            title,
            pen_name,
            genre,
            status,
            summary,
            target_words,
            chapter_words,
            accent_color,
            now,
            now
        ],
    )?;

    let id = conn.last_insert_rowid();
    find_by_id(conn, id)?.ok_or_else(|| AppError::internal("新增书籍后无法回读记录"))
}

#[allow(clippy::too_many_arguments)]
pub fn update(
    conn: &Connection,
    id: i64,
    title: &str,
    pen_name: &str,
    genre: &str,
    status: &str,
    summary: &str,
    target_words: i64,
    chapter_words: i64,
    accent_color: &str,
    now: &str,
) -> AppResult<Option<Book>> {
    let changed = conn.execute(
        "UPDATE books
            SET title = ?, pen_name = ?, genre = ?, status = ?, summary = ?,
                target_words = ?, chapter_words = ?, accent_color = ?, updated_at = ?
          WHERE id = ?",
        rusqlite::params![
            title,
            pen_name,
            genre,
            status,
            summary,
            target_words,
            chapter_words,
            accent_color,
            now,
            id
        ],
    )?;

    if changed == 0 {
        return Ok(None);
    }
    find_by_id(conn, id)
}

/// 只更新 `updated_at`（「碰一下」）。
///
/// 章节保存后必须调用它：书籍列表默认按 `updated_at` 排序，
/// 如果不碰，用户写了三万字但书的排序位置还停在创建那一刻。
///
/// `AND updated_at < ?` 保证时间只前进不后退 —— 否则一次时钟回拨
/// 会把这本书沉到书架底下。
pub fn touch(conn: &Connection, id: i64, now: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE books SET updated_at = ? WHERE id = ? AND updated_at < ?",
        rusqlite::params![now, id, now],
    )?;
    Ok(())
}

pub fn delete_by_id(conn: &Connection, id: i64) -> AppResult<bool> {
    // 外键已开启且都带 ON DELETE CASCADE，
    // 删书会连带删掉它的分卷、章节、大纲节点与卡片（书写记录会保留，见迁移注释）
    let changed = conn.execute("DELETE FROM books WHERE id = ?", [id])?;
    Ok(changed > 0)
}

pub fn count_all(conn: &Connection) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS total FROM books",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn count_by_status(conn: &Connection, status: &str) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM books WHERE status = ?",
        [status],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 在写书籍的目标字数之和。
///
/// 首页进度用的是「已写字数 / 在写目标」，而不是「已写字数 / 全部书籍目标之和」——
/// 后者会把构思阶段的空目标、以及已完结的书的目标也算进分母，
/// 于是完成度永远偏低，看起来像是一直没进展。
pub fn sum_target_words_by_status(conn: &Connection, status: &str) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COALESCE(SUM(target_words), 0) AS n FROM books WHERE status = ?",
        [status],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 最近编辑过的前 N 本，供首页「在写书籍」列表。
pub fn list_recent(conn: &Connection, limit: i64) -> AppResult<Vec<Book>> {
    let mut statement =
        conn.prepare("SELECT * FROM books ORDER BY updated_at DESC LIMIT ?")?;
    let rows = statement.query_map([limit], read_book)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 删书前数一遍「会连带删掉多少章」。
///
/// 抽成仓储方法而不是让服务层自己写 SQL：`deleted_at IS NULL` 这条口径
/// 全库只有一处定义，服务层只负责把它放进提示文案里。
pub fn count_live_chapters(conn: &Connection, book_id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM chapters WHERE book_id = ? AND deleted_at IS NULL",
        [book_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn stats(conn: &Connection) -> AppResult<BookStats> {
    let total = count_all(conn)?;

    // 四个状态键先全部铺 0 再覆盖：前端直接读 byStatus.idea，
    // 缺键会渲染成 undefined 而不是 0
    let mut by_status: std::collections::BTreeMap<String, i64> =
        BOOK_STATUSES.iter().map(|s| (s.to_string(), 0)).collect();

    let mut statement = conn.prepare("SELECT status, COUNT(*) AS n FROM books GROUP BY status")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>("status")?, row.get::<_, Option<i64>>("n")?))
    })?;
    for row in rows {
        let (status, count) = row?;
        if is_valid_status(&status) {
            by_status.insert(status, to_number(count));
        }
    }

    let (chapter_count, hanzi_count, char_count) = conn.query_row(
        "SELECT COUNT(*) AS chapter_count,
                COALESCE(SUM(hanzi_count), 0) AS hanzi_count,
                COALESCE(SUM(char_count), 0) AS char_count
           FROM chapters
          WHERE deleted_at IS NULL",
        [],
        |row| {
            Ok((
                row.get::<_, Option<i64>>("chapter_count")?,
                row.get::<_, Option<i64>>("hanzi_count")?,
                row.get::<_, Option<i64>>("char_count")?,
            ))
        },
    )?;

    let volume_count = to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM volumes",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )?);

    let total_target_words = to_number(conn.query_row(
        "SELECT COALESCE(SUM(target_words), 0) AS n FROM books",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )?);

    Ok(BookStats {
        total,
        by_status,
        chapter_count: to_number(chapter_count),
        volume_count,
        hanzi_count: to_number(hanzi_count),
        char_count: to_number(char_count),
        total_target_words,
    })
}
