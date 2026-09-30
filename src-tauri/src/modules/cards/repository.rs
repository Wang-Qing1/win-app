//! 卡片仓储（对应 TS 侧 `card.repository.ts`）。
//!
//! 只负责 SQL 与行↔领域对象映射，不含任何业务判断。判断都在 `service.rs`，
//! 于是「同书同类型不能重名」「extra 必须按类型投影」这类规则只有一份实现。

use std::collections::BTreeMap;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};

use crate::core::errors::AppResult;
use crate::db::sql_utils::{contains_pattern, parse_json, parse_string_array, to_number};

use super::models::{
    is_card_type, is_setting_category, normalize_extra, normalize_tags, Card, CardListQuery,
    CardWriteData, CARD_TYPES, SETTING_CATEGORIES,
};

const SELECT_COLUMNS: &str =
    "id, book_id, card_type, title, subtitle, content, tags, extra, created_at, updated_at";

/// 排序列白名单。
/// 客户端传来的 sortBy 已在契约层归一化，这里再映射成真实列名 ——
/// 从不把客户端字符串拼进 SQL。
fn sort_column(sort_by: &str) -> &'static str {
    match sort_by {
        "createdAt" => "created_at",
        "title" => "title COLLATE NOCASE",
        _ => "updated_at",
    }
}

/// 一行 → 领域对象。
///
/// `card_type` / `tags` / `extra` 三列在数据库里都是自由的 TEXT/JSON，
/// 这里统一做一次收敛：认不出的类型退回「灵感」，坏掉的 JSON 退回空集，
/// extra 则按类型投影成完整字段集。
///
/// 退回「灵感」而不是「人物」是因为它的专属字段最少 —— 脏数据摊到它头上
/// 只会多出几个空输入框，而摊到人物卡上会凭空长出一组误导性的身份字段。
fn read_card(row: &Row<'_>) -> rusqlite::Result<Card> {
    let raw_type: String = row.get("card_type")?;
    let card_type = if is_card_type(&raw_type) {
        raw_type
    } else {
        "inspiration".to_string()
    };

    let raw_tags: String = row.get("tags")?;
    let raw_extra: String = row.get("extra")?;
    let extra_value = parse_json(&raw_extra);

    Ok(Card {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        card_type: card_type.clone(),
        title: row.get("title")?,
        subtitle: row.get("subtitle")?,
        content: row.get("content")?,
        tags: normalize_tags(&parse_string_array(&raw_tags)),
        extra: normalize_extra(&card_type, extra_value.as_ref()),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 回收站列表用的一行：卡片自己的字段 + 书名。
#[derive(Debug, Clone)]
pub struct DeletedCardRow {
    pub id: i64,
    pub title: String,
    pub subtitle: String,
    pub book_id: Option<i64>,
    pub book_title: Option<String>,
    pub deleted_at: String,
    /// 原样透传，服务层收敛成 CardType —— 与 `read_card` 同一口径
    pub card_type: String,
}

/// 一页数据 + 分页数字。
///
/// 分页数学放在仓储而不是服务层：页码要基于**筛选后的总数**夹紧，
/// 拆成两处会让「第 3 页填不满时该显示第几页」这类边界出现两个版本。
pub struct PagedCards {
    pub items: Vec<Card>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub page_count: i64,
}

/// 把查询条件拼成 WHERE 子句。
///
/// 抽出来是因为同一套筛选条件要被跑五次：取本页数据、取总数、取各类型计数、
/// 取设定卡各类别计数、取通用卡片计数。五处各写一遍的话，任何一处漏掉一个
/// 条件都会让「总数」与「实际列出的条数」对不上，而且界面看起来完全正常
/// （只是数字略大）。
///
/// 两个开关都是给**计数**用的：计数是导航用的数字，不是当前结果集的分解，
/// 所以每组计数都要忽略自己那一维 —— 否则选中「时间线」之后另外三类
/// 会全变成 0，读起来像「那些设定被删了」，而不是「被筛掉了」。
///   - `include_type = false`     → 算各类型数量时忽略「类型」这一项
///   - `include_category = false` → 算各类别数量时忽略「类别」这一项
fn build_filter(
    query: &CardListQuery,
    include_type: bool,
    include_category: bool,
) -> (String, Vec<Value>) {
    // 回收站：默认只看「还在」的卡片。
    //
    // 这一条放在这里而不是每个条件里，是因为它必须在**每一个**走
    // build_filter 的查询里都出现 —— 漏掉任何一处都会让「计数」与
    // 「列出的条数」对不上，而界面上看起来完全正常（只是数字略大）。
    let mut conditions: Vec<String> = vec!["deleted_at IS NULL".to_string()];
    let mut params: Vec<Value> = Vec::new();

    // 书籍范围。
    //
    // 「仅通用卡片」必须写成 `book_id IS NULL` 而不是 `book_id = NULL`：
    // 后者在 SQL 里永远不成立（NULL = NULL 既不是真也不是假），
    // 症状是「通用卡片一张都查不出来」，且不报任何错。
    if query.book_scope == "global" {
        conditions.push("book_id IS NULL".to_string());
    } else if query.book_scope == "book" {
        if let Some(book_id) = query.book_id {
            conditions.push("book_id = ?".to_string());
            params.push(Value::Integer(book_id));
        }
    }

    if include_type {
        if let Some(card_type) = &query.card_type {
            conditions.push("card_type = ?".to_string());
            params.push(Value::Text(card_type.clone()));
        }
    }

    // 设定卡类别。
    //
    // 只比对 `extra` 里的 category，不额外加 `card_type = 'setting'`：
    // 只有设定卡的 extra 里有这个键（契约层的 normalize_extra 按类型投影），
    // 其它类型的 json_extract 一律得到 NULL，NULL 不等于任何类别值，
    // 于是自动被排除 —— 少写一个条件，就少一处会与类型筛选打架的地方。
    //
    // `json_valid` 是必要的护栏：extra 是 TEXT 列，数据库不会替我们保证
    // 它是合法 JSON。一旦出现一行脏数据，json_extract 会直接抛
    // 「malformed JSON」，把整张列表炸掉 —— 而不是只跳过那一行。
    if include_category {
        if let Some(category) = &query.setting_category {
            conditions.push(
                "(json_valid(extra) AND json_extract(extra, '$.category') = ?)".to_string(),
            );
            params.push(Value::Text(category.clone()));
        }
    }

    if !query.keyword.is_empty() {
        // 标题、简介、正文、标签都参与搜索：卡片库的价值恰恰在于
        // 「记得有这么张卡、但想不起叫什么」时还能找回来。
        //
        // LIKE 的通配符必须转义（contains_pattern 里做），否则用户搜 `100%`
        // 会变成「以 100 开头的一切」，搜 `_` 会变成「任意一个字符」——
        // 结果看起来是「能搜到东西」，所以这种 bug 通常很久都没人发现。
        conditions.push(
            "(title LIKE ? ESCAPE '\\'
               OR subtitle LIKE ? ESCAPE '\\'
               OR content LIKE ? ESCAPE '\\'
               OR tags LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        let pattern = contains_pattern(&query.keyword);
        for _ in 0..4 {
            params.push(Value::Text(pattern.clone()));
        }
    }

    (format!("WHERE {}", conditions.join(" AND ")), params)
}

pub fn list_paged(conn: &Connection, query: &CardListQuery) -> AppResult<PagedCards> {
    let (where_clause, filter_params) = build_filter(query, true, true);

    let total = to_number(conn.query_row(
        &format!("SELECT COUNT(*) AS total FROM cards {where_clause}"),
        params_from_iter(filter_params.iter()),
        |row| row.get::<_, Option<i64>>(0),
    )?);

    let page_count = if total == 0 {
        0
    } else {
        (total + query.page_size - 1) / query.page_size
    };
    let safe_page = if page_count == 0 {
        1
    } else {
        query.page.min(page_count)
    };
    let offset = (safe_page - 1) * query.page_size;

    let direction = if query.sort_order == "asc" { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT {SELECT_COLUMNS}
           FROM cards
           {where_clause}
          ORDER BY {} {direction}, id DESC
          LIMIT ? OFFSET ?",
        sort_column(&query.sort_by)
    );

    let mut list_params = filter_params.clone();
    list_params.push(Value::Integer(query.page_size));
    list_params.push(Value::Integer(offset));

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(list_params.iter()), read_card)?;
    let items = rows.collect::<Result<Vec<_>, _>>()?;

    Ok(PagedCards {
        items,
        total,
        page: safe_page,
        page_size: query.page_size,
        page_count,
    })
}

/// 按类型计数（忽略 cardType 筛选，见 build_filter 的说明）。
///
/// 用一条 GROUP BY 而不是对每个类型各查一次：多次查询之间若发生写入，
/// 各数字之和就可能不等于总数，界面上「人物 1 + 物品 1 + 灵感 2 ≠ 共 3」
/// 会让人怀疑整个数据。
pub fn count_by_type(conn: &Connection, query: &CardListQuery) -> AppResult<BTreeMap<String, i64>> {
    let (where_clause, params) = build_filter(query, false, false);

    let mut counts: BTreeMap<String, i64> =
        CARD_TYPES.iter().map(|t| (t.to_string(), 0)).collect();

    let mut statement = conn.prepare(&format!(
        "SELECT card_type AS card_type, COUNT(*) AS n
           FROM cards
           {where_clause}
          GROUP BY card_type"
    ))?;
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        Ok((
            row.get::<_, String>("card_type")?,
            row.get::<_, Option<i64>>("n")?,
        ))
    })?;

    for row in rows {
        let (card_type, n) = row?;
        // 认不出的类型不进任何一格：它们会被 read_card 归到「灵感」，
        // 但这里若也归进去，「灵感」的计数就会与实际列出的条数不符
        if is_card_type(&card_type) {
            counts.insert(card_type, to_number(n));
        }
    }

    Ok(counts)
}

/// 设定卡按类别计数（忽略 settingCategory 筛选，见 build_filter 的说明）。
///
/// 同样一条 GROUP BY 出全部类别，理由与 count_by_type 相同。
/// `json_valid` 那层 CASE 必不可少：GROUP BY 会对每一行求值，
/// 一行坏掉的 extra 会让整条查询抛错，而不是只跳过那一行。
/// 认不出的类别（含 NULL，即未分类的设定卡）不进任何一格 ——
/// 「未分类」不是一类，它只是还没填。
pub fn count_by_setting_category(
    conn: &Connection,
    query: &CardListQuery,
) -> AppResult<BTreeMap<String, i64>> {
    let (where_clause, params) = build_filter(query, true, false);

    let mut counts: BTreeMap<String, i64> = SETTING_CATEGORIES
        .iter()
        .map(|c| (c.to_string(), 0))
        .collect();

    let mut statement = conn.prepare(&format!(
        "SELECT CASE WHEN json_valid(extra) THEN json_extract(extra, '$.category') END AS category,
                COUNT(*) AS n
           FROM cards
           {where_clause}
          GROUP BY category"
    ))?;
    // category 用 Value 而不是 String 接：json_extract 的返回值类型取决于
    // 数据里存的是什么，一行脏数据（比如 `\"category\": 3`）会让
    // `row.get::<String>` 直接报 InvalidColumnType，把整张列表炸掉。
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        Ok((
            row.get::<_, Option<Value>>("category")?,
            row.get::<_, Option<i64>>("n")?,
        ))
    })?;

    for row in rows {
        let (category, n) = row?;
        if let Some(Value::Text(category)) = category {
            if is_setting_category(&category) {
                counts.insert(category, to_number(n));
            }
        }
    }

    Ok(counts)
}

/// 不受书籍范围影响的「通用卡片」计数：只看当前的其它筛选条件。
pub fn count_global(conn: &Connection, query: &CardListQuery) -> AppResult<i64> {
    let scoped = CardListQuery {
        book_scope: "global".to_string(),
        ..query.clone()
    };
    let (where_clause, params) = build_filter(&scoped, true, true);

    Ok(to_number(conn.query_row(
        &format!("SELECT COUNT(*) AS total FROM cards {where_clause}"),
        params_from_iter(params.iter()),
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 按 id 取**还在回收站外**的卡片。
///
/// 刻意不提供「无论死活都取」的重载：调用方要么是在处理一张活卡片
/// （编辑、复制、建关联），要么是在处理回收站里的条目（恢复、彻底删除），
/// 这两种诉求各有一个语义明确的方法（见 `find_deleted_by_id`）。
/// 若用 `include_deleted: bool` 这类开关，任何一处忘了传就会让
/// 「编辑一张已删除的卡」和「把一张活卡片彻底删掉」都成为可能，
/// 而这两件事都不会报错。
pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<Card>> {
    let mut statement =
        conn.prepare(&format!("SELECT {SELECT_COLUMNS} FROM cards WHERE id = ? AND deleted_at IS NULL"))?;
    let mut rows = statement.query_map([id], read_card)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 按 id 取**回收站里**的卡片。恢复与彻底删除的唯一入口。
pub fn find_deleted_by_id(conn: &Connection, id: i64) -> AppResult<Option<DeletedCardRow>> {
    conn.query_row(
        "SELECT c.id AS id, c.title AS title, c.subtitle AS subtitle,
                c.book_id AS book_id, b.title AS book_title,
                c.deleted_at AS deleted_at, c.card_type AS card_type
           FROM cards c
           LEFT JOIN books b ON b.id = c.book_id
          WHERE c.id = ? AND c.deleted_at IS NOT NULL",
        [id],
        |row| {
            Ok(DeletedCardRow {
                id: row.get("id")?,
                title: row.get("title")?,
                subtitle: row.get("subtitle")?,
                book_id: row.get("book_id")?,
                book_title: row.get("book_title")?,
                deleted_at: row.get("deleted_at")?,
                card_type: row.get("card_type")?,
            })
        },
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.into()),
    })
}

/// 业务唯一性校验：**同一本书、同一类型**下标题不可重名（不区分大小写）。
///
/// 为什么把范围收紧到「同书 + 同类型」：
///   - 不同书里出现同名的「林澈」完全正常（同一角色在不同书稿里）；
///   - 人物卡与灵感卡同名也无所谓，本就是两类东西。
/// 这条规则挡的是「手滑又建了一张一模一样的卡」——多建一张就再也删不干净，
/// 因为两张卡看起来毫无区别。
///
/// `book_id IS ?` 而不是 `= ?`：`= NULL` 恒不成立，会让**通用卡片之间的查重
/// 静默失效**（建十张同名通用灵感卡都不报错）。SQLite 的 `IS` 是 NULL 安全的比较。
///
/// `exclude_id` 传 -1 表示「不排除任何行」：id 是自增主键、恒为正数，
/// 因此 `id <> -1` 恒成立。这样比「有没有 exclude_id 就拼两种 SQL」少一条分支。
///
/// 只跟**还在回收站外**的卡片比标题：一张卡被删掉之后，它的名字理应重新可用
/// —— 否则会出现最气人的那种局面，「我把那张卡删了，为什么还说重名？」
/// 而用户根本看不到那张卡在哪。
pub fn find_by_title(
    conn: &Connection,
    book_id: Option<i64>,
    card_type: &str,
    title: &str,
    exclude_id: i64,
) -> AppResult<Option<Card>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS}
           FROM cards
          WHERE book_id IS ?
            AND card_type = ?
            AND title = ? COLLATE NOCASE
            AND id <> ?
            AND deleted_at IS NULL
          LIMIT 1"
    ))?;

    let book_param = match book_id {
        Some(id) => Value::Integer(id),
        None => Value::Null,
    };
    let mut rows = statement.query_map(
        params_from_iter(
            [
                book_param,
                Value::Text(card_type.to_string()),
                Value::Text(title.to_string()),
                Value::Integer(exclude_id),
            ]
            .iter(),
        ),
        read_card,
    )?;

    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 复制卡片时用来生成不撞名的标题。同样只看还在的卡片，理由见 `find_by_title`。
pub fn list_titles(
    conn: &Connection,
    book_id: Option<i64>,
    card_type: &str,
) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT title FROM cards WHERE book_id IS ? AND card_type = ? AND deleted_at IS NULL",
    )?;
    let book_param = match book_id {
        Some(id) => Value::Integer(id),
        None => Value::Null,
    };
    let rows = statement.query_map(
        params_from_iter([book_param, Value::Text(card_type.to_string())].iter()),
        |row| row.get::<_, String>("title"),
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn insert(conn: &Connection, data: &CardWriteData, now: &str) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO cards (book_id, card_type, title, subtitle, content, tags, extra, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            data.book_id,
            data.card_type,
            data.title,
            data.subtitle,
            data.content,
            serde_json::to_string(&data.tags)?,
            serde_json::to_string(&data.extra)?,
            now,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, data: &CardWriteData, now: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE cards
            SET book_id = ?, card_type = ?, title = ?, subtitle = ?,
                content = ?, tags = ?, extra = ?, updated_at = ?
          WHERE id = ?",
        params![
            data.book_id,
            data.card_type,
            data.title,
            data.subtitle,
            data.content,
            serde_json::to_string(&data.tags)?,
            serde_json::to_string(&data.extra)?,
            now,
            id
        ],
    )?;
    Ok(changed > 0)
}

/// 时间线重排：只改 extra 里的序号键，不动其它字段。
///
/// 刻意**不更新 updated_at**：序号是「排列方式」而不是卡片内容，
/// 而列表默认按 updated_at 倒序 —— 改了它，调一次序就把这一组卡片
/// 全顶到列表最前面，看上去像「这些卡刚被改过」。
///
/// `json_valid` 那层 CASE 不是多余的防御：extra 只是一列 TEXT，
/// 数据库不保证它是合法 JSON，而 json_set 遇到坏 JSON 会整条语句报错，
/// 让「调序」这个动作整体失败。坏行就回退成只装序号的对象 ——
/// 那张卡的其它专属字段本来也已经读不出来了（read_card 会补成空串）。
pub fn set_timeline_order(conn: &Connection, entries: &[(i64, i64)]) -> AppResult<()> {
    let mut statement = conn.prepare(
        "UPDATE cards
            SET extra = CASE WHEN json_valid(extra)
                             THEN json_set(extra, '$.order', ?)
                             ELSE json_object('order', ?) END
          WHERE id = ?",
    )?;

    for (id, order) in entries {
        // 序号存成字符串：extra 的其它字段都是字符串，混进一个数字会让
        // 「读 extra」这一侧多出一条 typeof 分支
        let value = order.to_string();
        statement.execute(params![value, value, id])?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 回收站
 *
 * 四个动作分成两组，命名上刻意让「软」与「硬」一眼可分：
 *   soft_delete / restore_by_id  —— 只改 deleted_at，数据一直在
 *   purge_by_id / purge_all      —— 真的 DELETE，此行之后无法恢复
 * 「删除」在前端指的是前者；后者只由回收站里的「彻底删除」触发。
 *
 * 每条写语句都带上 `deleted_at IS [NOT] NULL` 作为**第二道闸**：
 * 服务层已经校验过状态，但那道校验与这条语句之间存在时间差，
 * 而且真正决定「会发生什么」的是 SQL。把状态写进 WHERE 之后，
 * 「把一张已删除的卡再删一次」与「把一张活卡片彻底删掉」在语句层面
 * 就不成立（changes == 0），不依赖调用方是否记得先读一遍。
 * ------------------------------------------------------------------ */

pub fn soft_delete(conn: &Connection, id: i64, now: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE cards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        params![now, id],
    )?;
    Ok(changed > 0)
}

/// 从回收站恢复。
///
/// **同时把 updated_at 推到当下**，这与「删除」刻意不动它是相反的处理 ——
/// 卡片列表默认按 updated_at 倒序，恢复后不动它，刚捞回来的卡会沉在
/// 列表底部（用的是删除前的旧时间戳），用户看到的是「点了恢复但没出现」。
/// 删除则相反：那是一个「让东西消失」的动作，没有任何列表会因此
/// 把它顶到前面去，不该顺手改时间。
pub fn restore_by_id(conn: &Connection, id: i64, now: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE cards
            SET deleted_at = NULL, updated_at = ?
          WHERE id = ? AND deleted_at IS NOT NULL",
        params![now, id],
    )?;
    Ok(changed > 0)
}

/// 彻底删除。关联（章节 / 大纲节点 / 卡片关系）随外键 CASCADE 一起消失。
pub fn purge_by_id(conn: &Connection, id: i64) -> AppResult<bool> {
    let changed = conn.execute("DELETE FROM cards WHERE id = ? AND deleted_at IS NOT NULL", [id])?;
    Ok(changed > 0)
}

/// 清空回收站。`deleted_at IS NOT NULL` 恒在 —— 见上面第二道闸的说明。
pub fn purge_all(conn: &Connection) -> AppResult<i64> {
    Ok(conn.execute("DELETE FROM cards WHERE deleted_at IS NOT NULL", [])? as i64)
}

/// 回收站里的卡片，最近删除的在前。
///
/// 连同书名一起取：回收站是跨书混排的，只有「『林澈』人物卡」这一半信息
/// 根本认不出是哪个项目里的那张 —— 而恢复恰恰要求用户先认出来。
/// 书名用 LEFT JOIN：通用卡片（book_id 为 NULL）也必须出现在回收站里，
/// 用 JOIN 会让它们整批消失。
pub fn list_deleted(conn: &Connection, limit: i64) -> AppResult<Vec<DeletedCardRow>> {
    let mut statement = conn.prepare(
        "SELECT c.id AS id, c.title AS title, c.subtitle AS subtitle,
                c.book_id AS book_id, b.title AS book_title,
                c.deleted_at AS deleted_at, c.card_type AS card_type
           FROM cards c
           LEFT JOIN books b ON b.id = c.book_id
          WHERE c.deleted_at IS NOT NULL
          ORDER BY c.deleted_at DESC, c.id DESC
          LIMIT ?",
    )?;
    let rows = statement.query_map([limit], |row| {
        Ok(DeletedCardRow {
            id: row.get("id")?,
            title: row.get("title")?,
            subtitle: row.get("subtitle")?,
            book_id: row.get("book_id")?,
            book_title: row.get("book_title")?,
            deleted_at: row.get("deleted_at")?,
            card_type: row.get("card_type")?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn count_deleted(conn: &Connection) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM cards WHERE deleted_at IS NOT NULL",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}
