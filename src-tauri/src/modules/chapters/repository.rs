//! 章节仓储（对应 TS 侧 `chapter.repository.ts`）。
//!
//! 这是全应用最大的一张表，SQL 也最密。两条贯穿全文的口径：
//!   - 默认只看**活着的**章节（`deleted_at IS NULL`）；
//!   - 「容器」（分卷 / 未分卷区间）的定义只有一处（`container_condition`），
//!     列章节、数数量、取 id 序列、算下一个下标全走它。

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, Row};

use crate::core::errors::{AppError, AppResult};
use crate::db::sql_utils::to_number;

use super::models::{
    is_valid_status, Chapter, ChapterListItem, ChapterListQuery, ChapterReorderInput,
    ChapterSaveContentInput, ChapterUpdateInput, DeletedChapterRow,
};

/// 列表查询的列清单。
///
/// 刻意不含 `content_html` / `content_text`：一本书的正文可能有几十上百万字，
/// 列表接口若顺手把正文一起 select 出来，序列化过 IPC 的开销会随书本规模
/// 线性增长，而列表页一个字的正文都不需要。正文只在 `chapters:get` 里按需取。
const LIST_COLUMNS: &str = "
  c.id, c.book_id, c.volume_id, c.title, c.status, c.order_index,
  c.hanzi_count, c.char_count, c.target_words, c.created_at, c.updated_at
";

fn read_list_item(row: &Row<'_>) -> rusqlite::Result<ChapterListItem> {
    let raw_status: String = row.get("status")?;
    Ok(ChapterListItem {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        volume_id: row.get("volume_id")?,
        title: row.get("title")?,
        status: if is_valid_status(&raw_status) {
            raw_status
        } else {
            "draft".to_string()
        },
        order_index: row.get("order_index")?,
        hanzi_count: to_number(row.get::<_, Option<i64>>("hanzi_count")?),
        char_count: to_number(row.get::<_, Option<i64>>("char_count")?),
        target_words: to_number(row.get::<_, Option<i64>>("target_words")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn read_chapter(row: &Row<'_>) -> rusqlite::Result<Chapter> {
    let item = read_list_item(row)?;
    Ok(Chapter {
        id: item.id,
        book_id: item.book_id,
        volume_id: item.volume_id,
        title: item.title,
        status: item.status,
        order_index: item.order_index,
        hanzi_count: item.hanzi_count,
        char_count: item.char_count,
        target_words: item.target_words,
        created_at: item.created_at,
        updated_at: item.updated_at,
        content_html: row.get("content_html")?,
        content_text: row.get("content_text")?,
    })
}

/// 容器条件。
///
/// `volume_id` 为 None 时必须用 `IS NULL` 而不是 `= NULL` —— 后者在 SQL 里
/// 永远不成立，症状是「未分卷的章节列表永远是空的」，而且不会报任何错。
///
/// **顺带带上「没进回收站」这一条**：走这个条件的四处（列章节、列带正文的
/// 章节、数容器内章节数、取容器内 id 序列、取下一个 order_index）都必须
/// 只看活着的章节。放在这里而不是各调用点，是因为「容器里有哪些章节」
/// 只有这一个定义 —— 少写一处的症状极隐蔽：比如 `count_in_container`
/// 漏掉时，重排会因为「提交的 id 数比容器里的少」而被判成「顺序提交不完整」，
/// 而用户只是刚删了一章。
fn container_condition(volume_id: Option<i64>) -> (String, Vec<Value>) {
    match volume_id {
        None => (
            "c.book_id = ? AND c.volume_id IS NULL AND c.deleted_at IS NULL".to_string(),
            Vec::new(),
        ),
        Some(id) => (
            "c.book_id = ? AND c.volume_id = ? AND c.deleted_at IS NULL".to_string(),
            vec![Value::Integer(id)],
        ),
    }
}

/// 整本书的章节，或某个容器（分卷 / 未分卷区间）内的章节。
pub fn list(conn: &Connection, query: &ChapterListQuery) -> AppResult<Vec<ChapterListItem>> {
    let mut params: Vec<Value> = vec![Value::Integer(query.book_id)];
    let sql = match query.volume_id {
        None => format!(
            "SELECT {LIST_COLUMNS} FROM chapters c
              WHERE c.book_id = ? AND c.deleted_at IS NULL
              ORDER BY c.volume_id IS NULL, c.volume_id ASC, c.order_index ASC, c.id ASC"
        ),
        Some(volume_id) => {
            let (condition, extra) = container_condition(volume_id);
            params.extend(extra);
            format!(
                "SELECT {LIST_COLUMNS} FROM chapters c
                  WHERE {condition}
                  ORDER BY c.order_index ASC, c.id ASC"
            )
        }
    };

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params.iter()), read_list_item)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 整本/整卷导出用：带正文的有序章节列表。
///
/// 与 [`list`] 用同一套查询条件与排序规则（只多选一列 `content_text`），
/// 是为了确保「列表页看到的顺序」与「导出文件里的顺序」永远一致 ——
/// 若各写一份，两边的排序逻辑日后只修了其中一份，导出出来的书会与
/// 章节列表页对不上。
pub fn list_with_content(
    conn: &Connection,
    query: &ChapterListQuery,
) -> AppResult<Vec<(ChapterListItem, String)>> {
    let mut params: Vec<Value> = vec![Value::Integer(query.book_id)];
    let sql = match query.volume_id {
        None => format!(
            "SELECT {LIST_COLUMNS}, c.content_text FROM chapters c
              WHERE c.book_id = ? AND c.deleted_at IS NULL
              ORDER BY c.volume_id IS NULL, c.volume_id ASC, c.order_index ASC, c.id ASC"
        ),
        Some(volume_id) => {
            let (condition, extra) = container_condition(volume_id);
            params.extend(extra);
            format!(
                "SELECT {LIST_COLUMNS}, c.content_text FROM chapters c
                  WHERE {condition}
                  ORDER BY c.order_index ASC, c.id ASC"
            )
        }
    };

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        Ok((read_list_item(row)?, row.get::<_, String>("content_text")?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 按 id 取**还在回收站外**的章节。
///
/// 不做成「带 includeDeleted 开关」的版本：调用方要么在编辑一章（必须活着），
/// 要么在处理回收站条目（必须已删），两个诉求各有一个语义明确的方法 ——
/// 开关式的接口只要有一处忘了传，就会出现「自动保存把正文写进了已被删掉的
/// 章节」这种情况，而且不报错。
pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<Chapter>> {
    let mut statement =
        conn.prepare("SELECT * FROM chapters WHERE id = ? AND deleted_at IS NULL")?;
    let mut rows = statement.query_map([id], read_chapter)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn find_list_item_by_id(conn: &Connection, id: i64) -> AppResult<Option<ChapterListItem>> {
    let sql = format!(
        "SELECT {LIST_COLUMNS} FROM chapters c WHERE c.id = ? AND c.deleted_at IS NULL"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query_map([id], read_list_item)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

const DELETED_SELECT: &str = "SELECT c.id AS id, c.title AS title, c.book_id AS book_id, c.volume_id AS volume_id,
                b.title AS book_title, v.title AS volume_title,
                c.deleted_at AS deleted_at, c.hanzi_count AS hanzi_count
           FROM chapters c
           LEFT JOIN books b   ON b.id = c.book_id
           LEFT JOIN volumes v ON v.id = c.volume_id";

fn read_deleted_row(row: &Row<'_>) -> rusqlite::Result<DeletedChapterRow> {
    Ok(DeletedChapterRow {
        id: row.get("id")?,
        title: row.get("title")?,
        book_id: row.get("book_id")?,
        volume_id: row.get("volume_id")?,
        book_title: row.get("book_title")?,
        volume_title: row.get("volume_title")?,
        deleted_at: row.get("deleted_at")?,
        hanzi_count: to_number(row.get::<_, Option<i64>>("hanzi_count")?),
    })
}

/// 按 id 取**回收站里**的章节。恢复与彻底删除的唯一入口。
pub fn find_deleted_by_id(conn: &Connection, id: i64) -> AppResult<Option<DeletedChapterRow>> {
    let sql = format!("{DELETED_SELECT} WHERE c.id = ? AND c.deleted_at IS NOT NULL");
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query_map([id], read_deleted_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn exists(conn: &Connection, id: i64) -> AppResult<bool> {
    let found = conn.query_row(
        "SELECT 1 AS ok FROM chapters WHERE id = ? AND deleted_at IS NULL",
        [id],
        |row| row.get::<_, i64>(0),
    );
    match found {
        Ok(value) => Ok(value == 1),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub fn count_by_book(conn: &Connection, book_id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM chapters WHERE book_id = ? AND deleted_at IS NULL",
        [book_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn count_in_container(
    conn: &Connection,
    book_id: i64,
    volume_id: Option<i64>,
) -> AppResult<i64> {
    let (condition, extra) = container_condition(volume_id);
    let mut params: Vec<Value> = vec![Value::Integer(book_id)];
    params.extend(extra);

    Ok(to_number(conn.query_row(
        &format!("SELECT COUNT(*) AS n FROM chapters c WHERE {condition}"),
        params_from_iter(params.iter()),
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 容器内的章节 id，按当前顺序。重排与移动都以它为基准。
pub fn list_ids_in_container(
    conn: &Connection,
    book_id: i64,
    volume_id: Option<i64>,
) -> AppResult<Vec<i64>> {
    let (condition, extra) = container_condition(volume_id);
    let mut params: Vec<Value> = vec![Value::Integer(book_id)];
    params.extend(extra);

    let mut statement = conn.prepare(&format!(
        "SELECT c.id FROM chapters c WHERE {condition} ORDER BY c.order_index ASC, c.id ASC"
    ))?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        row.get::<_, i64>("id")
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn next_order_index(
    conn: &Connection,
    book_id: i64,
    volume_id: Option<i64>,
) -> AppResult<i64> {
    let (condition, extra) = container_condition(volume_id);
    let mut params: Vec<Value> = vec![Value::Integer(book_id)];
    params.extend(extra);

    Ok(to_number(conn.query_row(
        &format!("SELECT COALESCE(MAX(c.order_index) + 1, 0) AS n FROM chapters c WHERE {condition}"),
        params_from_iter(params.iter()),
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn insert(
    conn: &Connection,
    book_id: i64,
    volume_id: Option<i64>,
    title: &str,
    target_words: i64,
    order_index: i64,
    now: &str,
) -> AppResult<ChapterListItem> {
    conn.execute(
        "INSERT INTO chapters (book_id, volume_id, title, content_html, content_text,
                               hanzi_count, char_count, target_words, status, order_index,
                               created_at, updated_at)
         VALUES (?, ?, ?, '', '', 0, 0, ?, 'draft', ?, ?, ?)",
        rusqlite::params![book_id, volume_id, title, target_words, order_index, now, now],
    )?;

    let id = conn.last_insert_rowid();
    find_list_item_by_id(conn, id)?.ok_or_else(|| AppError::internal("新增章节后无法回读记录"))
}

/// 元数据更新（标题 / 状态 / 所属分卷 / 本章目标），不碰正文。
pub fn update_meta(
    conn: &Connection,
    input: &ChapterUpdateInput,
    now: &str,
) -> AppResult<Option<ChapterListItem>> {
    let changed = conn.execute(
        "UPDATE chapters
            SET title = ?, status = ?, volume_id = ?,
                target_words = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL",
        rusqlite::params![
            input.title,
            input.status,
            input.volume_id,
            input.target_words,
            now,
            input.id
        ],
    )?;

    if changed == 0 {
        return Ok(None);
    }
    find_list_item_by_id(conn, input.id)
}

/// 保存正文。
///
/// 三个派生值（`content_text` / `hanzi_count` / `char_count`）与正文在
/// **同一条 UPDATE** 里写入。拆成多条语句的话，任何一条失败都会留下
/// 「正文是新的、字数是旧的」这种自相矛盾的状态，而统计页会长期显示一个错的数字。
///
/// `deleted_at IS NULL` 是回收站加的第二道闸：编辑器可能在另一处删掉这一章
/// 之后又自动保存一次，那道写入必须落到零行上。若它照常写进去，回收站里的
/// 章节正文会被悄悄改掉 —— 而这恰恰是「恢复」要还原的东西。
pub fn save_content(
    conn: &Connection,
    input: &ChapterSaveContentInput,
    content_text: &str,
    hanzi_count: i64,
    char_count: i64,
    now: &str,
) -> AppResult<Option<ChapterSaveContentStored>> {
    let changed = conn.execute(
        "UPDATE chapters
            SET content_html = ?,
                content_text = ?,
                hanzi_count  = ?,
                char_count   = ?,
                updated_at   = ?
          WHERE id = ? AND deleted_at IS NULL",
        rusqlite::params![
            input.content_html,
            content_text,
            hanzi_count,
            char_count,
            now,
            input.id
        ],
    )?;

    if changed == 0 {
        return Ok(None);
    }
    Ok(Some(ChapterSaveContentStored {
        id: input.id,
        hanzi_count,
        char_count,
        updated_at: now.to_string(),
    }))
}

/// `save_content` 的原始行结果。与契约类型 `ChapterSaveResult` 同形 ——
/// 分开只是为了在回档路径上能再加一个 `snapshot_kept` 字段。
#[derive(Debug, Clone)]
pub struct ChapterSaveContentStored {
    pub id: i64,
    pub hanzi_count: i64,
    pub char_count: i64,
    pub updated_at: String,
}

/* ------------------------------------------------------------------ *
 * 回收站
 *
 * 命名与卡片仓储一致：soft_delete / restore_by_id 只改标记，
 * purge_by_id / purge_all 真的 DELETE。
 *
 * 每条写语句都带上 `deleted_at IS [NOT] NULL` 作为第二道闸 ——
 * 服务层已经校验过状态，但真正决定「会发生什么」的是 SQL。
 * ------------------------------------------------------------------ */

pub fn soft_delete(conn: &Connection, id: i64, now: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE chapters SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        rusqlite::params![now, id],
    )?;
    Ok(changed > 0)
}

/// 从回收站恢复，并把它落在容器的**末尾**。
///
/// 为什么不放回原来的位置：它进回收站的那一刻，所属容器就被重排过
/// （空位已经合拢，见服务层 `remove`），原来的 order_index 可能已经属于
/// 另一章了。硬插回原位会让两章争同一个下标，此后拖拽移动算出的顺序会变得
/// 不确定 —— 而「回到末尾」是确定、可解释、且不与任何现有章节冲突的。
pub fn restore_by_id(conn: &Connection, id: i64, order_index: i64, now: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE chapters
            SET deleted_at = NULL, order_index = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NOT NULL",
        rusqlite::params![order_index, now, id],
    )?;
    Ok(changed > 0)
}

/// 彻底删除。它的历史版本（`chapter_revisions`）与卡片关联
/// （`card_chapter_links`）随外键 CASCADE 一并消失 —— 这正是迁移里把
/// 外键定成 CASCADE 时的预期：数据真的没了，指向它的关联行留着只是脏数据。
pub fn purge_by_id(conn: &Connection, id: i64) -> AppResult<bool> {
    let changed = conn.execute(
        "DELETE FROM chapters WHERE id = ? AND deleted_at IS NOT NULL",
        [id],
    )?;
    Ok(changed > 0)
}

pub fn purge_all(conn: &Connection) -> AppResult<i64> {
    Ok(conn.execute("DELETE FROM chapters WHERE deleted_at IS NOT NULL", [])? as i64)
}

/// 回收站里的章节，最近删除的在前。
///
/// 书名与卷名都用 LEFT JOIN：`volume_id` 可能已经是 NULL（它所属的分卷被删过，
/// `ON DELETE SET NULL`），用内连接会让这些章节整批从回收站里消失 ——
/// 而它们恰恰是最需要被看见的那一批。
pub fn list_deleted(conn: &Connection, limit: i64) -> AppResult<Vec<DeletedChapterRow>> {
    let sql = format!(
        "{DELETED_SELECT}
          WHERE c.deleted_at IS NOT NULL
          ORDER BY c.deleted_at DESC, c.id DESC
          LIMIT ?"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([limit], read_deleted_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn count_deleted(conn: &Connection) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM chapters WHERE deleted_at IS NOT NULL",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 按传入顺序重写某个容器内的 `order_index`。
pub fn reorder(conn: &Connection, input: &ChapterReorderInput, now: &str) -> AppResult<i64> {
    let mut statement = conn.prepare(
        "UPDATE chapters
            SET order_index = ?, updated_at = ?
          WHERE id = ? AND book_id = ? AND deleted_at IS NULL",
    )?;

    let mut changed = 0i64;
    for (index, id) in input.ordered_ids.iter().enumerate() {
        changed += statement.execute(rusqlite::params![index as i64, now, id, input.book_id])? as i64;
    }
    Ok(changed)
}

/// 把一章挪到另一个容器并落到指定位置。调用方负责算好两份 id 序列。
pub fn apply_move(
    conn: &Connection,
    chapter_id: i64,
    volume_id: Option<i64>,
    source_ordered_ids: &[i64],
    target_ordered_ids: &[i64],
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE chapters SET volume_id = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL",
        rusqlite::params![volume_id, now, chapter_id],
    )?;

    // 两个容器都要重写：源容器要合拢被抽走留下的空位，目标容器要接纳新成员。
    // 只改一边会让某一边出现重复的 order_index。
    let mut statement = conn.prepare(
        "UPDATE chapters SET order_index = ? WHERE id = ? AND deleted_at IS NULL",
    )?;

    for (index, id) in target_ordered_ids.iter().enumerate() {
        statement.execute(rusqlite::params![index as i64, id])?;
    }

    for (index, id) in source_ordered_ids
        .iter()
        .filter(|id| **id != chapter_id)
        .enumerate()
    {
        statement.execute(rusqlite::params![index as i64, id])?;
    }

    Ok(())
}

/// 一段时间内被编辑过的章节数，供统计页展示。
///
/// 同样只看活着的：回收站里的章节不该算进「今天写了 N 章」——
/// 那是一句关于「产出」的话，而回收站里的东西是已经被作者否掉的。
pub fn count_updated_between(conn: &Connection, from_iso: &str, to_iso: &str) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM chapters
          WHERE updated_at >= ? AND updated_at <= ? AND deleted_at IS NULL",
        rusqlite::params![from_iso, to_iso],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 全书最近一次编辑时间，供首页「最后编辑 2 小时前」。
pub fn latest_update_at(conn: &Connection) -> AppResult<Option<String>> {
    let latest: Option<String> = conn.query_row(
        "SELECT MAX(updated_at) AS latest FROM chapters WHERE deleted_at IS NULL",
        [],
        |row| row.get::<_, Option<String>>(0),
    )?;
    Ok(latest.filter(|value| !value.is_empty()))
}

/// 一次查出多本书各自最近编辑的那一章。
///
/// 用窗口函数而不是「循环里对每本书查一次」：后者是标准的 N+1，
/// 首页显示 5 本书就是 5 次查询，统计页要对比 20 本时变成 20 次。
pub fn latest_by_books(
    conn: &Connection,
    book_ids: &[i64],
) -> AppResult<std::collections::HashMap<i64, (i64, String)>> {
    let mut result = std::collections::HashMap::new();
    if book_ids.is_empty() {
        return Ok(result);
    }

    let placeholders = vec!["?"; book_ids.len()].join(", ");
    let sql = format!(
        "SELECT book_id, id, title FROM (
           SELECT book_id, id, title,
                  ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY updated_at DESC, id DESC) AS rn
             FROM chapters
            WHERE book_id IN ({placeholders}) AND deleted_at IS NULL
         ) WHERE rn = 1"
    );

    let params: Vec<Value> = book_ids.iter().map(|id| Value::Integer(*id)).collect();
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        Ok((
            row.get::<_, i64>("book_id")?,
            row.get::<_, i64>("id")?,
            row.get::<_, String>("title")?,
        ))
    })?;

    for row in rows {
        let (book_id, id, title) = row?;
        result.insert(book_id, (id, title));
    }
    Ok(result)
}
