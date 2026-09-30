//! 卡片 ↔ 章节 / 大纲节点 / 卡片之间关系的契约
//! （前端对应 `src/shared/modules/card-links.ts`）。
//!
//! 单独一个模块而不是塞进 `cards`：这些是**两个聚合之间的关系**，
//! 不属于任何一方的内部契约。放哪一边都会让那一方多出一个「其实是在描述
//! 对方」的概念；独立出来之后，卡片侧与章节侧各自引用它，谁也不依赖谁。
//! （命令仍然挂在 `cards:*` 命名空间下，但通道名只是字符串，不影响分层。）
//!
//! 与章节的关联是**对称**的：一张设定卡能找到「用在哪几章」，一章也能找到
//! 「用到了哪几条设定」。两个方向共用同一份数据（card_chapter_links），
//! 因此不存在「一边改了另一边没跟上」的可能。
//!
//! 一条硬规则贯穿全模块：**两边必须属于同一本书**。跨书的关联没有意义 ——
//! 从这条设定点过去跳到另一本书的某一章，读者只会以为点错了。
//! 这条规则由服务层执行（仓储只管 SQL），因为「同一本书」是一个业务判断，
//! 不是 SQL 能表达的约束。

use serde::Serialize;

/// 一张卡片关联到的某一章（含定位用的书名与卷名）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardChapterLink {
    pub card_id: i64,
    pub chapter_id: i64,
    pub chapter_title: String,
    /// None 表示这一章还没分卷
    pub volume_title: Option<String>,
    pub book_title: String,
    pub created_at: String,
}

/// 某一章关联到的某张卡片（列表里够用即可，不重复带正文）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCardRef {
    pub card_id: i64,
    pub card_type: String,
    pub title: String,
    pub subtitle: String,
}

/// 一张卡片关联到的某个**大纲节点**。
///
/// 与「关联到章节」是两件事：章节是已经写出来的正文，节点是还没落地的构想。
/// 一条设定常常先挂在某个情节节点上（「这里要用到那条禁忌」），等那一章
/// 写出来之后再补上章节关联 —— 两者并存，不互相替代。
///
/// 带上书名：大纲是分书的，只给节点标题分不清是哪一本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardOutlineLink {
    pub card_id: i64,
    pub node_id: i64,
    pub node_title: String,
    pub node_type: String,
    pub book_title: String,
    pub created_at: String,
}

/// 某个大纲节点关联到的某张卡片。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineCardRef {
    pub card_id: i64,
    pub card_type: String,
    pub title: String,
    pub subtitle: String,
}

/* ------------------------------------------------------------------ *
 * 卡片 ↔ 卡片的关系
 * ------------------------------------------------------------------ */

/// 一张卡与另一张卡之间的关系。
///
/// 与上面两类关联（章节 / 大纲节点）有个根本差别：**关系没有方向**。
/// 两人之间是「师徒」这件事，不因从哪一头看而改变。所以一对卡之间只存一条边，
/// 建表时用 `CHECK (card_id < related_id)` 把两种写法收成一种 —— 否则
/// 「A 连 B」与「B 连 A」会存成两条边：关系图上同一个关系画两遍，
/// 界面上表现为「删掉一条还剩一条」。
///
/// 关系名是**自由文本**而不是枚举：小说里的关系写不完（师徒、宿敌、
/// 指腹为婚、欠一条命），做成下拉只会让人选不出想要的那个，最后统统
/// 落到「其它」上 —— 那等于没有分类。
///
/// 关系不只在人物之间发生：人物 ↔ 势力（设定卡）同样常见，
/// 所以这里没有「两边都必须是人物卡」的限制，只要求同书。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRelation {
    /// 被查询的那一张卡。列表里每一项都是「它 ↔ 对方」
    pub card_id: i64,
    /// 对方的卡
    pub related_id: i64,
    /// 关系名，如「师徒」
    pub relation: String,
    pub related_title: String,
    /// 对方的类型：列表上要标出来，否则「星海联邦」看不出是一张设定卡
    pub related_type: String,
    pub created_at: String,
}

/// 关系网里的一条边：两头的信息都带齐，列表与将来的图共用这一份。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRelationEdge {
    pub card_id: i64,
    pub card_title: String,
    pub card_type: String,
    pub related_id: i64,
    pub related_title: String,
    pub related_type: String,
    pub relation: String,
    pub created_at: String,
}

/// 关系名是一行标签，不是一句话。
pub const RELATION_LIMIT_LABEL: usize = 24;

/// 把一对待建立关系的卡收成「小的在前」的规范写法。
///
/// 放在契约层而不是服务层：它是这张表的**存储约定**（写入必须按它排序），
/// 属于契约的一部分；放在服务层里的话，仓储就不知道「调用方有没有排好」，
/// 而 CHECK 约束只在写入那一刻才报错。
pub fn sort_relation_pair(a: i64, b: i64) -> (i64, i64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}
