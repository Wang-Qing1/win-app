//! 分卷模块的领域契约（对应 TS 侧 `src/shared/modules/volumes.ts`）。
//!
//! 分卷是书籍下的一级容器，用于把章节分组（第一卷、第二卷…）。
//! 章节的 `volume_id` 是 `ON DELETE SET NULL`：删一个容器不该毁掉里面的内容。

use serde::Serialize;

pub const LIMIT_TITLE: usize = 80;
pub const LIMIT_SUMMARY: usize = 1000;
/// 同一本书内的分卷数量上限。防止误操作生成成千上万个卷把界面拖垮
pub const LIMIT_PER_BOOK: i64 = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub id: i64,
    pub book_id: i64,
    pub title: String,
    pub summary: String,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 分卷列表项带上聚合信息，避免前端为每个卷再查一次章节数
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeListItem {
    pub id: i64,
    pub book_id: i64,
    pub title: String,
    pub summary: String,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
    pub chapter_count: i64,
    pub hanzi_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeRemovalResult {
    pub id: i64,
    /// 因这次删除而退回「未分卷」的章节数
    pub detached_chapters: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeReorderResult {
    pub book_id: i64,
}

/* ---------------- 写入入参 ---------------- */

#[derive(Debug, Clone)]
pub struct VolumeCreateInput {
    pub book_id: i64,
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct VolumeUpdateInput {
    pub id: i64,
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct VolumeReorderInput {
    pub book_id: i64,
    pub ordered_ids: Vec<i64>,
}
