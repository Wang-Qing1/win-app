//! 结构化 JSON 日志。
//!
//! 每行一条 JSON，便于 grep 与将来接入日志分析；与控制台输出二选一不做事，
//! 两边都写（开发时看控制台，发布后看文件）。
//!
//! 轮转策略刻意做得极简：单文件 + 一个 `.1` 备份，超过上限就滚一次。
//! 桌面应用的日志量不是问题，复杂轮转（按天分片 + 保留 N 份）只会增加
//! 「日志到底写哪儿去了」的排查成本。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

struct Sink {
    level: LogLevel,
    path: PathBuf,
    max_bytes: u64,
    file: Mutex<Option<File>>,
    to_console: bool,
}

static SINK: OnceLock<Sink> = OnceLock::new();

/// 初始化日志。重复调用只生效一次（`OnceLock` 语义），
/// 避免测试或多窗口场景把 sink 换来换去。
pub fn init(level: LogLevel, directory: &Path, max_bytes: u64, to_console: bool) {
    let path = directory.join("winbook.log");
    let _ = fs::create_dir_all(directory);
    rotate_if_needed(&path, max_bytes);

    let file = OpenOptions::new().create(true).append(true).open(&path).ok();

    let _ = SINK.set(Sink {
        level,
        path,
        max_bytes,
        file: Mutex::new(file),
        to_console,
    });
}

fn rotate_if_needed(path: &Path, max_bytes: u64) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= max_bytes {
        return;
    }
    let backup = path.with_extension("log.1");
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, backup);
}

fn write(level: LogLevel, message: &str, fields: Value) {
    let Some(sink) = SINK.get() else {
        // 日志尚未初始化（极早期启动阶段）：退化成控制台输出，
        // 而不是静默丢掉 —— 启动失败时恰恰最需要看到这几行。
        if level >= LogLevel::Info {
            eprintln!("[winbook] {message} {fields}");
        }
        return;
    };

    if level < sink.level {
        return;
    }

    let mut object = Map::new();
    object.insert("ts".into(), json!(chrono::Utc::now().to_rfc3339()));
    object.insert("level".into(), json!(level.as_str()));
    object.insert("msg".into(), json!(message));
    if let Value::Object(extra) = fields {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    let line = Value::Object(object).to_string();

    if sink.to_console {
        eprintln!("{line}");
    }

    let Ok(mut guard) = sink.file.lock() else { return };
    if guard.is_none() {
        *guard = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&sink.path)
            .ok();
    }
    if let Some(file) = guard.as_mut() {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }

    // 每写一行查一次大小代价可忽略（一次 stat），换来永不无限增长的日志文件
    if let Ok(meta) = fs::metadata(&sink.path) {
        if meta.len() > sink.max_bytes {
            *guard = None;
            rotate_if_needed(&sink.path, sink.max_bytes);
        }
    }
}

pub fn debug(message: &str, fields: Value) {
    write(LogLevel::Debug, message, fields);
}

pub fn info(message: &str, fields: Value) {
    write(LogLevel::Info, message, fields);
}

pub fn warn(message: &str, fields: Value) {
    write(LogLevel::Warn, message, fields);
}

pub fn error(message: &str, fields: Value) {
    write(LogLevel::Error, message, fields);
}

/// 把 `[("k", v), ...]` 这种字面量列表转成 JSON 对象，省掉到处写 `json!`。
pub fn fields(entries: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    for (key, value) in entries {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

/// 关闭前刷盘。命令式写入已经每行 flush，这里只是留一个显式收尾点。
pub fn flush() {
    if let Some(sink) = SINK.get() {
        if let Ok(mut guard) = sink.file.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.flush();
            }
        }
    }
}
