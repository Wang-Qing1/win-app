import { existsSync, statSync } from 'node:fs'
import { app } from 'electron'
import type { DatabaseInfo, HealthStatus, ReadinessCheck, ReadinessStatus, RuntimeInfo } from '@shared/api'
import type { AppConfig } from '../../config/env'
import { getSchemaVersion } from '../../db/migrator'
import { getDatabaseFile } from '../../db/connection'
import type { Db } from '../../db/types'
import type { BookRepository } from '../books/book.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'

/**
 * 健康检查服务。
 *
 * /ping  给前端启动时自检用：确认主进程活着、数据库能查、schema 已就绪。
 * /ready 给「可以开始干活了吗」判断用：逐项检查并给出失败原因。
 *
 * 这条通道是诊断用途，因此允许回传数据库路径与文件大小；
 * 业务接口一律不返回这类内部信息。
 */
export class HealthService {
  private readonly startedAt = Date.now()

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly bookRepository: BookRepository,
    private readonly chapterRepository: ChapterRepository
  ) {}

  ping(): HealthStatus {
    return {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      runtime: this.runtimeInfo(),
      database: this.databaseInfo()
    }
  }

  ready(): ReadinessStatus {
    const checks: ReadinessCheck[] = []

    checks.push({
      name: 'config',
      ok: true,
      detail: `环境=${this.config.env}，日志级别=${this.config.logLevel}`
    })

    checks.push(this.checkDatabase())
    checks.push(this.checkMigrations())

    return {
      ready: checks.every((check) => check.ok),
      checks
    }
  }

  private runtimeInfo(): RuntimeInfo {
    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      v8Version: process.versions.v8 ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      locale: app.getLocale()
    }
  }

  private databaseInfo(): DatabaseInfo {
    const file = getDatabaseFile()
    let sizeBytes = 0
    try {
      if (existsSync(file)) sizeBytes = statSync(file).size
    } catch {
      sizeBytes = 0
    }

    return {
      file,
      sizeBytes,
      journalMode: String(this.db.pragma('journal_mode', { simple: true })),
      schemaVersion: getSchemaVersion(this.db),
      bookCount: this.bookRepository.countAll(),
      chapterCount: this.chapterRepository.countAll()
    }
  }

  private checkDatabase(): ReadinessCheck {
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
      const ok = row?.ok === 1
      return {
        name: 'database',
        ok,
        detail: ok ? `连接正常，文件 ${getDatabaseFile()}` : '数据库探测查询返回了非预期结果'
      }
    } catch (error) {
      return {
        name: 'database',
        ok: false,
        detail: error instanceof Error ? error.message : '数据库不可用'
      }
    }
  }

  private checkMigrations(): ReadinessCheck {
    const version = getSchemaVersion(this.db)
    return {
      name: 'migrations',
      ok: version !== null,
      detail: version === null ? '尚未应用任何数据库迁移' : `当前 schema 版本：${version}`
    }
  }
}
