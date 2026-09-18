import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import type { AppConfig } from '../config/env'
import { AppError } from '../core/errors'
import { logger } from '../core/logger'
import type { Db } from './types'

let connection: Db | null = null
let databaseFile = ''

/**
 * 打开 SQLite 连接。
 *
 * 几个 pragma 不是可选项：
 *   - journal_mode = WAL   读写并发不互相阻塞，桌面场景多窗口时很关键
 *   - synchronous = NORMAL WAL 下的安全档位，兼顾性能与掉电安全
 *   - foreign_keys = ON    SQLite 默认关闭外键约束，必须显式打开
 *   - busy_timeout = 5000  遇到写锁时等待而不是立刻抛 SQLITE_BUSY
 */
export function initDatabase(config: AppConfig): Db {
  if (connection) return connection

  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })

  const file = join(userDataDir, config.dbFileName)

  try {
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')

    connection = db
    databaseFile = file

    logger.info('数据库已打开', {
      file,
      journalMode: db.pragma('journal_mode', { simple: true }),
      sqliteVersion: db.pragma('user_version', { simple: true })
    })

    return db
  } catch (error) {
    throw AppError.internal(`无法打开数据库文件：${file}`, error)
  }
}

export function getDatabase(): Db {
  if (!connection) {
    throw AppError.internal('数据库尚未初始化，请检查启动流程')
  }
  return connection
}

export function getDatabaseFile(): string {
  return databaseFile
}

/** 在事务中执行。better-sqlite3 的 transaction 是同步的，任何异常自动回滚 */
export function runInTransaction<T>(fn: () => T): T {
  return getDatabase().transaction(fn)()
}

export function closeDatabase(): void {
  if (!connection) return
  try {
    connection.pragma('wal_checkpoint(TRUNCATE)')
    connection.close()
    logger.info('数据库连接已关闭', { file: databaseFile })
  } catch (error) {
    logger.warn('关闭数据库时出错', { error })
  } finally {
    connection = null
  }
}
