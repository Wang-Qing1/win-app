//! 数据层：连接、pragma、事务、迁移。
//!
//! 替换对象是 Electron 版的 `better-sqlite3`。选它的原因不是「Rust 的库更多」，
//! 而是 `rusqlite` 的 `bundled` feature 把 SQLite 的 C 源码一起编进产物 ——
//! 用户机器上不需要任何外部 DLL，也不需要按 ABI 重编译（那正是
//! better-sqlite3 在打包时最麻烦的一环）。

pub mod migrations;
pub mod migrator;
pub mod sql_utils;

use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;

use crate::config::AppConfig;
use crate::core::errors::{AppError, AppResult};
use crate::core::logger;

/// 打开 SQLite 连接。
///
/// 几个 pragma 不是可选项（与 Electron 版逐条一致）：
///   - journal_mode = WAL   读写并发不互相阻塞，自动保存与列表查询会同时发生
///   - synchronous = NORMAL WAL 下的安全档位，兼顾性能与掉电安全
///   - foreign_keys = ON    SQLite 默认**关闭**外键约束，必须显式打开，
///                          否则级联删除与 ON DELETE SET NULL 全是摆设
///   - busy_timeout = 5000  遇到写锁时等待而不是立刻抛 SQLITE_BUSY
pub fn open(config: &AppConfig) -> AppResult<Connection> {
    fs::create_dir_all(&config.user_data_dir).map_err(|error| {
        AppError::internal(format!(
            "无法创建用户数据目录：{}",
            config.user_data_dir.display()
        ))
        .with_detail(error.to_string())
    })?;

    let file: PathBuf = config.user_data_dir.join(&config.db_file_name);

    let conn = Connection::open(&file).map_err(|error| {
        AppError::internal(format!("无法打开数据库文件：{}", file.display()))
            .with_detail(error.to_string())
    })?;

    // 四个 pragma 刻意**不合并成一条 execute_batch**。
    //
    // 原因是一个容易踩的坑：rusqlite 的 `execute_batch` 只要遇到一条
    // **会返回结果集的语句**就报 `ExecuteReturnedResults` 失败 ——
    // 而 `PRAGMA journal_mode = WAL` 与 `PRAGMA busy_timeout = 5000`
    // 恰恰都会返回一行（分别是生效后的模式与超时值）。
    //
    // 症状很有迷惑性：数据库文件被建出来了（Connection::open 成功），
    // 但文件是空的（0 张表），日志里也只有启动那一行 —— 看上去像
    // 「迁移没跑」，实际是打开连接这一步中途就失败了。
    //
    // 所以会返回行的用 query_row 吞掉结果，不返回行的才走 execute_batch。
    conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get::<_, String>(0))?;
    conn.execute_batch("PRAGMA synchronous = NORMAL;")?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.query_row("PRAGMA busy_timeout = 5000", [], |row| row.get::<_, i64>(0))?;

    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap_or_else(|_| "unknown".into());

    logger::info(
        "数据库已打开",
        logger::fields(vec![
            ("file", serde_json::json!(file.display().to_string())),
            ("journalMode", serde_json::json!(journal_mode)),
        ]),
    );

    Ok(conn)
}

pub fn database_file(config: &AppConfig) -> PathBuf {
    config.user_data_dir.join(&config.db_file_name)
}

/// 在事务中执行。任何 `AppError` 都自动回滚。
///
/// **用 SAVEPOINT 而不是 `BEGIN`/`COMMIT`**，理由有两层：
///
///  1. **顶层等价**。SQLite 的规矩是「最外层 SAVEPOINT 的 RELEASE 即是提交」，
///     所以一个不在任何事务里的 SAVEPOINT 与一次 `BEGIN ... COMMIT` 语义相同
///     —— 服务层因此不必区分「我是被谁调用的」。
///  2. **可嵌套**。服务之间会互相调用（大纲落地成章节要调章节服务、
///     回收站要调卡片与章节服务），而 `rusqlite::Connection::transaction()`
///     需要 `&mut Connection`，在被外层持有的情况下根本拿不到。
///     用 SQL 层的 SAVEPOINT 就不需要 `&mut`，嵌套时内层回滚只影响内层。
///
/// 这与 Electron 版是一致的：那边 better-sqlite3 的 `db.transaction()` 在
/// 嵌套调用时同样是退化成 SAVEPOINT，而不是报「已在事务中」。
///
/// 代价是 `&Connection` 而不是 `&Transaction` 交给闭包 —— 但这正好也是我们
/// 想要的：仓储与服务一律只认 `&Connection`，签名只有一种。
pub fn in_transaction<T, F>(conn: &Connection, run: F) -> AppResult<T>
where
    F: FnOnce(&Connection) -> AppResult<T>,
{
    use std::sync::atomic::{AtomicU64, Ordering};

    // 名字只需要在**同一条连接**上不重名，而命令之间由 `Mutex<Connection>`
    // 串行化，所以一个进程级的计数器足够
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = format!("wb_sp_{}", COUNTER.fetch_add(1, Ordering::Relaxed));

    conn.execute_batch(&format!("SAVEPOINT {name};"))?;

    match run(conn) {
        Ok(value) => {
            conn.execute_batch(&format!("RELEASE {name};"))?;
            Ok(value)
        }
        Err(error) => {
            // 回滚这一层；外层若有自己的 savepoint，会继续把它的失败一并回滚。
            // 回滚本身失败也只能咽下 —— 掩盖原始错误只会让排查更难。
            let _ = conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name};"));
            Err(error)
        }
    }
}

/// 优雅停机：先做 WAL 检查点把日志并回主库，再关闭连接。
///
/// 少了这一步，退出后目录里会留下 `-wal` / `-shm` 两个文件，
/// 而 WAL 里可能还压着最后一次自动保存的内容。
pub fn close(conn: &Connection) {
    if let Err(error) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        logger::warn(
            "关闭数据库时执行检查点失败",
            logger::fields(vec![("detail", serde_json::json!(error.to_string()))]),
        );
    }
    logger::info("数据库连接已关闭", logger::fields(vec![]));
}
