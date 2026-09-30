//! 大纲模块的领域类型（前端对应 `src/shared/modules/outline.ts`）。
//!
//! 结构是**自由多层情节树**：节点可以任意嵌套（主线 → 支线 → 事件 → …），
//! 与「卷 / 章」的物理结构彼此独立 —— 大纲是**写作前的构思**，卷章是
//! **成稿的容器**，两者不是一回事：一条支线可能横跨三章，一个卷里也可能
//! 同时跑着主线和两条支线。
//!
//! 两种结构靠一个可选的关联打通：节点可以「落地」成真实章节
//! （`chapter_id` 指向它），落地的节点在树上会显示章节标题，点一下就能跳进编辑器。

use std::collections::BTreeMap;

use serde::Serialize;

/// 节点在情节里承担的角色。
///
/// 数据库列的默认值是 `'plot'`，但**所有写入都会显式带上 node_type**，
/// 因此那个默认值只是手工插数据时的兜底，不会出现在正常流程里。
pub const NODE_TYPES: [&str; 6] = ["main", "sub", "event", "foreshadow", "twist", "note"];
/// 写作进度，由作者自己推进；与关联章节的状态是两件事，互不覆盖。
pub const STATUSES: [&str; 4] = ["planned", "writing", "done", "dropped"];

pub const LIMIT_TITLE: usize = 120;
pub const LIMIT_SUMMARY: usize = 2000;
/// 单本书的节点总数上限。防止误操作（比如脚本循环调用）把界面拖垮
pub const LIMIT_PER_BOOK: i64 = 2000;
/// 树的层级上限（根层为 1）。
///
/// 自由树不设上限的话，拖拽误操作能造出几百层嵌套 —— 树组件会因为每层的
/// 缩进把内容挤成一条竖线，而且拖拽换算下标的递归深度也随之失控。
/// 12 层对小说大纲远远够用（主线 → 卷段 → 章 → 场景 → 细节 通常不超过 6 层）。
pub const LIMIT_DEPTH: i64 = 12;

pub fn is_valid_node_type(value: &str) -> bool {
    NODE_TYPES.contains(&value)
}

pub fn is_valid_status(value: &str) -> bool {
    STATUSES.contains(&value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub id: i64,
    pub book_id: i64,
    /// None 表示位于树的根层
    pub parent_id: Option<i64>,
    /// 落地到的章节；None 表示还只是个构想
    pub chapter_id: Option<i64>,
    pub node_type: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 树节点。
///
/// `children` 由服务层用一次查询的结果在内存里组装，**不是**逐层递归查数据库
/// —— 那样一个三层大纲就要发几十次查询。
///
/// 关联章节的标题与状态随树一起返回：树上要显示「已落地 →《第一章》」，
/// 否则前端得为每个节点再查一次章节，而章节列表又是按整本书取的，
/// 为了几十个节点把全书章节拉一遍不划算。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineTreeNode {
    pub id: i64,
    pub book_id: i64,
    pub parent_id: Option<i64>,
    pub chapter_id: Option<i64>,
    pub node_type: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
    pub children: Vec<OutlineTreeNode>,
    pub chapter_title: Option<String>,
    pub chapter_status: Option<String>,
    /// 子孙节点总数（不含自身）。删除前用它提示「将同时删除 N 个子节点」
    pub descendant_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineTreeResult {
    pub book_id: i64,
    pub nodes: Vec<OutlineTreeNode>,
    /// 节点总数（含所有层级）
    pub total: i64,
    /// 实际达到的最大层级，根层为 1；空树为 0
    pub depth: i64,
    pub status_counts: BTreeMap<String, i64>,
    pub type_counts: BTreeMap<String, i64>,
    /// 已落地成章节的节点数
    pub landed_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineRemovalResult {
    pub id: i64,
    /// 连同子节点一起被删除的节点总数（含自身）。文案里要提示用户
    pub removed_count: i64,
}

/// 落地操作的回执：带上新章节 id，前端据此跳进编辑器。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineMaterializeResult {
    pub node_id: i64,
    pub chapter_id: i64,
    pub chapter_title: String,
}

/* ---------------- 入参 ---------------- */

#[derive(Debug, Clone)]
pub struct OutlineNodeCreateInput {
    pub book_id: i64,
    /// 父节点。根层节点传的就是 None。
    pub parent_id: Option<i64>,
    pub node_type: String,
    pub title: String,
    pub summary: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct OutlineNodeUpdateInput {
    pub id: i64,
    pub node_type: String,
    pub title: String,
    pub summary: String,
    pub status: String,
}

/// 移动节点（拖拽落点的实现）。
///
/// 与章节移动同样的思路：调用方只给「目标父节点 + 落点下标」，两个父节点下的
/// 新顺序都由服务层基于**当前数据库状态**算出来，不接受客户端提交顺序 ——
/// 否则并发拖拽时，客户端手里的旧树会覆盖别人的改动。
///
/// 目标下标越界会被夹到合法区间，不报错：拖到空白处落点常常算得偏大，
/// 为此弹一个错误框没有意义。
#[derive(Debug, Clone)]
pub struct OutlineNodeMoveInput {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub target_index: i64,
}

/// 关联 / 解除关联章节。`chapter_id` 为 None 表示解除：
/// 节点保留，只是不再指向任何章节。
#[derive(Debug, Clone)]
pub struct OutlineAttachChapterInput {
    pub id: i64,
    pub chapter_id: Option<i64>,
}

/// 把节点落地成**新章节**（创建章节 + 建立关联），一步到位。
#[derive(Debug, Clone)]
pub struct OutlineMaterializeInput {
    pub id: i64,
    /// 新章节放进哪个分卷，None 表示未分卷
    pub volume_id: Option<i64>,
    pub target_words: i64,
}

/* ---------------- 仓储行 ---------------- */

/// 一行原始数据。
///
/// 这里刻意**不做树形组装** —— 仓储只负责把整本书的节点平铺取回来，
/// 组装、深度计算、环检测全部交给服务层在内存里做。原因是这些判断都需要
/// 「看到全貌」：环检测要顺着 parent 指针往上走，深度校验要知道目标父节点的
/// 层数。逐节点单独查数据库会让这些判断变成 N 次往返，而且中途还可能读到
/// 别人改过的中间状态。单本书的节点上限是 2000，一次全取的内存开销可以忽略。
#[derive(Debug, Clone)]
pub struct OutlineNodeRow {
    pub id: i64,
    pub book_id: i64,
    pub parent_id: Option<i64>,
    pub chapter_id: Option<i64>,
    pub node_type: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
    /// LEFT JOIN 章节得到，未落地时为 None
    pub chapter_title: Option<String>,
    pub chapter_status: Option<String>,
}
