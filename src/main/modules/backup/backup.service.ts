import { statSync } from 'node:fs'
import { BrowserWindow, dialog, type WebContents } from 'electron'
import type { BackupDatabaseResult } from '@shared/modules/backup'
import { localDateKey } from '@shared/datetime'
import { getDatabase, getDatabaseFile } from '../../db/connection'
import { logger } from '../../core/logger'

/**
 * 数据库备份服务。
 *
 * 用 better-sqlite3 自带的 `db.backup()` 而不是直接 fs 复制 .db 文件：
 * 连接开的是 WAL 模式（见 connection.ts），最新写入可能还没 checkpoint 到 .db 文件中，
 * 还在 -wal 边档里。直接复制主文件会漏掉这部分，备份回来的书少了最后几行；
 * `db.backup()` 会自己处理这个问题，且在备份期间不阻塞其他读写。
 */
export class BackupService {
  async backupDatabase(sender: WebContents): Promise<BackupDatabaseResult> {
    const suggestedName = `winbook-备份-${localDateKey(new Date())}.db`

    const parent = BrowserWindow.fromWebContents(sender)
    const options = {
      title: '备份数据库',
      defaultPath: suggestedName,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    }

    const result =
      parent !== null
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)

    if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
      // 取消不是错误：调用方据此安静地什么都不做
      return { canceled: true, filePath: null, bytes: 0 }
    }

    await getDatabase().backup(result.filePath)
    const bytes = statSync(result.filePath).size

    logger.info('数据库已备份', { sourceFile: getDatabaseFile(), filePath: result.filePath, bytes })

    return { canceled: false, filePath: result.filePath, bytes }
  }
}
