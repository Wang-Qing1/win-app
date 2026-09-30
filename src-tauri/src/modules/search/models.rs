//! 全库检索的契约（对应 TS 侧 `src/shared/modules/search.ts`）。
//!
//! 这个模块里有两块**纯计算**：`parse_keywords`（切词）与 `slice_snippet`
//! （切片 + 标高亮）。它们与 TS 版一样放在契约层而不是服务层：
//!   1. 渲染进程要用同一份切词规则即时显示「正在搜索：林澈 + 星云」，
//!      两侧各写一份必然出现「界面显示 3 个词、后端只搜了 2 个」这种对不上的情况；
//!   2. 冒烟测试可以直接对它们做单元断言，不需要起数据库。
//!
//! 检索最终走的是 LIKE 全表扫描，不是 FTS5。这个选择有实测依据：
//! 1024 万字（2000 章）的全库扫描约 52 毫秒，都在感知阈值以下；
//! 而 FTS5 在中文上有两个真实缺陷 —— `trigram` 分词器要求查询至少 3 个字符，
//! 中文人名大多只有 2 字（「林澈」「星云」），搜出来是**静默的空列表**。
//!
//! ## 下标口径：UTF-16 码元，不是字符
//!
//! `highlights` 与 `offset` 是给渲染层用的下标，而 **JS 的字符串下标是
//! UTF-16 码元**。用 Rust 的字符下标去算，在 BMP 内碰巧一致（一个汉字
//! 占 1 个码元、也是 1 个 char），但遇到补充平面的字符（CJK 扩展 B 的生僻字、
//! emoji）就会整体错位 —— 症状是片段里的高亮偏一格，或者编辑器跳到错的位置。
//! 所以下面所有下标计算都先把文本转成 `Vec<u16>`。

use std::collections::HashSet;

use serde::Serialize;

use crate::core::text::is_js_whitespace;

/* ------------------------------------------------------------------ *
 * 来源 / 字段
 * ------------------------------------------------------------------ */

/// 遍历顺序。仓储的来源表与之逐字一致；服务层照这个顺序组装分组，
/// 界面上的分组次序因此是确定的。
pub const SEARCH_SOURCE_ORDER: [&str; 4] = ["chapter", "card", "outline", "book"];

/* ------------------------------------------------------------------ *
 * 上限
 * ------------------------------------------------------------------ */

/// 原始查询串的长度上限
pub const LIMIT_RAW: usize = 120;
/// 单个关键词的长度上限
pub const LIMIT_KEYWORD: usize = 60;
/// 最多接受几个关键词。再多的话 AND 语义会让结果常年为空，不如明确收住
pub const LIMIT_KEYWORDS: usize = 6;
/// 片段上下文：锚点命中两侧各取多少字符
pub const LIMIT_CONTEXT: usize = 36;
/// 客户端可请求的每来源条数上限
pub const MAX_PER_SOURCE: i64 = 50;
/// 浮层里每来源默认展示多少条
pub const DEFAULT_PER_SOURCE: i64 = 10;

/* ------------------------------------------------------------------ *
 * 切词
 * ------------------------------------------------------------------ */

/// 按 JS 的 `\s+` 切分。
///
/// 不用 `str::split_whitespace`：两者的空白集合不同（JS 多一个 U+FEFF、
/// 少一个 U+0085），而 U+FEFF 恰好是「从网页复制一段文字」时最常见的
/// 隐形字符 —— 它没被切开的话，用户会看到一个永远搜不到的词。
fn split_js_whitespace(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start: Option<usize> = None;

    for (index, ch) in text.char_indices() {
        if is_js_whitespace(ch) {
            if let Some(from) = start.take() {
                parts.push(&text[from..index]);
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(from) = start {
        parts.push(&text[from..]);
    }

    parts
}

/// 把用户输入的查询串切成关键词数组。
///
/// 规则就是「空格分词，全部都要命中」（AND），没有引号、没有排除号 ——
/// 一个小说写作工具不需要把自己的检索语法变成一门小语言。用户真想要精确的
/// 连续匹配，多打两个字就行了（LIKE 本来就是子串匹配）。
///
/// 按**字符**截断而不是字节：一条中文占 3 字节，按字节截会砍掉三分之二。
/// （TS 那边用 `[...word]` 按码点截断，同样是为了不切断代理对。）
///
/// 去重按小写比较，但保留原大小写用于显示与高亮。
pub fn parse_keywords(raw: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<String> = Vec::new();

    for piece in split_js_whitespace(raw) {
        if piece.is_empty() {
            continue;
        }

        let word: String = piece.chars().take(LIMIT_KEYWORD).collect();
        if word.is_empty() {
            continue;
        }

        let key = word.to_lowercase();
        if !seen.insert(key) {
            continue;
        }

        result.push(word);
        if result.len() >= LIMIT_KEYWORDS {
            break;
        }
    }

    result
}

/* ------------------------------------------------------------------ *
 * 片段
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetHighlight {
    /// 相对片段起点的起始下标（UTF-16 码元）
    pub start: usize,
    /// 相对片段起点的结束下标（半开区间，UTF-16 码元）
    pub end: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 片段正文。换行已折成空格，且是 1:1 替换，因此高亮下标不受影响
    pub text: String,
    pub highlights: Vec<SnippetHighlight>,
    /// **锚点命中**在源文本里的起始下标（UTF-16 码元）。
    ///
    /// 注意它是锚点命中的位置，不是片段起点。两者差着 context 个字符，
    /// 而调用方拿它去编辑器里找「最近的一次命中」—— 若返回片段起点，
    /// 编辑器会常常选中锚点**之前**的那一次命中。
    pub offset: usize,
    /// 锚定到哪个关键词。编辑器用它在自己文档里重新定位
    pub anchor: String,
    /// 片段前面还有内容（界面据此补一个省略号）
    pub clipped_start: bool,
    /// 片段后面还有内容
    pub clipped_end: bool,
}

/// 转成 UTF-16 码元序列。所有下标计算都在这个表示上做，理由见文件头。
fn to_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[derive(Debug, Clone)]
struct RawMatch {
    start: usize,
    end: usize,
    keyword: String,
}

fn find_subslice(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&index| &haystack[index..index + needle.len()] == needle)
}

/// 在文本里找出所有关键词的全部出现位置。
///
/// 用逐段推进的朴素子串查找而不是正则：关键词是用户随手输入的，里面可能带
/// `(`、`*`、`?`、`\` 这些元字符。转义一遍当然也行，但那是在「用正则做
/// 字符串查找」—— 直接把正则去掉，从根上避免这类 bug。
/// （编辑器里的查找替换也是同样的取舍，两边行为因此天然一致。）
///
/// 大小写：与 SQL 的 LIKE 对齐 —— LIKE 对 ASCII 忽略大小写，这里也用副本比对。
/// 但 `to_lowercase()` 对个别字符会改变长度（`İ` → 两个码元），一旦长度变了，
/// 所有下标就整体错位。因此长度不一致时直接退回区分大小写，
/// 宁可少匹配也不标错位置。
fn collect_matches(haystack: &str, keywords: &[String]) -> Vec<RawMatch> {
    let lowered = haystack.to_lowercase();
    let lowered_units = to_units(&lowered);
    let hay_units = to_units(haystack);
    let case_insensitive = lowered_units.len() == hay_units.len();
    let source = if case_insensitive {
        lowered_units
    } else {
        hay_units
    };

    let mut matches: Vec<RawMatch> = Vec::new();
    for keyword in keywords {
        let needle = if case_insensitive {
            to_units(&keyword.to_lowercase())
        } else {
            to_units(keyword)
        };
        if needle.is_empty() {
            continue;
        }

        let mut cursor = 0usize;
        while let Some(found) = find_subslice(&source[cursor..], &needle) {
            let start = cursor + found;
            matches.push(RawMatch {
                start,
                end: start + needle.len(),
                keyword: keyword.clone(),
            });
            // 步进 needle.len() 而不是 1：重叠匹配（「哈哈哈」里找「哈哈」）
            // 只取第一次，与主流编辑器一致，也让片段里不会出现互相压住的下划线
            cursor = start + needle.len();
        }
    }

    matches.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)));
    matches
}

fn window_around(length: usize, item: &RawMatch, context: usize) -> (usize, usize) {
    (
        item.start.saturating_sub(context),
        (item.end + context).min(length),
    )
}

/// 窗口内覆盖了几种关键词（按小写归并，避免把同一个词的多次出现算成多种）。
fn distinct_keywords_in(matches: &[RawMatch], window: (usize, usize)) -> usize {
    let mut kinds: HashSet<String> = HashSet::new();
    for item in matches {
        if item.start >= window.0 && item.end <= window.1 {
            kinds.insert(item.keyword.to_lowercase());
        }
    }
    kinds.len()
}

/// 这段文本命中了几个**种类**的关键词（同一个词出现多次只算一个）。
///
/// 用来决定一条结果锚定在哪个字段上：标题和正文都命中时，取命中词更多的
/// 那一边做片段。出现次数不参与比较 —— 「正文里『林澈』出现 5 次、
/// 标题里『林澈』和『星云』都出现」这种情况下，用户想看的是标题那一处。
pub fn count_keyword_hits(text: &str, keywords: &[String]) -> usize {
    if text.is_empty() || keywords.is_empty() {
        return 0;
    }
    let mut kinds: HashSet<String> = HashSet::new();
    for item in collect_matches(text, keywords) {
        kinds.insert(item.keyword.to_lowercase());
    }
    kinds.len()
}

/// 切出命中片段，并给出片段内的关键词高亮区间。
///
/// 锚点选择的规则值得说明：**不是简单取第一次命中**，而是在所有命中里挑一个
/// 「以它为中心开窗，窗口内覆盖的关键词种类最多」的；并列时取最早的那个。
///
/// 为什么值得多写这个循环：既然是 AND 检索，用户真正想知道的是「这几个词
/// 在哪儿同时出现了」。固定锚定第一次命中时，片段里往往只有第一个词 ——
/// 用户看到高亮的「林澈」，却看不到自己要找的「星云」就在后面 40 个字处，
/// 会以为这软件没看懂他的查询。
pub fn slice_snippet(text: &str, keywords: &[String], context: usize) -> Option<Snippet> {
    if text.is_empty() || keywords.is_empty() {
        return None;
    }

    let units = to_units(text);
    let matches = collect_matches(text, keywords);
    if matches.is_empty() {
        return None;
    }

    let mut anchor_index = 0usize;
    let mut best_score: i64 = -1;
    for (index, candidate) in matches.iter().enumerate() {
        let score = distinct_keywords_in(&matches, window_around(units.len(), candidate, context)) as i64;
        if score > best_score {
            best_score = score;
            anchor_index = index;
        }
    }
    let anchor = matches[anchor_index].clone();
    let window = window_around(units.len(), &anchor, context);

    // 换行折成空格：content_text 里段落之间是 `\n\n`，直接展示会出现空行。
    // 用 1:1 的单字符替换而不是「压成空白」，是为了让下标保持有效 ——
    // 长度一变，下面算好的高亮区间就全部偏了。
    // 界面上不会看到两个连续空格，浏览器渲染时会把空白折叠掉。
    //
    // `from_utf16_lossy`：窗口边界正好切在一个代理对中间时会出一个孤立码元，
    // Rust 的 String 装不下它，只能替换成 U+FFFD（TS 会保留那个半字符）。
    // 补充平面的字出现在窗口切点上才会触发，视觉上无差别。
    let body = String::from_utf16_lossy(&units[window.0..window.1]).replace('\n', " ");

    let mut highlights: Vec<SnippetHighlight> = Vec::new();
    for item in &matches {
        // 只收**完整落在窗口内**的命中：被窗口边界切掉一半的关键词若也标上，
        // 界面上会出现一个只覆盖半个词的高亮，比不标更让人困惑
        if item.start < window.0 || item.end > window.1 {
            continue;
        }
        highlights.push(SnippetHighlight {
            start: item.start - window.0,
            end: item.end - window.0,
        });
    }

    Some(Snippet {
        text: body,
        highlights,
        offset: anchor.start,
        anchor: anchor.keyword.clone(),
        clipped_start: window.0 > 0,
        clipped_end: window.1 < units.len(),
    })
}

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct SearchQuery {
    pub keywords: Vec<String>,
    pub book_id: Option<i64>,
    pub limit: i64,
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub source: String,
    /// 目标条目在它自己表里的 id
    pub id: i64,
    /// 所属书籍；卡片可以是通用卡片（None），书籍信息就是它自己
    pub book_id: Option<i64>,
    /// 所属书籍的书名。
    ///
    /// 与 book_id 一样必须可空 —— **通用卡片**（`cards.book_id IS NULL`）
    /// 不属于任何一本书，界面上显示「通用卡片」而不是一个空字符串。
    pub book_title: Option<String>,
    pub title: String,
    /// 片段锚定在哪个字段上 —— 界面显示「命中：正文」
    pub field: String,
    pub snippet: String,
    pub highlights: Vec<SnippetHighlight>,
    /// 锚点命中的起始偏移，供编辑器定位
    pub offset: usize,
    /// 锚点关键词，供编辑器在自己文档里重新定位
    pub anchor: String,
    /// 该条目命中了几个关键词。AND 语义下等于查询词数，
    /// 但标题单独命中时会偏小
    pub matched_keywords: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGroup {
    pub source: String,
    pub hits: Vec<SearchHit>,
    /// 该来源命中的**总条数**，可能大于 hits.len()
    pub total: i64,
    /// 是否因为每来源上限而截断
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// 回显切词结果，让界面能显示实际生效的词条（与后端完全一致）
    pub keywords: Vec<String>,
    pub groups: Vec<SearchGroup>,
    /// 四类来源命中数之和
    pub total: i64,
}

/// 在 UTF-16 码元上截取开头一段，并把换行折成空格。
///
/// 服务层的**兜底片段**用它：那一处只需要「前 N 个码元的可展示文本」，
/// 与 `slice_snippet` 不同的是它不找出任何高亮 —— 因为压根没切出片段，
/// 说明没有任何字段在应用层匹配上（见 `service::to_hit` 的说明）。
pub fn slice_head_text(text: &str, max_units: usize) -> String {
    let units = to_units(text);
    let take = units.len().min(max_units);
    String::from_utf16_lossy(&units[..take]).replace('\n', " ")
}

/// 一行文本 + 它来自哪个字段。顺序即锚定优先级。
#[derive(Debug, Clone)]
pub struct FieldText {
    pub field: String,
    pub text: String,
}
