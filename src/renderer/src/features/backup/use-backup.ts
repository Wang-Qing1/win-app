import { useMutation } from '@tanstack/react-query'
import type { BackupDatabaseResult } from '@shared/modules/backup'
import { ApiError, getBridge, invoke } from '../../lib/api-client'

/**
 * 备份数据库。无入参，无需失效任何缓存——备份只读不写，与导出同样只需处理 canceled。
 */
export function useBackupDatabase() {
  return useMutation<BackupDatabaseResult, ApiError, void>({
    mutationFn: () => invoke(() => getBridge().backup.database())
  })
}
