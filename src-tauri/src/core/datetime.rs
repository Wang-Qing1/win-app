//! 本地日期工具（对应 TS 侧 `src/shared/datetime.ts`）。
//!
//! 为什么不用 UTC 日期（`toISOString().slice(0, 10)`）：对东八区用户来说，
//! 早上 8 点之前写的字会被算到前一天 ——「今日字数」在早鸟用户那里会长期是错的，
//! 而且只在特定时段复现，很难排查。
//!
//! 统一约定：凡是「哪一天」的判断一律走本文件，且与 SQL 侧的
//! `date(started_at, 'localtime')` 保持同一口径 —— 两处口径一旦不同，
//! 「今日」在 SQL 与界面里会指到不同的日子。
//!
//! 日期运算全部落在 `NaiveDate` 上（只做日历加减，不碰时区），
//! 只有需要拿去和 ISO 时间戳比较时才转成本地时刻再转 UTC 串。

use std::collections::HashSet;

use chrono::{
    DateTime, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone,
};

const DATE_FORMAT: &str = "%Y-%m-%d";

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// 本地时区下的 `YYYY-MM-DD`。
pub fn local_date_key(date: NaiveDate) -> String {
    date.format(DATE_FORMAT).to_string()
}

/// 本地时刻 → 与 JS `Date.toISOString()` 逐字一致的 UTC 串
/// （定长、带毫秒、带 Z —— 定长是字典序等于时间序的前提）。
fn to_iso(local: DateTime<Local>) -> String {
    local.to_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 本地朴素时间 → UTC ISO 串。
fn resolve_local(naive: NaiveDateTime) -> String {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(value) => to_iso(value),
        // 夏令时回拨造成的一小时重复：取靠前的那个 —— 与 JS `Date.setHours`
        // 在两可时刻上取第一个可用瞬间的行为一致
        LocalResult::Ambiguous(first, _) => to_iso(first),
        // 夏令时前拨造成的不存在时刻（被跳过的那一小时）：退回按 UTC 解释，
        // 不让整个统计接口因为一个边界日而失败（中国时区不会出现这种情况）
        LocalResult::None => naive.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}

/// 本地当天零点，转成 UTC ISO 串（SQL 里比较的是 UTC 时间列）。
pub fn start_of_local_day(date: NaiveDate) -> String {
    resolve_local(date.and_hms_opt(0, 0, 0).expect("零点合法"))
}

/// 本地当天 23:59:59.999，转成 UTC ISO 串。
pub fn end_of_local_day(date: NaiveDate) -> String {
    resolve_local(
        date.and_hms_milli_opt(23, 59, 59, 999)
            .expect("当日最后一毫秒合法"),
    )
}

/// 加减天数。
///
/// 用日历加减而不是「减 86400000 毫秒」：后者在夏令时切换那天会偏一小时，
/// 跨过午夜时就可能算错一天。（`NaiveDate` 的加减本来就是日历语义。）
pub fn add_days(date: NaiveDate, days: i64) -> NaiveDate {
    date + Duration::days(days)
}

/// 生成从 `from_exclusive` 的次日到 `to_inclusive`（含两端）的连续日期键。
///
/// 趋势图与热力日历需要「没有写作的日子也占一格」—— SQL 的 GROUP BY 只会
/// 返回有记录的那些天，直接画图会出现日期跳空、曲线被压缩，
/// 看起来像「某天写了特别多」。补零由调用方用这个函数完成，
/// 不在 SQL 里造一张日历表。
///
/// 参数名字里的 exclusive / inclusive 是 TS 版的既有语义：调用方把
/// `from - 1 天` 传进来，函数自己再加一天，正好从 `from` 开始。
pub fn each_day_key(
    from_exclusive: NaiveDate,
    to_inclusive: NaiveDate,
    max_days: usize,
) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let mut cursor = add_days(from_exclusive, 1);

    while cursor <= to_inclusive && keys.len() < max_days {
        keys.push(local_date_key(cursor));
        cursor = add_days(cursor, 1);
    }

    keys
}

/// 计算连续写作天数：从今天（或昨天）往前数，直到某天没有记录。
pub fn compute_streak(active_day_keys: &HashSet<String>, today: NaiveDate) -> i64 {
    if active_day_keys.is_empty() {
        return 0;
    }

    // 今天还没写不算断档 —— 凌晨打开应用时不该把连续记录清零。
    // 所以起点是「今天写了就是今天，否则回溯到昨天」。
    let anchor = if active_day_keys.contains(&local_date_key(today)) {
        today
    } else {
        add_days(today, -1)
    };

    let mut streak = 0;
    let mut cursor = anchor;
    while active_day_keys.contains(&local_date_key(cursor)) {
        streak += 1;
        cursor = add_days(cursor, -1);
    }

    streak
}
