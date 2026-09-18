import { CloudUploadOutlined } from '@ant-design/icons'
import { Button, Tooltip } from 'antd'
import { useBackupDatabase } from '../features/backup/use-backup'
import { formatBytes } from '../lib/format'
import { useToast } from './Toast'

/**
 * 备份数据库。
 *
 * 放在顶栏，与 HealthBadge / ThemeToggle 同一行——备份是与具体书/卷无关的全局操作，
 * 放在任何一本书的详情页里都会让人误以为只备份这一本书。
 */
export function BackupButton() {
  const backup = useBackupDatabase()
  const { notifySuccess, notifyError } = useToast()

  const handleClick = async (): Promise<void> => {
    try {
      const result = await backup.mutateAsync()
      if (!result.canceled) {
        notifySuccess(`数据库已备份（${formatBytes(result.bytes)}）`)
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '备份失败')
    }
  }

  return (
    <Tooltip title="备份数据库">
      <Button
        data-testid="backup-database-button"
        type="text"
        size="small"
        icon={<CloudUploadOutlined />}
        loading={backup.isPending}
        aria-label="备份数据库"
        onClick={() => void handleClick()}
      />
    </Tooltip>
  )
}
