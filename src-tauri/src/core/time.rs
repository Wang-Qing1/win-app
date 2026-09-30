//! 时间戳。
//!
//! **格式必须与 JS 的 `new Date().toISOString()` 逐字一致**：
//! `2026-09-29T08:47:37.123Z` —— 定长、UTC、毫秒 3 位、以 `Z` 结尾。
//!
//! 为什么较真到毫秒位：这些字符串在库里是**文本**，而排序全靠它们的
//! 字典序（`ORDER BY updated_at DESC`）。定长是字典序等于时间序的前提。
//! 一旦混进 `+00:00` 结尾或省略毫秒的写法，`Z`（0x5A）与 `+`（0x2B）
//! 会让同一秒内的记录排错位 —— 而排序错位不会报错，只会「看着有点乱」。

use chrono::{SecondsFormat, Utc};

/// 当前 UTC 时间，格式同 JS `toISOString()`。
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
