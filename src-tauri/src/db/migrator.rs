//! 迁移执行器。对应 TS 侧的 `src/main/db/migrator.ts`。
//!
//! 顺序执行未应用的迁移。迁移记录表独立于业务表存在，因此可以在业务 DDL
//! 之前安全创建。每条迁移与它的记录写入放在同一个事务里 —— 要么都成功，
//! 要么都不发生（这一点比 TS 版更硬：那边靠 better-sqlite3 的
//! `db.transaction()` 包住，这边用 rusqlite 的 `Transaction`，语义一致）。

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::db::migrations::MIGRATIONS;

pub struct MigrationOutcome {
    pub applied: Vec<String>,
    pub current: Option<String>,
}

pub fn run_migrations(conn: &mut Connection) -> AppResult<MigrationOutcome> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           name       TEXT NOT NULL UNIQUE,
           applied_at TEXT NOT NULL
         );",
    )?;

    let applied_names: Vec<String> = {
        let mut statement = conn.prepare("SELECT name FROM schema_migrations ORDER BY id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut just_applied: Vec<String> = Vec::new();

    for migration in MIGRATIONS {
        if applied_names.iter().any(|name| name == migration.name) {
            continue;
        }

        let now = chrono::Utc::now().to_rfc3339();
        let tx = conn.transaction()?;

        // 整条迁移 + 记录写入同一个事务：中途出错整条回滚，
        // 不会留下「DDL 执行了一半、记录却没落」的半成品 schema。
        let result = (|| -> AppResult<()> {
            tx.execute_batch(migration.sql)?;
            if let Some(post) = migration.post {
                post(&tx)?;
            }
            tx.execute(
                "INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)",
                rusqlite::params![migration.name, now],
            )?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                tx.commit()?;
                logger::info(
                    "迁移已应用",
                    logger::fields(vec![("name", serde_json::json!(migration.name))]),
                );
                just_applied.push(migration.name.to_string());
            }
            Err(error) => {
                // tx 在此处 drop，rusqlite 默认回滚
                logger::error(
                    "迁移执行失败，已回滚",
                    logger::fields(vec![
                        ("name", serde_json::json!(migration.name)),
                        ("detail", serde_json::json!(error.detail.clone().unwrap_or_default())),
                        ("message", serde_json::json!(error.message)),
                    ]),
                );
                return Err(AppError::internal(format!(
                    "数据库迁移失败：{}",
                    migration.name
                ))
                .with_detail(error.detail.unwrap_or_default()));
            }
        }
    }

    let current: Option<String> = conn
        .query_row(
            "SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok();

    if just_applied.is_empty() {
        logger::debug("数据库 schema 已是最新", logger::fields(vec![]));
    }

    Ok(MigrationOutcome {
        applied: just_applied,
        current,
    })
}

/// 读当前 schema 版本。失败返回 None 而不是抛错 ——
/// 它被健康检查与诊断命令调用，不能因为读不到版本就让整个健康检查挂掉。
pub fn get_schema_version(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
}
