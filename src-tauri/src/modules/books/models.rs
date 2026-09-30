//! 书籍模块的领域类型（对应 TS 侧 `src/shared/modules/books.ts`）。
//!
//! 序列化一律 camelCase：字段名要与渲染层的 TS 接口**逐字一致**，
//! 错了不会编译报错，只会让界面上某几个格子空着 —— 这类错配最难查。

use std::collections::BTreeMap;

use serde::Serialize;

/// 书本状态值域。刻意用字符串数组而不是 Rust enum：
/// 与 TS 侧 `BOOK_STATUSES` 一一对应，也让「读库时把脏数据降级为 idea」
/// 这类归一化只写一遍。
pub const BOOK_STATUSES: [&str; 4] = ["idea", "serializing", "paused", "completed"];

/// 每章最少字数的默认值。取 2000 而不是 0：网文单章常见区间是 2000–4000 字，
/// 这是作者提起笔就已经定好的量；默认 0 意味着新建完每本书都要先去改一次设置。
pub const DEFAULT_CHAPTER_WORDS: i64 = 2000;

pub const DEFAULT_ACCENT_COLOR: &str = "#0f6cbd";

/* 字段上限，与 TS 侧 `BOOK_LIMITS` 逐条一致 */
pub const LIMIT_TITLE: usize = 80;
pub const LIMIT_PEN_NAME: usize = 40;
pub const LIMIT_GENRE: usize = 24;
pub const LIMIT_SUMMARY: usize = 2000;
pub const LIMIT_TARGET_WORDS: i64 = 100_000_000;
pub const LIMIT_CHAPTER_WORDS: i64 = 1_000_000;

/// 列表分页上限。越界是**拒绝**（VALIDATION_ERROR），不是夹到边界。
pub const MAX_PAGE_SIZE: i64 = 200;
pub const DEFAULT_PAGE_SIZE: i64 = 60;

pub fn is_valid_status(value: &str) -> bool {
    BOOK_STATUSES.contains(&value)
}

/// 书籍本体，字段与 `books` 表一一对应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub pen_name: String,
    pub genre: String,
    pub status: String,
    pub summary: String,
    /// 目标字数，0 表示不设目标。这是整本书的量级
    pub target_words: i64,
    /// 每章最少字数，对全书每个章节都生效（编辑器底栏「计划：剩 N」按它算）
    pub chapter_words: i64,
    /// 卡片强调色，让书架有辨识度而不必真的存封面图
    pub accent_color: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 列表项 = 书籍本体 + 聚合出来的进度信息。
///
/// 刻意带上统计而不是让前端逐本再查一次：书架一屏可能有几十本，
/// 逐本查询就是标准的 N+1。这里由一条带 GROUP BY 的 SQL 一次算出来。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookListItem {
    pub id: i64,
    pub title: String,
    pub pen_name: String,
    pub genre: String,
    pub status: String,
    pub summary: String,
    pub target_words: i64,
    pub chapter_words: i64,
    pub accent_color: String,
    pub created_at: String,
    pub updated_at: String,
    pub volume_count: i64,
    pub chapter_count: i64,
    /// 全书汉字数（各章 hanzi_count 之和）
    pub hanzi_count: i64,
    pub last_edited_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookListResult {
    pub items: Vec<BookListItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub page_count: i64,
}

/// 删除书籍的回执。带上 title 与 removedChapters 是为了让提示能说清
/// 「你删掉了什么」——「已删除书籍」和「已删除《星海归途》及其 128 章」
/// 对用户的含义完全不同。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRemovalResult {
    pub id: i64,
    pub title: String,
    pub removed_chapters: i64,
}

/// 书籍级统计，用于书本详情页头部与首页概览。
///
/// `by_status` 刻意不是 `HashMap`：需要保证四个状态键**始终存在**
/// （前端直接读 `byStatus.idea`，缺键会显示 undefined）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStats {
    pub total: i64,
    pub by_status: BTreeMap<String, i64>,
    pub chapter_count: i64,
    pub volume_count: i64,
    pub hanzi_count: i64,
    pub char_count: i64,
    pub total_target_words: i64,
}

/* ------------------------------------------------------------------ *
 * 排序：白名单在服务端，客户端值先归一化再映射为列名，绝不拼进 SQL
 * ------------------------------------------------------------------ */

pub fn normalize_sort_field(value: &str) -> &'static str {
    match value {
        "title" => "title",
        "createdAt" => "createdAt",
        "hanziCount" => "hanziCount",
        // 默认按更新时间：作者最关心的是「我最近在写哪本」
        _ => "updatedAt",
    }
}

pub fn normalize_sort_order(value: &str) -> &'static str {
    if value == "asc" {
        "asc"
    } else {
        "desc"
    }
}

/// 归一化后的列表查询。仓储只认这个类型，不认原始 JSON。
#[derive(Debug, Clone)]
pub struct BookListQuery {
    pub keyword: String,
    /// None 表示不过滤
    pub status: Option<String>,
    pub page: i64,
    pub page_size: i64,
    pub sort_by: String,
    pub sort_order: String,
}

/* ------------------------------------------------------------------ *
 * 写入入参（对应 TS 侧由 zod 推导出的 `BookCreateInput` / `BookUpdateInput`）
 *
 * 这些结构体**只由命令层的解析函数产出**，字段已经是 trim 过、长度合法、
 * 值域内的结果。服务层因此可以直接落库，不必再校验一次 ——
 * 两处校验必然漂移，最后看到的现象是「有时报错、有时悄悄放行」。
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct BookCreateInput {
    pub title: String,
    pub pen_name: String,
    pub genre: String,
    pub status: String,
    pub summary: String,
    pub target_words: i64,
    pub chapter_words: i64,
    pub accent_color: String,
}

#[derive(Debug, Clone)]
pub struct BookUpdateInput {
    pub id: i64,
    pub title: String,
    pub pen_name: String,
    pub genre: String,
    pub status: String,
    pub summary: String,
    pub target_words: i64,
    pub chapter_words: i64,
    pub accent_color: String,
}
