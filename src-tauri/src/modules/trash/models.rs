//! 回收站的共享契约（对应 TS 侧 `src/shared/modules/trash.ts`）。
//!
//! 单个契约描述**两种互不相干的实体**（卡片与章节），这是刻意的：
//! 回收站是一个动作面，不是一种数据。若把「列回收站」「恢复」「彻底删除」
//! 分别塞进 cards 与 chapters 两个模块，界面上那一个列表就要同时向两边
//! 要数据、再自己拼起来排序，而「按删除时间倒序」在两边各写一半的结果是不稳定的。
//!
//! 为什么只有两种而不是更多：
//!   - 书籍与分卷是容器，删除走 CASCADE，语义是「连同内容一起清掉」；
//!   - 大纲节点是树，删一个父节点连坐整棵子树。
//! 这两类要进回收站各自需要独立的语义（整本书怎么恢复？子树恢复到哪里？），
//! 硬塞进来只会让这一份契约变成一堆 `if kind == ...`。

use std::collections::BTreeMap;

use serde::Serialize;

pub const TRASH_KINDS: [&str; 2] = ["card", "chapter"];

/// 回收站页一次最多列出多少条。
///
/// 不做真分页：回收站是「翻一翻、把误删的捞回来」的地方，条目数在几十的量级；
/// 而删除时间越久远的条目越没人看，截断不会挡住任何真实的操作。超过上限时
/// 界面会明说「仅显示最近 N 条，共 M 条」—— 静默截断会让用户以为「只剩下这些了」，
/// 那正好是回收站最不该有的歧义。
pub const TRASH_ITEMS_LIMIT: i64 = 500;

pub fn is_trash_kind(value: &str) -> bool {
    TRASH_KINDS.contains(&value)
}

/// 单个实体的模块（卡片 / 章节）对外能给出的一条回收站记录。
///
/// 少了 `kind`：那是「回收站」这一层才知道的概念，卡片服务不该知道自己
/// 这行将来会被摆在哪种列表里。装配由 TrashService 负责。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: i64,
    pub title: String,
    /// 卡片：一句话简介；章节：所属分卷名（未分卷时为空串）
    pub subtitle: String,
    /// 卡片可能不归属任何书（通用卡片），章节一定有书
    pub book_id: Option<i64>,
    pub book_title: Option<String>,
    /// 删除时刻。列表按它倒序 —— 用户找的是「刚才手滑删掉的那个」
    pub deleted_at: String,
    /// 卡片：类型（人物 / 物品 / 灵感 / 设定）；章节恒为 None
    pub card_type: Option<String>,
    /// 删除时的汉字数。章节用它（作者认章节靠字数）；卡片恒为 0
    pub hanzi_count: i64,
}

/// 回收站列表里的一行 = 条目 + 它属于哪种实体。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub kind: String,
    #[serde(flatten)]
    pub entry: TrashEntry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashListResult {
    /// 按删除时间倒序，最多 `TRASH_ITEMS_LIMIT` 条
    pub items: Vec<TrashItem>,
    /// **当前 kind 筛选下**的条目总数，可能大于 `items.len()`（被上限截断）
    pub total: i64,
    /// 两种各自多少条，**忽略 kind 这一项筛选**。
    ///
    /// 与卡片列表的 typeCounts 同一个道理：它是导航用的数字，不是当前
    /// 结果集的分解。把筛选也算进去的话，切到「章节」页签之后
    /// 「卡片 0 条」会读成「卡片被删光了」，而不是「被筛掉了」。
    pub kind_counts: BTreeMap<String, i64>,
}

/// 指向回收站里某一条的回执。恢复与彻底删除共用同一个形状：
/// 界面这两种提示都要写出「《某某》…」，「那一条是谁」是同一件事。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemRef {
    pub kind: String,
    pub id: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEmptyResult {
    /// 真正删掉了多少条
    pub removed: i64,
    pub removed_cards: i64,
    pub removed_chapters: i64,
}
