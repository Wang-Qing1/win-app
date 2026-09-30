//! 卡片库的领域契约（前端对应 `src/shared/modules/cards.ts`）。
//!
//! 四类卡片（人物 / 物品 / 灵感 / 设定）**共用一张 cards 表**，靠 card_type
//! 列区分：它们的共性（标题、一句话简介、正文、标签、归属书籍）占了绝大部分，
//! 差异只有几个专属字段。专属字段放进 extra 这一列 JSON，于是四套增删改查
//! 只写一遍，将来加「地点」「势力」卡也不用动表结构。
//!
//! 第四类「设定」记的是**世界观条目**，用 extra.category 区分
//! 地点 / 势力 / 规则体系 / 时间线 —— 而不是把四类拆成四种 card_type。
//! 拆成四种的话，每加一类就要动枚举、颜色、图标、筛选下拉、类型计数五处，
//! 而它们的字段与行为完全相同；做成「一类卡 + 一个类别字段」，
//! 新增类别只是往 SETTING_CATEGORIES 里加一个词。
//!
//! 这个选择的代价必须自己补上：**extra 里的字段没有数据库层面的约束**，
//! 一个字段名写错、或把人物卡的 extra 直接搬到物品卡上，SQLite 不会吭声。
//! 所以下面这张 CARD_EXTRA_FIELDS 表是唯一的字段来源，它同时驱动三件事：
//!   1. 命令边界的校验（`super::commands::parse_extra`）
//!   2. 编辑面板渲染哪些输入框（前端仍然用它自己的那份 TS 常量）
//!   3. 类型切换时的字段迁移（本文件的 `normalize_extra`）
//! 一处新增字段，三处自动跟上 —— 这是统一建模能成立的前提。

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

pub const CARD_TYPES: [&str; 4] = ["character", "item", "inspiration", "setting"];

/// 类型的中文名。只在冲突文案里出现（「已经有叫「林澈」的人物卡了」）。
pub fn card_type_label(card_type: &str) -> &'static str {
    match card_type {
        "character" => "人物",
        "item" => "物品",
        "inspiration" => "灵感",
        _ => "设定",
    }
}

/// 设定卡的类别。
///
/// 四类世界观条目共用「设定」这一种卡片：地点的写法是「在哪儿、什么规矩」，
/// 势力是「谁、图什么」，规则体系是「能做什么、代价是什么」，时间线是
/// 「什么时候发生了什么」—— 它们的结构一致，只是**读的人关心的问题**不同。
pub const SETTING_CATEGORIES: [&str; 4] = ["地点", "势力", "规则体系", "时间线"];

/// 设定卡「时点」的键。时间线视图与后端排序读的是同一个键，避免各处写裸字符串。
pub const SETTING_TIME_POINT_KEY: &str = "timePoint";
/// 设定卡「时间线序号」的键。由时间线视图的上下移动写入，不出现在表单里。
pub const SETTING_ORDER_KEY: &str = "order";

pub fn is_card_type(value: &str) -> bool {
    CARD_TYPES.contains(&value)
}

pub fn is_setting_category(value: &str) -> bool {
    SETTING_CATEGORIES.contains(&value)
}

/* ------------------------------------------------------------------ *
 * 类型专属字段
 * ------------------------------------------------------------------ */

/// 一个类型专属字段的声明。字段含义与 前端 `CardExtraField` 一一对应。
pub struct CardExtraField {
    pub key: &'static str,
    pub label: &'static str,
    /// 隐藏字段没有输入框，也就不需要占位文案（见 `hidden` 的说明）。
    /// Rust 侧只做校验，不渲染表单，因此暂时没有读取点。
    #[allow(dead_code)]
    pub placeholder: Option<&'static str>,
    /// 取值被限定在这几个选项里时，界面渲染成下拉而不是输入框。
    ///
    /// 用途是「这一栏填的是分类」而不是「这一栏填的是自由发挥的一句话」：
    /// 类别要能按它聚合（四张地点卡凑成地理篇），自由输入会写成「地点」
    /// 「地理位置」「地名」三种说法，聚合就废了。
    pub options: Option<&'static [&'static str]>,
    /// 只存值、不在表单里渲染。
    ///
    /// 给「界面不该让人手填、但数据要落在这张卡上」的字段用 —— 目前只有
    /// 设定卡的时间线排序号：它由时间线视图的上下移动写入，手填一个数字
    /// 既没有意义（作者关心的是先后，不是具体数值），也很容易填成重复值。
    ///
    /// Rust 侧只做校验、不渲染表单（表单在渲染层，用它自己的那份常量），
    /// 因此这个标志在这里没有读取点 —— 保留它是为了让这张表与 前端
    /// 逐字段对齐，将来导出 / 生成表单时要用。
    #[allow(dead_code)]
    pub hidden: bool,
}

/// 人物卡的字段里**没有「关系」**：关系是指向另一张卡的关联
/// （card_relations 表），编辑面板下方有专门的一块。留一个纯文本字段的话，
/// 两边会各记一份互相矛盾的关系。
const CHARACTER_EXTRA_FIELDS: [CardExtraField; 3] = [
    CardExtraField {
        key: "identity",
        label: "身份定位",
        placeholder: Some("如：星舰工程师 / 流亡贵族"),
        options: None,
        hidden: false,
    },
    CardExtraField {
        key: "affiliation",
        label: "所属阵营",
        placeholder: Some("如：星海联邦第七舰队"),
        options: None,
        hidden: false,
    },
    CardExtraField {
        key: "appearance",
        label: "外貌特征",
        placeholder: Some("如：左眉有一道旧疤"),
        options: None,
        hidden: false,
    },
];

const ITEM_EXTRA_FIELDS: [CardExtraField; 3] = [
    CardExtraField {
        key: "grade",
        label: "品阶",
        placeholder: Some("如：传说级 / 一次性消耗品"),
        options: None,
        hidden: false,
    },
    CardExtraField {
        key: "origin",
        label: "来源",
        placeholder: Some("如：遗迹出土 / 主角自制"),
        options: None,
        hidden: false,
    },
    CardExtraField {
        key: "effect",
        label: "作用与代价",
        placeholder: Some("如：短距跃迁，冷却一整天"),
        options: None,
        hidden: false,
    },
];

const INSPIRATION_EXTRA_FIELDS: [CardExtraField; 2] = [
    CardExtraField {
        key: "source",
        label: "灵感来源",
        placeholder: Some("如：一条新闻 / 一个梦"),
        options: None,
        hidden: false,
    },
    CardExtraField {
        key: "usage",
        label: "打算用在哪儿",
        placeholder: Some("如：第三卷的转折点"),
        options: None,
        hidden: false,
    },
];

const SETTING_EXTRA_FIELDS: [CardExtraField; 3] = [
    CardExtraField {
        key: "category",
        label: "设定类别",
        placeholder: Some("这条设定属于哪一类"),
        options: Some(&SETTING_CATEGORIES),
        hidden: false,
    },
    // 时点是**自由文本**而不是日期：虚构世界的计时方式五花八门
    // （星历 2103 年、霜降之月、开战前三天），强行套 ISO 日期只会让人
    // 把「星历 2103」写成 2103-01-01 然后自己都不信。排序另有一个隐藏的
    // 序号字段 —— 时点是给人看的，先后是给机器排的，两者分开。
    CardExtraField {
        key: SETTING_TIME_POINT_KEY,
        label: "时点",
        placeholder: Some("如：星历 2103 年 / 开战前三天"),
        options: None,
        hidden: false,
    },
    CardExtraField {
        key: SETTING_ORDER_KEY,
        label: "时间线序号",
        placeholder: None,
        options: None,
        hidden: true,
    },
];

/// 取某一类卡片的专属字段表。
///
/// 认不出的类型回落到「设定」：调用方传进来的类型一定已经过校验
/// （`is_card_type`），这里的兜底只是为了让函数是完备的 —— 与 前端
/// `CARD_EXTRA_FIELDS[type]` 在非法类型下会拿到 `undefined` 不同，
/// Rust 里必须回一个真实存在的表。
pub fn extra_fields(card_type: &str) -> &'static [CardExtraField] {
    match card_type {
        "character" => &CHARACTER_EXTRA_FIELDS,
        "item" => &ITEM_EXTRA_FIELDS,
        "inspiration" => &INSPIRATION_EXTRA_FIELDS,
        _ => &SETTING_EXTRA_FIELDS,
    }
}

/// 把任意的 extra 收敛成目标类型的字段集合。
///
/// **这是统一建模里最关键的一个函数**：它同时做两件事 ——
/// 丢掉不属于该类型的键（人物卡改成物品卡后，旧的「身份定位」必须消失，
/// 否则数据里会留着一个永远不会被界面显示、但会被导出带走的幽灵字段），
/// 以及补齐缺失的键（老数据、手工改库、新增字段后都靠它兜底）。
///
/// 写入与读取两侧都走它，因此「数据库里的 extra 一定是当前类型的完整字段集」
/// 这条不变式只有一处实现。
///
/// 带 `options` 的字段额外做一步：**不在选项里的值一律回落成空串**。
/// 类别是要被聚合的，一个拼错的「地理」会永远聚合不到「地点」那一组里，
/// 而它看起来又完全正常（有值、能显示）。宁可让它空着 —— 空着是
/// 「这条还没分类」，一眼看得出来，错了却没人知道。
///
/// 非字符串取值一律当空串：extra 的每个字段都是一行摘要，
/// 出现数字 / 布尔说明这行数据是别处写坏的（见 `db::sql_utils::parse_json`）。
pub fn normalize_extra(card_type: &str, raw: Option<&Value>) -> BTreeMap<String, String> {
    let source = raw.and_then(|value| value.as_object());

    let mut extra = BTreeMap::new();
    for field in extra_fields(card_type) {
        let text = source
            .and_then(|map| map.get(field.key))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or("");

        if let Some(options) = field.options {
            if !text.is_empty() && !options.contains(&text) {
                extra.insert(field.key.to_string(), String::new());
                continue;
            }
        }
        extra.insert(field.key.to_string(), text.to_string());
    }
    extra
}

/// 把**已经规范化过的字段集合**再投影一次。
///
/// 读路径上拿到的 `extra` 已经是干净的 `BTreeMap`，而复制卡片、准备写入时
/// 要的还是同一个投影动作。把「map → Value → 再投影」这层转换收在这里，
/// 调用方就不必为了再走一次 `normalize_extra` 而手工拼一个 JSON 对象。
pub fn renormalize_extra(
    card_type: &str,
    extra: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let value = Value::Object(
        extra
            .iter()
            .map(|(key, text)| (key.clone(), Value::String(text.clone())))
            .collect(),
    );
    normalize_extra(card_type, Some(&value))
}

/// 标签规范化：去首尾空白、丢掉空标签、去重。
///
/// 放在契约层而不是服务层：前端在输入框里解析标签时也用同一份规则，
/// 否则会出现「输入时显示 3 个标签、保存后变成 2 个」的不一致。
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for raw in tags {
        let tag = raw.trim();
        if tag.is_empty() || !seen.insert(tag.to_string()) {
            continue;
        }
        result.push(tag.to_string());
    }

    result
}

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: i64,
    /// None 表示通用卡片（不归属任何书）—— 灵感常常如此
    pub book_id: Option<i64>,
    pub card_type: String,
    pub title: String,
    /// 一句话简介：列表里只占一行，比截断正文更有信息量
    pub subtitle: String,
    pub content: String,
    pub tags: Vec<String>,
    /// 值集合由 `CARD_EXTRA_FIELDS` 决定；用 BTreeMap 是为了**稳定输出**
    /// （前端按 `Object.keys(extra).sort()` 比对时，顺序必须确定）
    pub extra: BTreeMap<String, String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardListResult {
    pub items: Vec<Card>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub page_count: i64,
    /// 按类型计数，**忽略 cardType 这一项筛选**。
    ///
    /// 这是刻意的：若把类型筛选也算进去，选中「人物」之后另外几类的数字
    /// 会全变成 0，「物品 0 张」会让人以为物品卡没了，而不是「被筛掉了」。
    /// 它是一组导航用的计数，不是当前结果集的分解。
    pub type_counts: BTreeMap<String, i64>,
    /// 设定卡按类别计数（忽略 settingCategory 这一项筛选），同理。
    pub setting_counts: BTreeMap<String, i64>,
    /// 当前筛选条件下不归属任何书的卡片数，用于提示「其中通用 N 张」
    pub global_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRemovalResult {
    pub id: i64,
    pub title: String,
}

/* ------------------------------------------------------------------ *
 * 筛选与排序
 * ------------------------------------------------------------------ */

/// 书籍筛选范围。
///
/// 用三个值而不是「bookId 为 null 就是全部」：卡片允许不归属书籍，
/// 于是「全部书籍」与「只看通用卡片」是两种不同的查询，
/// 而它们都没法用 bookId 是数字还是 null 单独表达出来。
pub const CARD_BOOK_SCOPES: [&str; 3] = ["all", "book", "global"];

/// 非法排序字段回落 `updatedAt`（而不是报错）：与书籍列表同一取舍 ——
/// 旧链接里带来的排序值不该让整个卡片页打不开。
///
/// 注意这与「边界校验」是两回事：`sortBy` 在 前端只是 `z.string()`，
/// 没有任何值域限制，所以这里**不能**换成会记账报错的枚举校验，
/// 否则一本排序值是旧版本留下的书会让整个列表变成错误页。
pub fn normalize_card_sort_field(value: &str) -> &'static str {
    match value {
        "createdAt" => "createdAt",
        "title" => "title",
        _ => "updatedAt",
    }
}

pub fn normalize_card_sort_order(value: &str) -> &'static str {
    if value == "asc" {
        "asc"
    } else {
        "desc"
    }
}

/* ------------------------------------------------------------------ *
 * 字段与上限
 * ------------------------------------------------------------------ */

pub const LIMIT_TITLE: usize = 80;
pub const LIMIT_SUBTITLE: usize = 120;
/// 单张卡片的正文上限。定成 5000 是因为它随列表一起返回。
pub const LIMIT_CONTENT: usize = 5000;
pub const LIMIT_TAG: usize = 24;
pub const LIMIT_TAG_COUNT: usize = 12;
/// 单个类型专属字段的上限。它们本来就是一行摘要，不该写成一段。
pub const LIMIT_EXTRA: usize = 120;

pub const DEFAULT_PAGE_SIZE: i64 = 60;
pub const MAX_PAGE_SIZE: i64 = 200;

/// 一次能重排多少张设定卡。数量级是几十条，200 是宽容的上限不是预期值。
pub const TIMELINE_LIMIT_ITEMS: usize = 200;

/* ------------------------------------------------------------------ *
 * 入参 / 查询
 * ------------------------------------------------------------------ */

/// 待写入的一行（新建与更新共用）。`extra` 与 `tags` 都是**已经规范化过**的
/// 值，由服务层准备好再传给仓储 —— 「写进库里的 extra 一定是完整字段集」
/// 这条不变式只有服务层一处实现。
#[derive(Debug, Clone)]
pub struct CardWriteData {
    pub book_id: Option<i64>,
    pub card_type: String,
    pub title: String,
    pub subtitle: String,
    pub content: String,
    pub tags: Vec<String>,
    pub extra: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct CardCreateInput {
    pub data: CardWriteData,
}

#[derive(Debug, Clone)]
pub struct CardUpdateInput {
    pub id: i64,
    pub data: CardWriteData,
}

#[derive(Debug, Clone)]
pub struct CardListQuery {
    pub book_scope: String,
    /// 仅当 book_scope 为 'book' 时有意义
    pub book_id: Option<i64>,
    /// None 表示不按类型筛选
    pub card_type: Option<String>,
    /// None 表示不按类别筛选。
    ///
    /// 只有设定卡的 extra 里有 category 键，所以这一项**隐含了「只看设定卡」**
    /// —— 界面上选类别时会顺手把类型定成设定，否则「人物 + 地点」会查出一片
    /// 空白，而空白看起来跟「这本书还没有设定」一模一样。
    pub setting_category: Option<String>,
    pub keyword: String,
    pub page: i64,
    pub page_size: i64,
    pub sort_by: String,
    pub sort_order: String,
}

#[derive(Debug, Clone)]
pub struct CardTimelineOrderInput {
    pub book_id: Option<i64>,
    /// None 表示不校验类别（时间线视图可能横跨各类别）
    pub category: Option<String>,
    pub ordered_ids: Vec<i64>,
}
