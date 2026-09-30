//! 数据库备份的领域契约（前端对应 `shared/modules/backup.ts`）。
//!
//! 只做备份，不做恢复 —— 恢复需要安全地关闭/重开一个正在被各个仓储、
//! 健康检查共享引用的活连接，这个复杂度远超一次性小功能的范围。
//! 现阶段先给用户一个可靠的「导出一份完整副本」，恢复仍靠手动：
//! 关闭 winbook，用备份文件覆盖数据目录下的 winbook.db，再重新打开。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDatabaseResult {
    pub canceled: bool,
    pub file_path: Option<String>,
    pub bytes: i64,
}
