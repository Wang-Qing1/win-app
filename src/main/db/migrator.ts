import { AppError } from '../core/errors'
import { logger } from '../core/logger'
import { migrations } from './migrations'
import type { Db } from './types'

interface MigrationRow {
  name: string
  applied_at: string
}

/**
 * 顺序执行未应用的迁移。
 *
 * 迁移记录表独立于业务表存在，因此可以在业务 DDL 之前安全创建。
 * 每条迁移与它的记录写入放在同一个事务里 —— 要么都成功，要么都不发生。
 */
export function runMigrations(db: Db): { applied: string[]; current: string | null } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedNames = new Set(
    db
      .prepare('SELECT name FROM schema_migrations ORDER BY id')
      .all()
      .map((row) => (row as MigrationRow).name)
  )

  const justApplied: string[] = []

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) continue

    try {
      db.transaction(() => {
        migration.up(db)
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          migration.name,
          new Date().toISOString()
        )
      })()
      justApplied.push(migration.name)
      logger.info('迁移已应用', { name: migration.name })
    } catch (error) {
      logger.error('迁移执行失败，已回滚', { name: migration.name, error })
      throw AppError.internal(`数据库迁移失败：${migration.name}`, error)
    }
  }

  const lastRow = db
    .prepare('SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1')
    .get() as MigrationRow | undefined

  if (justApplied.length === 0) {
    logger.debug('数据库 schema 已是最新')
  }

  return { applied: justApplied, current: lastRow?.name ?? null }
}

export function getSchemaVersion(db: Db): string | null {
  try {
    const row = db
      .prepare('SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1')
      .get() as MigrationRow | undefined
    return row?.name ?? null
  } catch {
    return null
  }
}
