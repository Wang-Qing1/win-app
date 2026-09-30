//! 统计服务。
//!
//! 这个模块**没有自己的表**，也不直接写 SQL —— 所有数字都复用它已有的仓储。
//! 这样做的好处是统计口径不会出现第二份副本：一旦「今日字数怎么算」需要调整，
//! 只改会话仓储一处即可，不会出现「首页和统计页对不上」。

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use crate::core::datetime::{
    add_days, compute_streak, each_day_key, end_of_local_day, local_date_key, start_of_local_day,
    today,
};
use crate::core::errors::AppResult;
use crate::modules::books::models::BookListQuery;
use crate::modules::books::repository as book_repository;
use crate::modules::chapters::repository as chapter_repository;
use crate::modules::sessions::repository as session_repository;

use super::models::{
    level_of, BookProgressItem, BookProgressQuery, DailyWordsPoint, HeatmapCell, HeatmapResult,
    OverviewStats, StatsTrendQuery, TrendResult,
};

/// 连续写作天数最多回溯的天数，与会话仓储里的查询上限保持一致。
const STREAK_LOOKBACK_DAYS: i64 = 400;

/* ------------------------------------------------------------------ *
 * 概览
 * ------------------------------------------------------------------ */

pub fn overview(conn: &Connection) -> AppResult<OverviewStats> {
    let now = today();
    let day_from = start_of_local_day(now);
    let day_to = end_of_local_day(now);

    let book_stats = book_repository::stats(conn)?;
    let today_totals = session_repository::totals(conn, &day_from, &day_to, None)?;

    // 累计时长覆盖全部历史，因此下界取「最早一条会话」。
    // 没有历史时退回今天，结果同样是 0，不需要额外分支
    let history_from = session_repository::earliest_started_at(conn)?;
    let total_duration_seconds = session_repository::totals(
        conn,
        history_from.as_deref().unwrap_or(&day_from),
        &day_to,
        None,
    )?
    .duration_seconds;

    let lookback_from = start_of_local_day(add_days(now, -STREAK_LOOKBACK_DAYS));
    let active_days: HashSet<String> =
        session_repository::active_day_keys(conn, &lookback_from, STREAK_LOOKBACK_DAYS)?
            .into_iter()
            .collect();

    Ok(OverviewStats {
        book_count: book_stats.total,
        active_book_count: book_repository::count_by_status(conn, "serializing")?,
        volume_count: book_stats.volume_count,
        chapter_count: book_stats.chapter_count,
        total_hanzi: book_stats.hanzi_count,
        total_chars: book_stats.char_count,
        total_duration_seconds,

        today_words_written: today_totals.words_written,
        today_words_net: today_totals.words_net,
        today_duration_seconds: today_totals.duration_seconds,
        today_chapter_count: chapter_repository::count_updated_between(conn, &day_from, &day_to)?,

        streak_days: compute_streak(&active_days, now),
        last_edited_at: chapter_repository::latest_update_at(conn)?,
        ongoing_target_words: book_repository::sum_target_words_by_status(conn, "serializing")?,
    })
}

/* ------------------------------------------------------------------ *
 * 字数与时长趋势
 * ------------------------------------------------------------------ */

pub fn trend(conn: &Connection, query: &StatsTrendQuery) -> AppResult<TrendResult> {
    let now = today();
    let to_date = now;
    // 区间含今天，所以往前推 days - 1 天
    let from_date = add_days(now, -(query.days - 1));
    let from_iso = start_of_local_day(from_date);
    let to_iso = end_of_local_day(to_date);

    let rows = session_repository::daily_aggregate(conn, &from_iso, &to_iso, query.book_id)?;
    let by_day: HashMap<String, _> = rows.into_iter().map(|row| (row.day.clone(), row)).collect();

    // 没有写作的日子也要占一格：SQL 的 GROUP BY 只返回有记录的天，
    // 直接拿去画图会出现日期跳空、曲线被压缩，看起来像「某天写了特别多」
    let days: Vec<DailyWordsPoint> =
        each_day_key(add_days(from_date, -1), to_date, query.days as usize)
            .into_iter()
            .map(|date| {
                let row = by_day.get(&date);
                DailyWordsPoint {
                    date,
                    words_written: row.map(|item| item.words_written).unwrap_or(0),
                    words_net: row.map(|item| item.words_net).unwrap_or(0),
                    duration_seconds: row.map(|item| item.duration).unwrap_or(0),
                    session_count: row.map(|item| item.session_count).unwrap_or(0),
                }
            })
            .collect();

    let total_words_written: i64 = days.iter().map(|day| day.words_written).sum();
    let total_words_net: i64 = days.iter().map(|day| day.words_net).sum();
    let total_duration_seconds: i64 = days.iter().map(|day| day.duration_seconds).sum();
    let active_days = days.iter().filter(|day| day.session_count > 0).count() as i64;

    Ok(TrendResult {
        from: local_date_key(from_date),
        to: local_date_key(to_date),
        days,
        total_words_written,
        total_words_net,
        total_duration_seconds,
        active_days,
        // 按「有写作的天数」求平均，而不是除以区间总天数：
        // 后者会把休息日也算作低产日，得出一个持续下降的假趋势
        average_words_per_active_day: if active_days == 0 {
            0
        } else {
            (total_words_written as f64 / active_days as f64).round() as i64
        },
    })
}

/* ------------------------------------------------------------------ *
 * 分书籍进度
 * ------------------------------------------------------------------ */

pub fn books(conn: &Connection, query: &BookProgressQuery) -> AppResult<Vec<BookProgressItem>> {
    // 复用书籍列表查询拿聚合字段，而不是另写一套 JOIN —— 保证首页的
    // 「总字数」和书架页显示的数字来自同一条 SQL
    let list = book_repository::list(
        conn,
        &BookListQuery {
            keyword: String::new(),
            status: None,
            page: 1,
            page_size: query.limit,
            sort_by: "updatedAt".to_string(),
            sort_order: "desc".to_string(),
        },
    )?;

    let ids: Vec<i64> = list.items.iter().map(|book| book.id).collect();
    let latest_chapters = chapter_repository::latest_by_books(conn, &ids)?;

    let mut range_aggregates: HashMap<i64, (i64, i64)> = HashMap::new();
    if let Some(range_days) = query.range_days {
        let now = today();
        let from_iso = start_of_local_day(add_days(now, -(range_days - 1)));
        let to_iso = end_of_local_day(now);
        for row in session_repository::aggregate_by_book(conn, &from_iso, &to_iso)? {
            range_aggregates.insert(row.book_id, (row.words_written, row.duration_seconds));
        }
    }

    Ok(list
        .items
        .into_iter()
        .map(|book| {
            let latest = latest_chapters.get(&book.id);
            let range = range_aggregates.get(&book.id);
            BookProgressItem {
                book_id: book.id,
                title: book.title,
                accent_color: book.accent_color,
                status: book.status,
                hanzi_count: book.hanzi_count,
                target_words: book.target_words,
                chapter_count: book.chapter_count,
                last_edited_at: book.last_edited_at,
                last_chapter_id: latest.map(|item| item.0),
                last_chapter_title: latest.map(|item| item.1.clone()),
                range_words_written: range.map(|item| item.0).unwrap_or(0),
                range_duration_seconds: range.map(|item| item.1).unwrap_or(0),
            }
        })
        .collect())
}

/* ------------------------------------------------------------------ *
 * 写作热力日历
 * ------------------------------------------------------------------ */

pub fn heatmap(conn: &Connection, days: i64, book_id: Option<i64>) -> AppResult<HeatmapResult> {
    let now = today();
    let to_date = now;
    let from_date = add_days(now, -(days - 1));
    let from_iso = start_of_local_day(from_date);
    let to_iso = end_of_local_day(to_date);

    let rows = session_repository::daily_aggregate(conn, &from_iso, &to_iso, book_id)?;
    let by_day: HashMap<String, _> = rows.into_iter().map(|row| (row.day.clone(), row)).collect();

    let raw: Vec<(String, i64)> = each_day_key(add_days(from_date, -1), to_date, days as usize)
        .into_iter()
        .map(|date| {
            let words = by_day.get(&date).map(|row| row.words_written).unwrap_or(0);
            (date, words)
        })
        .collect();

    let max_words = raw.iter().map(|(_, words)| *words).max().unwrap_or(0);

    let cells: Vec<HeatmapCell> = raw
        .into_iter()
        .map(|(date, words_written)| HeatmapCell {
            date,
            words_written,
            // 等级在服务端算好：前端各处自己定阈值的话，趋势图和热力图
            // 对「同样的字数」会给出不同的颜色，用户会以为其中一个坏了
            level: level_of(words_written, max_words),
        })
        .collect();

    Ok(HeatmapResult {
        from: local_date_key(from_date),
        to: local_date_key(to_date),
        total_words_written: cells.iter().map(|cell| cell.words_written).sum(),
        active_days: cells.iter().filter(|cell| cell.words_written > 0).count() as i64,
        max_words,
        cells,
    })
}
