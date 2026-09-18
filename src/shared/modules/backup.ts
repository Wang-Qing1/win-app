/**
 * 数据库备份。
 *
 * 只做备份，不做恢复——恢复需要安全地关闭/重开一个正在被各个 Repository、
 * HealthService 共享引用的活连接，这个复杂度超出了一次性小功能的范围——
 * 现阶段先给用户一个可靠的“导出一份完整副本”，恢复仍靠手动：关闭 wapp、
 * 用备份文件覆盖 %APPDATA%\wapp\wapp.db、重新打开。
 */
export interface BackupDatabaseResult {
  canceled: boolean
  filePath: string | null
  bytes: number
}
