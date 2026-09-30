//! 写作会话仓储。
//!
//! 这里是统计功能**唯一的数据来源**：所有跨表聚合（统计模块）最终都落到这张表上，
//! 因此时间范围与书籍过滤的逻辑集中在本文件 —— 各统计入口各写一份 WHERE 的话，
//! 「趋势图与总览为什么对不上」这种问题会变得非常难查。

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};

use crate::core::errors::{AppError, AppResult};
use crate::db::sql_utils::to_number;

use super::models::{SessionFinishInput, SessionListQuery, WritingSession};

/// 把「写作量 / 净增」两个派生口径集中在一处换算。
///
/// 两个口径的差别（见契约层）很容易在调用点被搞混，所以只在这里定义一次，
/// 其他任何地方都不许自己写 `peak - start`。
fn to_session(row: &Row<'_>) -> rusqlite::Result<WritingSession> {
    let start_words = to_number(row.get::<_, Option<i64>>("start_words")?);
    let end_words = to_number(row.get::<_, Option<i64>>("end_words")?);
    let peak_words = to_number(row.get::<_, Option<i64>>("peak_words")?);

    Ok(WritingSession {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        chapter_id: row.get("chapter_id")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        duration_seconds: to_number(row.get::<_, Option<i64>>("duration_seconds")?),
        start_words,
        end_words,
        peak_words,
        // 「写作量」不会为负：它衡量的是这一段时间里出现过多少新字，
        // 删字不该倒扣（倒扣体现在净增上）
        words_written: std::cmp::max(0, peak_words - start_words),
        words_net: end_words - start_words,
    })
}

/// 拼出时间区间与书籍过滤条件。所有聚合查询共用，保证口径一致。
fn build_filter(
    from: Option<&str>,
    to: Option<&str>,
    book_id: Option<i64>,
) -> (String, Vec<Value>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(from) = from {
        conditions.push("started_at >= ?".to_string());
        params.push(Value::Text(from.to_string()));
    }
    if let Some(to) = to {
        conditions.push("started_at <= ?".to_string());
        params.push(Value::Text(to.to_string()));
    }
    if let Some(book_id) = book_id {
        conditions.push("book_id = ?".to_string());
        params.push(Value::Integer(book_id));
    }

    let sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    (sql, params)
}

pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<WritingSession>> {
    let mut statement = conn.prepare("SELECT * FROM writing_sessions WHERE id = ?")?;
    let mut rows = statement.query_map([id], to_session)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn insert(conn: &Connection, input: &SessionFinishInput) -> AppResult<WritingSession> {
    conn.execute(
        "INSERT INTO writing_sessions
           (book_id, chapter_id, started_at, ended_at, duration_seconds, start_words, end_words, peak_words)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.book_id,
            input.chapter_id,
            input.started_at,
            input.ended_at,
            input.duration_seconds,
            input.start_words,
            input.end_words,
            input.peak_words
        ],
    )?;

    let id = conn.last_insert_rowid();
    find_by_id(conn, id)?.ok_or_else(|| AppError::internal("写入写作会话后无法回读记录"))
}

pub fn list(conn: &Connection, query: &SessionListQuery) -> AppResult<Vec<WritingSession>> {
    let (filter_sql, filter_params) = build_filter(
        query.from.as_deref(),
        query.to.as_deref(),
        query.book_id,
    );

    let mut params = filter_params;
    params.push(Value::Integer(query.limit));

    let mut statement = conn.prepare(&format!(
        "SELECT * FROM writing_sessions
         {filter_sql}
         ORDER BY started_at DESC
         LIMIT ?"
    ))?;
    let rows = statement.query_map(params_from_iter(params.iter()), to_session)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/* ------------------------------------------------------------------ *
 * 聚合（供统计模块使用）
 * ------------------------------------------------------------------ */

/// 按天聚合出来的一行。
pub struct DailyAggregateRow {
    pub day: String,
    pub words_written: i64,
    pub words_net: i64,
    pub duration: i64,
    pub session_count: i64,
}

pub struct SessionTotals {
    pub words_written: i64,
    pub words_net: i64,
    pub duration_seconds: i64,
}

/// 按**本地日期**聚合。
///
/// 用 SQLite 的 `localtime` 修饰符而不是把行拉回内存分组：会话条数会随使用
/// 时间线性增长，把几万条记录拉过内存只为了按天求和是不必要的。
/// 注意这个口径必须与渲染层的本地日期口径一致，
/// 否则「今日」在 SQL 与界面里会指到不同的日子。
pub fn daily_aggregate(
    conn: &Connection,
    from: &str,
    to: &str,
    book_id: Option<i64>,
) -> AppResult<Vec<DailyAggregateRow>> {
    let (filter_sql, params) = build_filter(Some(from), Some(to), book_id);

    let mut statement = conn.prepare(&format!(
        "SELECT date(started_at, 'localtime')                      AS day,
                COALESCE(SUM(max(peak_words - start_words, 0)), 0) AS words_written,
                COALESCE(SUM(end_words - start_words), 0)          AS words_net,
                COALESCE(SUM(duration_seconds), 0)                 AS duration,
                COUNT(*)                                           AS session_count
           FROM writing_sessions
           {filter_sql}
          GROUP BY day
          ORDER BY day ASC"
    ))?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        Ok(DailyAggregateRow {
            day: row.get("day")?,
            words_written: to_number(row.get::<_, Option<i64>>("words_written")?),
            words_net: to_number(row.get::<_, Option<i64>>("words_net")?),
            duration: to_number(row.get::<_, Option<i64>>("duration")?),
            session_count: to_number(row.get::<_, Option<i64>>("session_count")?),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn totals(
    conn: &Connection,
    from: &str,
    to: &str,
    book_id: Option<i64>,
) -> AppResult<SessionTotals> {
    let (filter_sql, params) = build_filter(Some(from), Some(to), book_id);

    conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(max(peak_words - start_words, 0)), 0) AS words_written,
                    COALESCE(SUM(end_words - start_words), 0)          AS words_net,
                    COALESCE(SUM(duration_seconds), 0)                 AS duration
               FROM writing_sessions
               {filter_sql}"
        ),
        params_from_iter(params.iter()),
        |row| {
            Ok(SessionTotals {
                words_written: to_number(row.get::<_, Option<i64>>("words_written")?),
                words_net: to_number(row.get::<_, Option<i64>>("words_net")?),
                duration_seconds: to_number(row.get::<_, Option<i64>>("duration")?),
            })
        },
    )
    .map_err(Into::into)
}

/// 有写作记录的本地日期集合，从新到旧。
///
/// 只取最近 400 天：连续写作天数不可能超过这个量级的有意义范围，
/// 而全量 DISTINCT 在用了几年之后会变成一次全表扫描。
pub fn active_day_keys(conn: &Connection, from_iso: &str, limit: i64) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT date(started_at, 'localtime') AS day
           FROM writing_sessions
          WHERE started_at >= ?
          ORDER BY day DESC
          LIMIT ?",
    )?;
    let rows = statement.query_map(params![from_iso, limit], |row| row.get::<_, String>("day"))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 某段时间里每本书各自的写作量与时长，供统计页的分书对比。
pub struct BookAggregateRow {
    pub book_id: i64,
    pub words_written: i64,
    pub duration_seconds: i64,
}

pub fn aggregate_by_book(
    conn: &Connection,
    from: &str,
    to: &str,
) -> AppResult<Vec<BookAggregateRow>> {
    let mut statement = conn.prepare(
        "SELECT book_id,
                COALESCE(SUM(max(peak_words - start_words, 0)), 0) AS words_written,
                COALESCE(SUM(duration_seconds), 0)                 AS duration
           FROM writing_sessions
          WHERE started_at >= ? AND started_at <= ? AND book_id IS NOT NULL
          GROUP BY book_id",
    )?;
    let rows = statement.query_map(params![from, to], |row| {
        Ok(BookAggregateRow {
            book_id: row.get("book_id")?,
            words_written: to_number(row.get::<_, Option<i64>>("words_written")?),
            duration_seconds: to_number(row.get::<_, Option<i64>>("duration")?),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 最早一条会话的时间，用于把「近一年」的起点夹到真实数据的范围内。
pub fn earliest_started_at(conn: &Connection) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT MIN(started_at) AS earliest FROM writing_sessions",
        [],
        |row| row.get::<_, Option<String>>("earliest"),
    )
    .map_err(Into::into)
}
