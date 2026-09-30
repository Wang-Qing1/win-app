//! 书籍模块的命令层（对应 TS 侧 `book.controller.ts`）。
//!
//! 只做「解析请求 → 调用服务 → 返回结果」：不含业务判断，也不吞异常 ——
//! 异常交给 `dispatch` 统一收敛成信封。
//!
//! 「书本不存在」不在这里判断，而是交给服务层：控制器无法知道当前是查询
//! 还是写入语境，只有服务层清楚哪种情况下该抛 NOT_FOUND。

use serde_json::Value;
use tauri::State;

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    is_valid_status, normalize_sort_field, normalize_sort_order, Book, BookCreateInput,
    BookListQuery, BookListResult, BookRemovalResult, BookStats, BookUpdateInput,
    DEFAULT_ACCENT_COLOR, DEFAULT_CHAPTER_WORDS, DEFAULT_PAGE_SIZE, LIMIT_CHAPTER_WORDS,
    LIMIT_GENRE, LIMIT_PEN_NAME, LIMIT_SUMMARY, LIMIT_TARGET_WORDS, LIMIT_TITLE, MAX_PAGE_SIZE,
    BOOK_STATUSES,
};
use super::service;

/* ------------------------------------------------------------------ *
 * 入参解析
 * ------------------------------------------------------------------ */

fn parse_list_query(input: Option<Value>) -> AppResult<BookListQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let keyword = validator.string("keyword", "", LIMIT_TITLE, "搜索关键词过长", "搜索关键词过长");

    // 状态筛选：空串与 null 都表示「不筛选」。之所以两种都收，
    // 是因为渲染端的规范类型用 null 表达这个语义，而 IPC 传的就是它。
    let raw_status = validator.string(
        "status",
        "",
        32,
        "状态筛选值非法",
        "状态筛选值非法",
    );

    let page = validator.number(
        "page",
        1,
        1,
        i64::MAX,
        "页码非法",
        "页码非法",
        "页码非法",
    );

    let page_size = validator.number(
        "pageSize",
        DEFAULT_PAGE_SIZE,
        1,
        MAX_PAGE_SIZE,
        "每页条数非法",
        "每页条数非法",
        "每页最多 200 条",
    );

    let sort_by = validator.string("sortBy", "updatedAt", 32, "排序字段非法", "排序字段非法");
    let sort_order = validator.string("sortOrder", "desc", 8, "排序方向非法", "排序方向非法");

    validator.finish()?;

    Ok(BookListQuery {
        keyword,
        // 非法状态值**静默降级为「不筛选」**而不是报错：URL 里带过来的旧值
        // 不该让整个书架页面打不开（TS 侧 normalizeBookListQuery 的既有取舍）
        status: is_valid_status(&raw_status).then_some(raw_status),
        page,
        page_size,
        sort_by: normalize_sort_field(&sort_by).to_string(),
        sort_order: normalize_sort_order(&sort_order).to_string(),
    })
}

fn parse_create(input: Option<Value>) -> AppResult<BookCreateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "书名不能为空",
        &format!("书名最多 {LIMIT_TITLE} 个字符"),
    );
    let pen_name = validator.string(
        "penName",
        "",
        LIMIT_PEN_NAME,
        &format!("笔名最多 {LIMIT_PEN_NAME} 个字符"),
        &format!("笔名最多 {LIMIT_PEN_NAME} 个字符"),
    );
    let genre = validator.string(
        "genre",
        "",
        LIMIT_GENRE,
        &format!("题材最多 {LIMIT_GENRE} 个字符"),
        &format!("题材最多 {LIMIT_GENRE} 个字符"),
    );
    let status = validator.enum_value("status", &BOOK_STATUSES, "idea", "书本状态不合法");
    let summary = validator.string(
        "summary",
        "",
        LIMIT_SUMMARY,
        &format!("简介最多 {LIMIT_SUMMARY} 个字符"),
        &format!("简介最多 {LIMIT_SUMMARY} 个字符"),
    );
    let target_words = validator.number(
        "targetWords",
        0,
        0,
        LIMIT_TARGET_WORDS,
        "目标字数必须是整数",
        "目标字数不能为负",
        "目标字数超出合理范围",
    );
    let chapter_words = validator.number(
        "chapterWords",
        DEFAULT_CHAPTER_WORDS,
        0,
        LIMIT_CHAPTER_WORDS,
        "每章最少字数必须是整数",
        "每章最少字数不能为负",
        "每章最少字数超出合理范围",
    );
    let accent_color = validator.hex_color("accentColor", DEFAULT_ACCENT_COLOR, "强调色必须是 #RGB 或 #RRGGBB 格式");

    validator.finish()?;

    Ok(BookCreateInput {
        title,
        pen_name,
        genre,
        status,
        summary,
        target_words,
        chapter_words,
        accent_color,
    })
}

/// 更新是**整体替换**：表单本来就是整体提交的，避免出现
/// 「部分字段 undefined 该不该覆盖」的歧义。所以除 id 外全部必填。
fn parse_update(input: Option<Value>) -> AppResult<BookUpdateInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let id = validator.id("id", "书籍 ID 非法");
    let title = validator.required_string(
        "title",
        LIMIT_TITLE,
        "书名不能为空",
        &format!("书名最多 {LIMIT_TITLE} 个字符"),
    );
    let pen_name = validator.string(
        "penName",
        "",
        LIMIT_PEN_NAME,
        &format!("笔名最多 {LIMIT_PEN_NAME} 个字符"),
        &format!("笔名最多 {LIMIT_PEN_NAME} 个字符"),
    );
    let genre = validator.string(
        "genre",
        "",
        LIMIT_GENRE,
        &format!("题材最多 {LIMIT_GENRE} 个字符"),
        &format!("题材最多 {LIMIT_GENRE} 个字符"),
    );
    let status = validator.required_enum("status", &BOOK_STATUSES, "书本状态不合法");
    let summary = validator.string(
        "summary",
        "",
        LIMIT_SUMMARY,
        &format!("简介最多 {LIMIT_SUMMARY} 个字符"),
        &format!("简介最多 {LIMIT_SUMMARY} 个字符"),
    );
    let target_words = validator.number(
        "targetWords",
        0,
        0,
        LIMIT_TARGET_WORDS,
        "目标字数必须是整数",
        "目标字数不能为负",
        "目标字数超出合理范围",
    );
    let chapter_words = validator.number(
        "chapterWords",
        DEFAULT_CHAPTER_WORDS,
        0,
        LIMIT_CHAPTER_WORDS,
        "每章最少字数必须是整数",
        "每章最少字数不能为负",
        "每章最少字数超出合理范围",
    );
    let accent_color = validator.hex_color("accentColor", DEFAULT_ACCENT_COLOR, "强调色必须是 #RGB 或 #RRGGBB 格式");

    validator.finish()?;

    Ok(BookUpdateInput {
        id,
        title,
        pen_name,
        genre,
        status,
        summary,
        target_words,
        chapter_words,
        accent_color,
    })
}

/* ------------------------------------------------------------------ *
 * 命令
 *
 * 函数名与通道名的对应关系是**确定性映射**（`books:list` → `books_list`），
 * 由渲染层的 `toCommandName` 生成。这里不许手写一份对照表 ——
 * 手写表必漂移，且症状是运行期「命令不存在」而非编译期报错。
 * ------------------------------------------------------------------ */

#[tauri::command]
pub fn books_list(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<BookListResult> {
    dispatch("查询书籍列表", "books:list", || {
        let query = parse_list_query(input)?;
        let conn = state.connection()?;
        service::list(&conn, &query)
    })
}

#[tauri::command]
pub fn books_get(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Book> {
    dispatch("查询书籍详情", "books:get", || {
        let id = Validator::new(&payload(input)).id("id", "书籍 ID 非法");
        let conn = state.connection()?;
        service::get_by_id(&conn, id)
    })
}

#[tauri::command]
pub fn books_create(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Book> {
    dispatch("新增书籍", "books:create", || {
        let parsed = parse_create(input)?;
        let conn = state.connection()?;
        service::create(&conn, &parsed)
    })
}

#[tauri::command]
pub fn books_update(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<Book> {
    dispatch("更新书籍", "books:update", || {
        let parsed = parse_update(input)?;
        let conn = state.connection()?;
        service::update(&conn, &parsed)
    })
}

#[tauri::command]
pub fn books_remove(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<BookRemovalResult> {
    dispatch("删除书籍", "books:remove", || {
        let id = Validator::new(&payload(input)).id("id", "书籍 ID 非法");
        let conn = state.connection()?;
        service::remove(&conn, id)
    })
}

#[tauri::command]
pub fn books_stats(state: State<'_, AppState>) -> IpcResponse<BookStats> {
    dispatch("查询书籍统计", "books:stats", || {
        let conn = state.connection()?;
        service::stats(&conn)
    })
}
