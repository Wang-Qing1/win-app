import { IpcChannel } from '@shared/ipc-channels'
import { registerHandler } from '../../core/ipc-handler'
import type { BackupService } from './backup.service'

export function registerBackupHandlers(service: BackupService): void {
  registerHandler(IpcChannel.BackupDatabase, {
    label: '备份数据库',
    handle: (_input, ctx) => service.backupDatabase(ctx.event.sender)
  })
}
