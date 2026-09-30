//! 卡片模块的命令层。
//!
//! 只做「解析请求 → 调用服务 → 返回结果」：不含业务判断，也不吞异常 ——
//! 异常交给 `dispatch` 统一收敛成信封。
//!
//! 命令名与通道名的对应关系是**确定性映射**（`cards:set-timeline-order`
//! → `cards_set_timeline_order`），由渲染层的 `toCommandName` 生成。
//! 这里不许手写一份对照表 —— 手写表必漂移，且症状是运行期
//! 「命令不存在」而非编译期报错。

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    extra_fields, is_card_type, is_setting_category, normalize_card_sort_field,
    normalize_card_sort_order, Card, CardCreateInput, CardListQuery, CardListResult,
    CardRemovalResult, CardTimelineOrderInput, CardUpdateInput, CardWriteData, CARD_BOOK_SCOPES,
    CARD_TYPES, DEFAULT_PAGE_SIZE, LIMIT_CONTENT, LIMIT_EXTRA, LIMIT_SUBTITLE, LIMIT_TAG,
    LIMIT_TAG_COUNT, LIMIT_TITLE, MAX_PAGE_SIZE, TIMELINE_LIMIT_ITEMS,
};
use super::service;

/* ------------------------------------------------------------------ *
 * 入参解析
 * ------------------------------------------------------------------ */

/// 按 `extra_fields` 表逐个字段校验 `input.extra`。
///
/// 对应 前端动态生成的 `cardExtraSchemaFor(type)`：字段集合由类型决定，
/// 所以没法写成一个固定的 schema —— 手写四份就意味着「新增一个字段时可能
/// 只改了表、忘了改 schema」，而那样的漏改不会报错，只会让新字段的输入
/// 被静默丢弃（用户填了却存不进去）。
fn parse_extra(
    validator: &mut Validator,
    source: &Value,
    card_type: &str,
) -> BTreeMap<String, String> {
    let object = source.get("extra").and_then(|value| value.as_object());
    if object.is_none() {
        // 前端 `extra` 是必填键（`z.object({...})` 上没有 `.optional()`）：
        // 缺了它整张卡都不该被接受 —— 否则「改类型时漏传 extra」会静默
        // 把这条卡片的专属字段清空
        validator.record("extra", "缺少类型专属字段");
    }

    let mut extra = BTreeMap::new();
    for field in extra_fields(card_type) {
        let path = format!("extra.{}", field.key);
        let raw = object.and_then(|map| map.get(field.key));

        let text = match raw {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(value)) => value.trim().to_string(),
            Some(_) => {
                validator.record(&path, format!("{}必须是文本", field.label));
                String::new()
            }
        };

        if text.chars().count() > LIMIT_EXTRA {
            validator.record(&path, format!("{}最多 {LIMIT_EXTRA} 个字符", field.label));
            continue;
        }

        // 枚举字段：空串是「还没分类」，合法；有值就必须是选项之一
        if let Some(options) = field.options {
            if !text.is_empty() && !options.contains(&text.as_str()) {
                validator.record(
                    &path,
                    format!("{}只能是：{}", field.label, options.join(" / ")),
                );
                continue;
            }
        }

        extra.insert(field.key.to_string(), text);
    }

    extra
}

/// 新建与更新共用的字段解析（两者只差一个 id）。
///
/// 对应 前端的 discriminated union：**先取 cardType，才知道该收哪些专属字段**
/// —— 分支里没声明的键会被 Zod 剥掉，也就是说「给物品卡塞一个身份定位」
/// 在 IPC 边界就被拦下了，根本走不到服务层。
fn parse_card(source: &Value) -> AppResult<CardWriteData> {
    let mut validator = Validator::new(source);

    let card_type = validator.required_enum("cardType", &CARD_TYPES, "卡片类型不合法");
    let book_id = validator.optional_id("bookId", "书籍 ID 非法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "卡片标题不能为空",
        &format!("卡片标题最多 {LIMIT_TITLE} 个字符"),
    );
    let subtitle = validator.string(
        "subtitle",
        "",
        LIMIT_SUBTITLE,
        &format!("一句话简介最多 {LIMIT_SUBTITLE} 个字符"),
        &format!("一句话简介最多 {LIMIT_SUBTITLE} 个字符"),
    );
    let content = validator.string(
        "content",
        "",
        LIMIT_CONTENT,
        &format!("卡片正文最多 {LIMIT_CONTENT} 个字符"),
        &format!("卡片正文最多 {LIMIT_CONTENT} 个字符"),
    );
    let tags = validator.string_array_strict(
        "tags",
        LIMIT_TAG_COUNT,
        LIMIT_TAG,
        &format!("最多 {LIMIT_TAG_COUNT} 个标签"),
        "标签不能为空",
        &format!("单个标签最多 {LIMIT_TAG} 个字符"),
    );

    // 类型本身就不合法时不再逐字段校验 extra：前端契约里的 discriminated union
    // 在这一步只会报一条「判别值非法」，逐字段再报一串只会让表单上多出
    // 一堆与 stale 类型对应的输入框错误
    let extra = if card_type.is_empty() {
        BTreeMap::new()
    } else {
        parse_extra(&mut validator, source, &card_type)
    };

    validator.finish()?;

    Ok(CardWriteData {
        book_id,
        card_type,
        title,
        subtitle,
        content,
        tags,
        extra,
    })
}

fn parse_list_query(input: Option<Value>) -> AppResult<CardListQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    // `bookScope` 是**真的枚举**（z.string().refine(...)）：值非法直接报错。
    // 这一点与下面的 cardType 不同 —— 那一个在前端契约里只是 z.string()，
    // 非法值由后续归一化静默降级。
    let book_scope = validator.enum_value("bookScope", &CARD_BOOK_SCOPES, "all", "书籍筛选范围不合法");
    let book_id = validator.optional_id("bookId", "书籍 ID 非法");

    // 下面这四个在 zod 里都只是 `z.string()` / `z.string().trim()`，
    // **没有任何长度上限**，真正决定行为的是后面的白名单归一化。
    // 所以这里的 max 传 usize::MAX：加一个前端没有的上限会让
    // 「旧链接里带了一个超长排序值」从「静默回落」变成「页面报错」。
    let raw_card_type = validator.string("cardType", "", usize::MAX, "卡片类型不合法", "卡片类型不合法");
    let raw_category = validator.string(
        "settingCategory",
        "",
        usize::MAX,
        "设定类别不合法",
        "设定类别不合法",
    );
    let sort_by = validator.string("sortBy", "updatedAt", usize::MAX, "排序字段非法", "排序字段非法");
    let sort_order = validator.string("sortOrder", "desc", usize::MAX, "排序方向非法", "排序方向非法");

    let keyword = validator.string("keyword", "", LIMIT_TITLE, "搜索关键词过长", "搜索关键词过长");
    let page = validator.number("page", 1, 1, i64::MAX, "页码非法", "页码非法", "页码非法");
    let page_size = validator.number(
        "pageSize",
        DEFAULT_PAGE_SIZE,
        1,
        MAX_PAGE_SIZE,
        "每页条数非法",
        "每页条数非法",
        "每页最多 200 条",
    );

    validator.finish()?;

    // 「要看某本书」却没说哪本：降级为全部，而不是查出一片空白。
    // 前端切换下拉的中间态会短暂产生这种组合，此时报错没有意义。
    let scope = if book_scope == "book" && book_id.is_none() {
        "all".to_string()
    } else {
        book_scope
    };

    Ok(CardListQuery {
        book_id: if scope == "book" { book_id } else { None },
        book_scope: scope,
        // 非法类型 / 类别值静默降级为「不筛选」，与书籍列表对 status 的处理一致
        card_type: if is_card_type(&raw_card_type) {
            Some(raw_card_type)
        } else {
            None
        },
        setting_category: if is_setting_category(&raw_category) {
            Some(raw_category)
        } else {
            None
        },
        keyword,
        page,
        page_size,
        sort_by: normalize_card_sort_field(&sort_by).to_string(),
        sort_order: normalize_card_sort_order(&sort_order).to_string(),
    })
}

fn parse_timeline_order(input: Option<Value>) -> AppResult<CardTimelineOrderInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let book_id = validator.optional_id("bookId", "书籍 ID 非法");
    // 字段名是 `category`（不是列表查询里的 settingCategory）—— 与
    // 前端 cardTimelineOrderSchema 逐字对齐，改了就收不到客户端的值
    let raw_category = validator.string("category", "", usize::MAX, "设定类别不合法", "设定类别不合法");
    let ordered_ids = validator.id_array(
        "orderedIds",
        TIMELINE_LIMIT_ITEMS,
        &format!("一次最多排 {TIMELINE_LIMIT_ITEMS} 张设定卡"),
    );

    validator.finish()?;

    Ok(CardTimelineOrderInput {
        book_id,
        // 非法类别降级成「不校验类别」而不是报错：时间线视图可能横跨各类别
        category: if is_setting_category(&raw_category) {
            Some(raw_category)
        } else {
            None
        },
        ordered_ids,
    })
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn cards_list(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<CardListResult> {
    dispatch("查询卡片列表", "cards:list", || {
        let query = parse_list_query(input)?;
        let conn = state.connection()?;
        service::list(&conn, &query)
    })
}

#[tauri::command]
pub fn cards_create(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Card> {
    dispatch("新建卡片", "cards:create", || {
        let data = parse_card(&payload(input))?;
        let conn = state.connection()?;
        service::create(&conn, &CardCreateInput { data })
    })
}

#[tauri::command]
pub fn cards_update(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Card> {
    dispatch("更新卡片", "cards:update", || {
        let source = payload(input);
        let id = Validator::new(&source).id("id", "卡片 ID 非法");
        let data = parse_card(&source)?;
        let conn = state.connection()?;
        service::update(&conn, &CardUpdateInput { id, data })
    })
}

#[tauri::command]
pub fn cards_remove(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<CardRemovalResult> {
    dispatch("删除卡片", "cards:remove", || {
        let id = Validator::new(&payload(input)).id("id", "卡片 ID 非法");
        let conn = state.connection()?;
        service::remove(&conn, id)
    })
}

#[tauri::command]
pub fn cards_duplicate(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Card> {
    dispatch("复制卡片", "cards:duplicate", || {
        let id = Validator::new(&payload(input)).id("id", "卡片 ID 非法");
        let conn = state.connection()?;
        service::duplicate(&conn, id)
    })
}

#[tauri::command]
pub fn cards_set_timeline_order(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<Card>> {
    dispatch("设定卡时间线重排", "cards:set-timeline-order", || {
        let parsed = parse_timeline_order(input)?;
        let conn = state.connection()?;
        service::set_timeline_order(&conn, &parsed)
    })
}
