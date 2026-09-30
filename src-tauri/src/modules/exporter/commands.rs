//! 导出的命令层。
//!
//! 三个命令都跑在**独立线程**上（`#[tauri::command(async)]`），这
//! 不是为了并发，而是为了离开主线程：`service::save_draft` 里的
//! `blocking_save_file` 是「把对话框回调的结果经通道传回来」的同步等待，
//! 跑在事件循环线程上会自己等自己（Tauri 的文档明确要求别在主线程调它）。
//!
//! 为什么不直接写 `async fn`：那样 Tauri 会把命令体包成一个必须 `'static`
//! 的 future，于是 `State<'_, AppState>` 这种带生命周期的入参就进不了签名
//! （编译期报 "async commands that contain references as inputs must return
//! a `Result`"）。改成 `#[tauri::command(async)]` + 同步函数体，既拿到
//! 「派到线程池」的效果，又能在函数体内从 `AppHandle` 取 state ——
//! 这部分借用发生在 future 内部，不参与 `'static` 检查。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::core::dispatch::dispatch;
use crate::core::errors::AppResult;
use crate::core::input::{payload, Validator};
use crate::core::logger;
use crate::core::response::IpcResponse;
use crate::state::AppState;

use super::models::{
    ExportBatchResult, ExportBookInput, ExportChapterInput, ExportChapterResult, ExportVolumeInput,
    EXPORT_FORMATS,
};
use super::service::{self, BatchDraft};

/* ---------------- 入参 ---------------- */

/// `format` 在三个 schema 里是同一个字段：
/// `z.string().refine(isExportFormat).default('txt')` ——
/// 缺失 / null 取 'txt'，值域外**拒绝整次调用**（不是静默回落）。
fn parse_format(validator: &mut Validator<'_>) -> String {
    validator.enum_value("format", &EXPORT_FORMATS, "txt", "导出格式不支持")
}

fn parse_chapter_input(input: Option<Value>) -> AppResult<ExportChapterInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let chapter_id = validator.id("chapterId", "章节 ID 非法");
    let format = parse_format(&mut validator);

    validator.finish()?;
    Ok(ExportChapterInput { chapter_id, format })
}

fn parse_book_input(input: Option<Value>) -> AppResult<ExportBookInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let book_id = validator.id("bookId", "书籍 ID 非法");
    let format = parse_format(&mut validator);

    validator.finish()?;
    Ok(ExportBookInput { book_id, format })
}

fn parse_volume_input(input: Option<Value>) -> AppResult<ExportVolumeInput> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let volume_id = validator.id("volumeId", "分卷 ID 非法");
    let format = parse_format(&mut validator);

    validator.finish()?;
    Ok(ExportVolumeInput { volume_id, format })
}

/* ---------------- 业务 ---------------- */

/// 数据库锁只在这一小段里持有：弹模态框可能耗上十几秒，期间不能让
/// 编辑器的自动保存排队等锁。所以顺序固定为「持锁读 + 排版 → 放锁 → 弹框写盘」。
fn run_chapter(
    window: &WebviewWindow,
    state: &AppState,
    input: Option<Value>,
) -> AppResult<ExportChapterResult> {
    let parsed = parse_chapter_input(input)?;

    let draft = {
        let conn = state.connection()?;
        service::prepare_chapter(&conn, &parsed)?
    };

    let outcome = service::save_draft(window, &draft, &parsed.format, "发布草稿")?;
    if !outcome.canceled {
        logger::info(
            "草稿已导出",
            logger::fields(vec![
                ("chapterId", json!(parsed.chapter_id)),
                ("bytes", json!(outcome.bytes)),
                ("format", json!(parsed.format)),
            ]),
        );
    }

    Ok(ExportChapterResult {
        canceled: outcome.canceled,
        file_path: outcome.file_path,
        bytes: outcome.bytes,
        suggested_name: draft.suggested_name,
    })
}

fn run_book(
    window: &WebviewWindow,
    state: &AppState,
    input: Option<Value>,
) -> AppResult<ExportBatchResult> {
    let parsed = parse_book_input(input)?;

    let BatchDraft {
        draft,
        chapter_count,
    } = {
        let conn = state.connection()?;
        service::prepare_book(&conn, &parsed)?
    };

    let outcome = service::save_draft(window, &draft, &parsed.format, "发布整本书")?;
    if !outcome.canceled {
        logger::info(
            "整本书已导出",
            logger::fields(vec![
                ("bookId", json!(parsed.book_id)),
                ("chapterCount", json!(chapter_count)),
                ("bytes", json!(outcome.bytes)),
            ]),
        );
    }

    Ok(ExportBatchResult {
        canceled: outcome.canceled,
        file_path: outcome.file_path,
        bytes: outcome.bytes,
        suggested_name: draft.suggested_name,
        chapter_count,
    })
}

fn run_volume(
    window: &WebviewWindow,
    state: &AppState,
    input: Option<Value>,
) -> AppResult<ExportBatchResult> {
    let parsed = parse_volume_input(input)?;

    let BatchDraft {
        draft,
        chapter_count,
    } = {
        let conn = state.connection()?;
        service::prepare_volume(&conn, &parsed)?
    };

    let outcome = service::save_draft(window, &draft, &parsed.format, "发布分卷")?;
    if !outcome.canceled {
        logger::info(
            "分卷已导出",
            logger::fields(vec![
                ("volumeId", json!(parsed.volume_id)),
                ("chapterCount", json!(chapter_count)),
                ("bytes", json!(outcome.bytes)),
            ]),
        );
    }

    Ok(ExportBatchResult {
        canceled: outcome.canceled,
        file_path: outcome.file_path,
        bytes: outcome.bytes,
        suggested_name: draft.suggested_name,
        chapter_count,
    })
}

/* ---------------- 命令 ---------------- */

#[tauri::command(async)]
pub fn exporter_chapter(
    app: AppHandle,
    window: WebviewWindow,
    input: Option<Value>,
) -> IpcResponse<ExportChapterResult> {
    let state = app.state::<AppState>().inner();
    dispatch("导出草稿", "exporter:chapter", || {
        run_chapter(&window, state, input)
    })
}

#[tauri::command(async)]
pub fn exporter_book(
    app: AppHandle,
    window: WebviewWindow,
    input: Option<Value>,
) -> IpcResponse<ExportBatchResult> {
    let state = app.state::<AppState>().inner();
    dispatch("导出整本书", "exporter:book", || {
        run_book(&window, state, input)
    })
}

#[tauri::command(async)]
pub fn exporter_volume(
    app: AppHandle,
    window: WebviewWindow,
    input: Option<Value>,
) -> IpcResponse<ExportBatchResult> {
    let state = app.state::<AppState>().inner();
    dispatch("导出分卷", "exporter:volume", || {
        run_volume(&window, state, input)
    })
}
