//! 检索仓储。
//!
//! 只负责 SQL 与行 → 中间结构的映射，不含任何「怎么切片段」的判断。
//! 四张表的结构差异在这一层被抹平：每个来源都产出同一种
//! `{ id, bookId, bookTitle, title, updatedAt, hits, fields[] }`，
//! 服务层因此只需要一个循环，不需要按来源分支 —— 将来再加一个来源
//! （比如「写作会话备注」）时，改动只落在这个文件和那份来源表上。

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, Row};

use crate::core::errors::AppResult;
use crate::db::sql_utils::{contains_pattern, parse_string_array, to_number};

use super::models::{FieldText, SearchQuery};

/// 字段在 SQL 里的列名 + 它在契约里的字段名。
struct FieldSpec {
    column: &'static str,
    field: &'static str,
}

/// 一个来源的检索描述。
///
/// `fields` 的顺序有意义：它是**片段锚定的优先级** —— 正文排在标题前面，
/// 因为用户找的通常是一段话，而不是一个标题（标题命中会单独显示在结果里）。
struct SourceSpec {
    source: &'static str,
    /// FROM 子句，含 LEFT JOIN 出来的 book_title
    from: &'static str,
    /// 用于 bookId 过滤的列；books 表用自己
    book_column: &'static str,
    /// 这个来源的**固定范围条件**，恒为真时留空。
    ///
    /// 目前只有卡片与章节用到它：回收站里的东西不参与全库检索。
    /// 不这么做的话，作者删掉一张卡、再搜它的名字，结果里照样躺着那条记录
    /// —— 而且点进去打不开（详情接口按 id 取的是活着的行）。
    /// 用户会认为「删除没生效」。与列表侧用同一个判据（`deleted_at IS NULL`），
    /// 因此「搜不到」与「列表里看不到」永远同步。
    scope: &'static str,
    fields: &'static [FieldSpec],
    /// books 来源：bookId 与 bookTitle 取自己那一行
    self_book: bool,
}

const CHAPTER_FIELDS: [FieldSpec; 2] = [
    FieldSpec {
        column: "t.content_text",
        field: "content",
    },
    FieldSpec {
        column: "t.title",
        field: "title",
    },
];

const CARD_FIELDS: [FieldSpec; 4] = [
    FieldSpec {
        column: "t.content",
        field: "content",
    },
    FieldSpec {
        column: "t.subtitle",
        field: "subtitle",
    },
    FieldSpec {
        column: "t.tags",
        field: "tags",
    },
    FieldSpec {
        column: "t.title",
        field: "title",
    },
];

const OUTLINE_FIELDS: [FieldSpec; 2] = [
    FieldSpec {
        column: "t.summary",
        field: "summary",
    },
    FieldSpec {
        column: "t.title",
        field: "title",
    },
];

const BOOK_FIELDS: [FieldSpec; 4] = [
    FieldSpec {
        column: "t.summary",
        field: "summary",
    },
    FieldSpec {
        column: "t.genre",
        field: "genre",
    },
    FieldSpec {
        column: "t.pen_name",
        field: "penName",
    },
    FieldSpec {
        column: "t.title",
        field: "title",
    },
];

const SOURCES: [SourceSpec; 4] = [
    SourceSpec {
        source: "chapter",
        from: "chapters t LEFT JOIN books b ON b.id = t.book_id",
        book_column: "t.book_id",
        scope: "t.deleted_at IS NULL",
        fields: &CHAPTER_FIELDS,
        self_book: false,
    },
    SourceSpec {
        source: "card",
        from: "cards t LEFT JOIN books b ON b.id = t.book_id",
        book_column: "t.book_id",
        scope: "t.deleted_at IS NULL",
        fields: &CARD_FIELDS,
        self_book: false,
    },
    SourceSpec {
        source: "outline",
        from: "outline_nodes t LEFT JOIN books b ON b.id = t.book_id",
        book_column: "t.book_id",
        scope: "",
        fields: &OUTLINE_FIELDS,
        self_book: false,
    },
    SourceSpec {
        source: "book",
        from: "books t",
        book_column: "t.id",
        scope: "",
        fields: &BOOK_FIELDS,
        self_book: true,
    },
];

/// 行 → 服务层消费的中间结构。
pub struct SearchSourceRow {
    pub id: i64,
    pub book_id: Option<i64>,
    pub book_title: Option<String>,
    pub title: String,
    pub updated_at: String,
    /// 该来源命中的总条数，由窗口函数在同一次扫描里算出（同一页里每行都一样）
    pub hits: i64,
    /// 字段名 → 已折成可展示文本的内容，顺序即锚定优先级
    pub fields: Vec<FieldText>,
}

pub struct SearchSourcePage {
    pub rows: Vec<SearchSourceRow>,
    pub total: i64,
    pub truncated: bool,
}

/// 标签列是 JSON 字符串（`["主角团","领航员"]`），直接当片段展示会带着
/// 方括号和引号，很难看。这里折成「主角团、领航员」。
///
/// 折完之后关键词仍然是它的子串（搜「主角团」照样找得到），
/// 所以片段切片不会因为这一步而失去锚点 —— 除了「SQL 匹配的是 JSON 原文、
/// 而展示文本对不上」这一种情况，服务层有兜底（见 `to_hit`）。
fn display_tags(raw: &str) -> String {
    parse_string_array(raw).join("、")
}

/// 拼检索条件。
///
/// 语义是「**每个关键词都要在某个字段里命中**」，也就是 AND 套 OR：
///
/// ```text
/// 词1 出现在任一字段  AND  词2 出现在任一字段  AND  …
/// ```
///
/// （这段必须标 `text`：不标时 rustdoc 会把它当成 Rust 去编译，
/// 于是 `cargo test` 会在 doctest 阶段报解析错误 —— 而 `cargo check` 一声不吭。）
///
/// 这是全文检索的通行做法，也符合直觉：搜「林澈 星云」想找的是同时提到
/// 这两者的地方，而不是分别提到两者之一的所有地方。跨字段算命中 ——
/// 一个词落在标题、另一个落在正文，同样算这条记录同时满足两个词。
///
/// 关键词一律经 `contains_pattern` 转义并配 `ESCAPE '\'`：
/// 不转义时搜「100%」会退化成「以 100 开头的一切」，搜「_」会变成
/// 「任意一个字符」—— 结果看起来「能搜到东西」，所以这种 bug 很难被发现。
fn build_condition(spec: &SourceSpec, query: &SearchQuery, params: &mut Vec<Value>) -> String {
    let mut clauses: Vec<String> = Vec::new();

    // 来源自己的固定范围（回收站排除），排在最前 —— 它恒为真，
    // 与关键词、书籍筛选之间是 AND，位置不影响语义，
    // 只在读 SQL 时先声明范围
    if !spec.scope.is_empty() {
        clauses.push(spec.scope.to_string());
    }

    for keyword in &query.keywords {
        params.push(Value::Text(contains_pattern(keyword)));
        let ors = spec
            .fields
            .iter()
            .map(|field| format!("{} LIKE ? ESCAPE '\\'", field.column))
            .collect::<Vec<_>>()
            .join(" OR ");
        clauses.push(format!("({ors})"));
    }

    if let Some(book_id) = query.book_id {
        clauses.push(format!("{} = ?", spec.book_column));
        params.push(Value::Integer(book_id));
    }

    // 关键词至少有一个（服务层对空查询提前返回），所以这里不会是空串；
    // 真出现空串时补一个恒真条件，免得拼出 `WHERE` 后面什么都没有的语法错
    if clauses.is_empty() {
        return "1 = 1".to_string();
    }
    clauses.join(" AND ")
}

fn read_row(spec: &SourceSpec, row: &Row<'_>) -> rusqlite::Result<SearchSourceRow> {
    let mut fields: Vec<FieldText> = Vec::with_capacity(spec.fields.len());
    for field in spec.fields {
        let raw: Option<String> = row.get(field.field)?;
        let text = raw.unwrap_or_default();
        let text = if field.field == "tags" {
            display_tags(&text)
        } else {
            text
        };
        fields.push(FieldText {
            field: field.field.to_string(),
            text,
        });
    }

    Ok(SearchSourceRow {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        book_title: row.get("book_title")?,
        title: row.get("title")?,
        updated_at: row.get("updated_at")?,
        hits: to_number(row.get::<_, Option<i64>>("hits")?),
        fields,
    })
}

/// 查一个来源。
///
/// 只有**一条** SELECT，靠窗口函数 `COUNT(*) OVER ()` 在同一个游标里同时
/// 拿到「命中总数」和「本页若干行」。分成两条 SQL（一条 COUNT、一条取行）
/// 意味着对正文多扫一遍 —— 全库 1000 万字时那一遍是 50 毫秒，
/// 而窗口函数是免费的。窗口函数在逻辑执行顺序上早于 LIMIT，
/// 因此它统计的是**筛选后的全部行**，不受 LIMIT 影响。
///
/// 多取一条（`limit + 1`）用来判断是否截断：比再跑一次计数便宜，
/// 而且天然与 LIMIT 口径一致。
pub fn search_source(
    conn: &Connection,
    source: &str,
    query: &SearchQuery,
) -> AppResult<SearchSourcePage> {
    let Some(spec) = SOURCES.iter().find(|item| item.source == source) else {
        return Ok(SearchSourcePage {
            rows: Vec::new(),
            total: 0,
            truncated: false,
        });
    };

    let mut params: Vec<Value> = Vec::new();
    let condition = build_condition(spec, query, &mut params);

    // 字段别名一律加引号：`penName` 这种驼峰列名不加引号会被 SQLite
    // 当成另一个名字，`row.get("penName")` 就会报「没有这一列」
    let columns = spec
        .fields
        .iter()
        .map(|field| format!("{} AS \"{}\"", field.column, field.field))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "SELECT t.id AS id,
                {} AS book_id,
                {} AS book_title,
                t.title AS title,
                t.updated_at AS updated_at,
                COUNT(*) OVER () AS hits,
                {columns}
           FROM {}
          WHERE {condition}
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT ? OFFSET 0",
        if spec.self_book { "t.id" } else { "t.book_id" },
        if spec.self_book { "t.title" } else { "b.title" },
        spec.from
    );

    let mut list_params = params;
    list_params.push(Value::Integer(query.limit + 1));

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(list_params.iter()), |row| read_row(spec, row))?;
    let mut collected: Vec<SearchSourceRow> = rows.collect::<Result<Vec<_>, _>>()?;

    // hits 是窗口函数算出来的，同一页里每一行都一样，取第一行的即可
    let total = collected.first().map(|item| item.hits).unwrap_or(0);
    let truncated = collected.len() as i64 > query.limit;
    if truncated {
        collected.truncate(query.limit.max(0) as usize);
    }

    Ok(SearchSourcePage {
        rows: collected,
        total,
        truncated,
    })
}
