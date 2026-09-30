//! 章节模块的领域类型（前端对应 `src/shared/modules/chapters.ts`）。
//!
//! 一条重要的接口约定：**列表接口不返回正文**。
//! 一本书的正文可能有几十上百万字，若列表顺手把它一起拉过 IPC，
//! 书店页面每翻一页都要序列化几 MB 的字符串。因此分成两个类型：
//!   - `ChapterListItem` 列表用，只有元数据与字数
//!   - `Chapter`        详情用，带正文

use serde::Serialize;

pub const CHAPTER_STATUSES: [&str; 3] = ["draft", "revising", "done"];

pub const LIMIT_TITLE: usize = 120;
/// 正文上限按 HTML 长度算。3,000,000 个字符的 HTML 大约相当于一百五十万汉字
/// —— 已经超过任何单章的实际可能。这个值只是防止异常输入（比如误粘贴一个
/// 二进制文件）撑爆数据库，不是业务约束。
pub const LIMIT_CONTENT_HTML: usize = 3_000_000;
/// 单本书章节数上限，同样是防误操作的护栏
pub const LIMIT_PER_BOOK: i64 = 20_000;
/// 一次重排允许提交的条目数
pub const LIMIT_REORDER_BATCH: usize = 20_000;
/// 单章目标字数上限。网文单章通常 2000–4000 字，这里给足余量
pub const LIMIT_TARGET_WORDS: i64 = 1_000_000;

pub fn is_valid_status(value: &str) -> bool {
    CHAPTER_STATUSES.contains(&value)
}

/// 章节元数据。列表接口返回的就是它，不含正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterListItem {
    pub id: i64,
    pub book_id: i64,
    /// None 表示未归入任何分卷
    pub volume_id: Option<i64>,
    pub title: String,
    pub status: String,
    pub order_index: i64,
    /// 汉字数（主口径）
    pub hanzi_count: i64,
    /// 非空白字符数（含标点），用于与网文平台对照
    pub char_count: i64,
    /// 本章目标字数，0 表示未设目标。编辑器底部「计划：剩 N」用它
    pub target_words: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 章节详情，带正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: i64,
    pub book_id: i64,
    pub volume_id: Option<i64>,
    pub title: String,
    pub status: String,
    pub order_index: i64,
    pub hanzi_count: i64,
    pub char_count: i64,
    pub target_words: i64,
    pub created_at: String,
    pub updated_at: String,
    pub content_html: String,
    pub content_text: String,
}

/// 保存正文后的回执：把服务端重新算出的权威字数带回给编辑器。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSaveResult {
    pub id: i64,
    pub hanzi_count: i64,
    pub char_count: i64,
    pub updated_at: String,
}

/* ------------------------------------------------------------------ *
 * 历史版本（第三期第 4 件）
 * ------------------------------------------------------------------ */

/// 每章保留多少版、留版的阈值。
pub const REVISION_PER_CHAPTER: i64 = 50;
/// 短于这个长度的正文不留版。空段落、刚建章时打的几个字这类内容占掉配额
/// 却没人愿意回退到它 —— 配额是最稀缺的资源，留给有意义的版本。
pub const REVISION_MIN_HANZI: usize = 10;
/// 「与上一版的差异小于这个比例」时不留版。
///
/// 这是整套去重规则里最关键的一条。自动保存的粒度是**两秒**，也就是说
/// 作者每敲两三个字就会触发一次保存。若每次改动都留一版，50 版的配额会在
/// 两分钟内被填满 —— 而那 50 版全是「上一版多了一个字」，真正想找的
/// 「半小时前那一大段」早在剪枝时被挤掉了。
///
/// 取 5%：一章 3000 字时约 150 字，正好是「改了个词、补了半句」的量级；
/// 而「删掉一整段」（通常几百字）一定超过它，会被如实留下。用比例而不是
/// 绝对值，是因为同一本书里既有 500 字的短章也有 8000 字的长章。
pub const REVISION_MIN_DELTA_RATIO: f64 = 0.05;

/// 一次快照抓的是被替换掉的那个版本，也就是**改动之前**的正文。
///
/// 为什么抓「旧的」而不是「新的」：作者后悔的时刻永远是「我刚刚那一下弄坏了什么」。
/// 抓旧的，那么历史列表里的每一条都对应一次「回到这里就撤销掉了从那以后的全部改动」，
/// 语义单一。若抓新的，最新一版与当前正文重复，列表首行永远是没用的「和现在一样」。
///
/// 于是：当前正文永远不在版本列表里，列表全是可回档的过去。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRevisionSummary {
    pub id: i64,
    pub chapter_id: i64,
    /// 该版本的汉字数，列表上直接显示，不必取正文
    pub hanzi_count: i64,
    /// 该版本相对其前一版的字数增减，正为增。最早的版本为 null
    pub delta_hanzi: Option<i64>,
    pub created_at: String,
}

/// 版本详情，带当时的正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRevision {
    pub id: i64,
    pub chapter_id: i64,
    pub hanzi_count: i64,
    pub delta_hanzi: Option<i64>,
    pub created_at: String,
    pub content_html: String,
    pub content_text: String,
    pub char_count: i64,
}

/// 回档回执：把恢复后的权威字数带回给编辑器，与保存正文同形。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRestoreResult {
    pub id: i64,
    pub hanzi_count: i64,
    pub char_count: i64,
    pub updated_at: String,
    /// 回档时是否又为「回档前的正文」留了一份快照，留着就能再退回去
    pub snapshot_kept: bool,
}

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct ChapterCreateInput {
    pub book_id: i64,
    pub volume_id: Option<i64>,
    pub title: String,
    pub target_words: i64,
}

/// 元数据更新：标题、状态、所属分卷、本章目标字数。
///
/// 刻意不包含正文。正文走独立的 `saveContent`，因为两者的写入时机完全不同
/// —— 元数据是用户显式点击保存，正文是编辑器自动防抖保存。混在一个接口里
/// 会让「自动保存把用户没提交的标题改动覆盖掉」这类竞态变得难以避免。
#[derive(Debug, Clone)]
pub struct ChapterUpdateInput {
    pub id: i64,
    pub title: String,
    pub status: String,
    pub volume_id: Option<i64>,
    pub target_words: i64,
}

#[derive(Debug, Clone)]
pub struct ChapterSaveContentInput {
    pub id: i64,
    pub content_html: String,
}

#[derive(Debug, Clone)]
pub struct ChapterReorderInput {
    pub book_id: i64,
    /// 与 list 的 volume_id 同义：None 表示未分卷区间
    pub volume_id: Option<i64>,
    pub ordered_ids: Vec<i64>,
}

#[derive(Debug, Clone)]
pub struct ChapterMoveInput {
    pub id: i64,
    /// 目标分卷，None 表示移出分卷
    pub volume_id: Option<i64>,
    /// 目标位置，超出范围时会被夹到合法区间
    pub target_index: i64,
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

/// 三态：
///   `None`             → 整本书的所有章节
///   `Some(None)`       → 只列未归入分卷的章节
///   `Some(Some(id))`   → 指定分卷下的章节
///
/// 用「`Option` 套 `Option`」而不是「0 代表未分卷」：后者会在某一处忘了
/// 特判时把 `volume_id = 0` 拼进 SQL，结果是静默的空列表。
#[derive(Debug, Clone)]
pub struct ChapterListQuery {
    pub book_id: i64,
    pub volume_id: Option<Option<i64>>,
}

/// 回收站列表用的一行：章节自己的字段 + 书名与卷名。
#[derive(Debug, Clone)]
pub struct DeletedChapterRow {
    pub id: i64,
    pub title: String,
    pub book_id: i64,
    /// 这一行**当前**的 volume_id（可能因为分卷被删而变成 None）。
    /// 恢复时要用它决定落回哪个容器 —— 不能用「进回收站时的卷」。
    pub volume_id: Option<i64>,
    pub book_title: Option<String>,
    pub volume_title: Option<String>,
    pub deleted_at: String,
    pub hanzi_count: i64,
}

/// 留版基准：上一次**真正留版**时被替换掉的那份正文。
///
/// 存在的唯一理由是给版本去重提供基准（见服务层 `keep_snapshot` 的注释）。
/// 只存一章一份，因此内存占用与「正在被编辑的章节数」同阶，而不是与全书
/// 章节数同阶。进程重启后为空，由首次调用就地初始化。
/// **不做持久化**：它只是一个比较用的缓存，丢了最坏是多留一版重复内容。
#[derive(Debug, Clone)]
pub struct RevisionBaseline {
    pub content_html: String,
    pub hanzi_count: i64,
}

/// 基准表。放在 `AppState` 里而不是服务层 —— Rust 侧的服务是零大小结构体
/// （见 `state.rs` 的说明），无状态是它能在任意连接上复用的前提。
pub type RevisionBaselines = std::collections::HashMap<i64, RevisionBaseline>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterReorderResult {
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRemovalResult {
    pub id: i64,
}
