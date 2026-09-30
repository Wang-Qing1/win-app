//! 请求追踪 ID。
//!
//! 每次命令调用生成一个，同时出现在：返回给前端的错误信封、日志行、
//! 以及被拒绝调用的登记表里。用户截图报错时凭它一条命令就能捞出上下文。

use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 形如 `req-lz4k9m2f-7`：前段是时间戳的 base36（便于人眼排序）、
/// 后段是进程内自增序号（保证同一毫秒内不重号）。
pub fn create_request_id() -> String {
    let millis = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed) % 1_000;
    format!("req-{}-{}", base36(millis), seq)
}

fn base36(mut value: u64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buffer = Vec::with_capacity(13);
    while value > 0 {
        buffer.push(ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    buffer.reverse();
    String::from_utf8(buffer).unwrap_or_else(|_| "0".to_string())
}
