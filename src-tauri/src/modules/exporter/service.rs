//! 导出服务（对应 TS 侧 `exporter/export.service.ts`）。
//!
//! 与其余服务最大的不同：这一个要碰宿主能力（保存对话框 + 写盘），
//! 所以它是唯一签名里带 `&AppHandle` 的服务。
//!
//! **刻意拆成两段**（`prepare_*` / `save_draft`）：
//!   - `prepare_*`：纯数据 —— 读库、排版、算默认文件名，只在持有数据库
//!     连接时跑；
//!   - `save_draft`：弹对话框、写盘，**必须在释放数据库锁之后**调用。
//!
//! TS 版把两段写在一个方法里没出过问题，是因为那边没有「一把全局连接锁」；
//! 在 Rust 侧若在持锁期间弹模态框，用户翻目录的十几秒里每一个命令
//! （包括编辑器的自动保存）都会卡住。分开之后，`service::save_draft`
//! 一句 SQL 都不碰。

use rusqlite::Connection;
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

use crate::core::errors::{io_error, AppError, AppResult};
use crate::core::text::is_js_whitespace;
use crate::modules::books::repository as book_repository;
use crate::modules::chapters::models::{ChapterListQuery, ChapterListItem};
use crate::modules::chapters::repository as chapter_repository;
use crate::modules::volumes::repository as volume_repository;

use super::models::{
    ExportBookInput, ExportChapterInput, ExportVolumeInput, EXPORT_FILENAME_MAX,
};

/// 已排好版、只等写盘的内容。单章导出用。
pub struct Draft {
    pub content: String,
    pub suggested_name: String,
}

/// 整本书 / 整卷：内容 + 「拼接了几章」。
pub struct BatchDraft {
    pub draft: Draft,
    pub chapter_count: i64,
}

/// 写盘这一步的原始结果，不含 `suggestedName`（那属于上一步）。
pub struct SaveOutcome {
    pub canceled: bool,
    pub file_path: Option<String>,
    pub bytes: i64,
}

/* ------------------------------------------------------------------ *
 * 第一段：读库 + 排版（持锁期间跑）
 * ------------------------------------------------------------------ */

/// 单章导出。
pub fn prepare_chapter(conn: &Connection, input: &ExportChapterInput) -> AppResult<Draft> {
    let chapter = chapter_repository::find_by_id(conn, input.chapter_id)?;
    let Some(chapter) = chapter else {
        return Err(AppError::not_found(format!(
            "章节不存在（ID: {}）",
            input.chapter_id
        )));
    };

    // 书被删掉（或章节挂在一本已不存在的书上）时退回「未命名书籍」而不是
    // 报错：`book?.title ?? '未命名书籍'` —— 导出正文这件事本身不依赖书名。
    let book_title = book_repository::find_by_id(conn, chapter.book_id)?
        .map(|book| book.title)
        .unwrap_or_else(|| "未命名书籍".to_string());

    let suggested_name = format!(
        "{}-{}.{}",
        sanitize_file_name(&book_title),
        sanitize_file_name(&chapter.title),
        input.format
    );

    Ok(Draft {
        content: render_draft(&chapter.title, &chapter.content_text, &input.format),
        suggested_name,
    })
}

/// 整本书导出：按书内章节列表页同样的顺序（分卷内按 order_index，
/// 未分卷排在最后）把每一章拼接进同一个文件。
pub fn prepare_book(conn: &Connection, input: &ExportBookInput) -> AppResult<BatchDraft> {
    let book = book_repository::find_by_id(conn, input.book_id)?;
    let Some(book) = book else {
        return Err(AppError::not_found(format!(
            "书籍不存在（ID: {}）",
            input.book_id
        )));
    };

    let chapters = chapter_repository::list_with_content(
        conn,
        &ChapterListQuery {
            book_id: input.book_id,
            // None = 「不限分卷」，即整本书；不是 Some(None)（那只取未分卷区间）
            volume_id: None,
        },
    )?;
    if chapters.is_empty() {
        return Err(AppError::validation("该书籍暂无章节，无法导出"));
    }

    Ok(BatchDraft {
        draft: Draft {
            content: render_batch(&chapters, &input.format),
            suggested_name: format!("{}.{}", sanitize_file_name(&book.title), input.format),
        },
        chapter_count: chapters.len() as i64,
    })
}

/// 整卷导出：只拼接该卷下的章节，不包含未分卷或其他卷的内容。
pub fn prepare_volume(conn: &Connection, input: &ExportVolumeInput) -> AppResult<BatchDraft> {
    let volume = volume_repository::find_by_id(conn, input.volume_id)?;
    let Some(volume) = volume else {
        return Err(AppError::not_found(format!(
            "分卷不存在（ID: {}）",
            input.volume_id
        )));
    };

    let book_title = book_repository::find_by_id(conn, volume.book_id)?
        .map(|book| book.title)
        .unwrap_or_else(|| "未命名书籍".to_string());

    // volume_id 用 Some(Some(id)) 而不是 Some(id)：外层 Option 表示
    // 「是否按容器筛选」，内层表示「哪个容器 / 是否未分卷」。
    let chapters = chapter_repository::list_with_content(
        conn,
        &ChapterListQuery {
            book_id: volume.book_id,
            volume_id: Some(Some(volume.id)),
        },
    )?;
    if chapters.is_empty() {
        return Err(AppError::validation("该分卷暂无章节，无法导出"));
    }

    Ok(BatchDraft {
        draft: Draft {
            content: render_batch(&chapters, &input.format),
            suggested_name: format!(
                "{}-{}.{}",
                sanitize_file_name(&book_title),
                sanitize_file_name(&volume.title),
                input.format
            ),
        },
        chapter_count: chapters.len() as i64,
    })
}

/* ------------------------------------------------------------------ *
 * 第二段：弹框 + 写盘（不碰数据库）
 * ------------------------------------------------------------------ */

/// 弹出保存对话框并写文件。三个导出入口（单章 / 整本书 / 整卷）共用这一段，
/// 只是内容与建议文件名不同 —— 弹对话框、处理取消、写盘这三步只值得写一次。
///
/// `canceled` 与「写盘失败」在这里是两件事：前者是 `Ok`（用户什么都没做），
/// 后者是 `Err`。
///
/// `window` 由命令层注入（Tauri 会把**发起调用的那个**窗口交给命令），
/// 等价于 TS 版的 `BrowserWindow.fromWebContents(ctx.event.sender)`：
/// 对话框挂在它下面才会是应用内模态框，否则在 Windows 上会变成一个
/// 可以被主窗口盖住的游离窗口。
///
/// 必须从**非主线程**调用：`blocking_save_file` 是「把对话框回调的结果经
/// 通道传回」的同步等待，在事件循环线程上调用会自己等自己。命令层因此
/// 声明成 `async fn`（Tauri 会把 async 命令派到运行时线程池上）。
pub fn save_draft(
    window: &WebviewWindow,
    draft: &Draft,
    format: &str,
    dialog_title: &str,
) -> AppResult<SaveOutcome> {
    let filter_name = if format == "md" { "Markdown" } else { "纯文本" };

    let chosen = window
        .dialog()
        .file()
        .set_title(dialog_title)
        .set_file_name(draft.suggested_name.clone())
        .add_filter(filter_name, &[format])
        .set_parent(window)
        .blocking_save_file();

    let Some(chosen) = chosen else {
        // 取消不是错误：调用方据此安静地什么都不做
        return Ok(SaveOutcome {
            canceled: true,
            file_path: None,
            bytes: 0,
        });
    };

    let path = chosen
        .into_path()
        .map_err(|error| io_error("无法解析用户选择的保存路径", error))?;

    // 与 JS 的 writeFile(path, content, 'utf8') 同口径：UTF-8 字节直接落盘。
    // bytes 用 content.len()（Rust 的 len 就是 UTF-8 字节数），
    // 对齐 JS 的 Buffer.byteLength(content, 'utf8')。
    std::fs::write(&path, draft.content.as_bytes())
        .map_err(|error| io_error(&format!("写入 {} 失败", path.display()), error))?;

    Ok(SaveOutcome {
        canceled: false,
        file_path: Some(path.display().to_string()),
        bytes: draft.content.len() as i64,
    })
}

/* ------------------------------------------------------------------ *
 * 排版
 * ------------------------------------------------------------------ */

/// 组装导出内容。
///
/// 正文用 `content_text`（HTML 的纯文本投影）而不是现解析 `content_html`：
/// 那份投影在每次保存正文时已经算好并落库，它与界面显示的字数出自同一次
/// 计算，用它导出能保证「导出的字数」和「应用里显示的字数」一致。
fn render_draft(chapter_title: &str, content_text: &str, format: &str) -> String {
    // JS: contentText.replace(/\r\n?/g, '\n').trim()
    let normalized = content_text.replace("\r\n", "\n").replace('\r', "\n");
    let body = trim_js(&normalized);
    let header = if format == "md" {
        format!("# {chapter_title}")
    } else {
        chapter_title.to_string()
    };

    // 末尾补一个换行：老式编辑器（记事本、部分投稿后台的粘贴框）在文件末尾
    // 没有换行时会把最后一段和后续内容粘在一起
    format!("{header}\n\n{body}\n")
}

/// 拼接多章：整本书 / 整卷导出共用。
///
/// 每一章先用 [`render_draft`] 单独排版（自带末尾换行），再用额外的一个换行
/// 拼接 —— 两章之间正好隔一行空行，与全项目其他处的「块面之间空一行」
/// 排版约定一致。
fn render_batch(chapters: &[(ChapterListItem, String)], format: &str) -> String {
    chapters
        .iter()
        .map(|(item, content_text)| render_draft(&item.title, content_text, format))
        .collect::<Vec<_>>()
        .join("\n")
}

/* ------------------------------------------------------------------ *
 * 文件名清洗
 * ------------------------------------------------------------------ */

/// 清洗文件名。
///
/// Windows 的文件名禁用字符比 POSIX 多得很多（`: * ? " < > |` 以及路径
/// 分隔符），而书名里出现「？」「：」的概率极高 —— 网文标题里这两种标点
/// 几乎是标配。不清洗的话保存对话框会直接报错，用户完全不知道哪里出了问题。
///
/// **字符集与 TS 逐字对齐**（`[\\/:*?"<>|` + U+0000–U+001F + `]`）：
/// 删掉路径分隔符、Windows 禁用标点，以及全部控制字符。
/// 空格与连字符**不删** —— 之所以专门写这句，是因为 TS 源码里那个区间
/// 用的是两个真实控制字节，看着像空格（详见 `is_forbidden_filename_char`）。
/// 需要保留的分隔符（书名与章节名之间那个 `-`）是在清洗**之后**拼上去的。
pub fn sanitize_file_name(name: &str) -> String {
    let stripped: String = name
        .chars()
        .filter(|ch| !is_forbidden_filename_char(*ch))
        .collect();

    let collapsed = collapse_js_whitespace(&stripped);
    let trimmed = trim_js(&collapsed);
    // Windows 不允许文件名以点或空格结尾
    let trimmed = trimmed.trim_end_matches(['.', ' ']);

    let fallback = if trimmed.is_empty() { "未命名" } else { trimmed };
    truncate_utf16(fallback, EXPORT_FILENAME_MAX)
}

fn is_forbidden_filename_char(ch: char) -> bool {
    matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        // 还有 U+0000–U+001F 全部控制字符。
        //
        // 注意这一段的来历：TS 源码里写的是 `/[\\/:*?"<>| -]/`，
        // 但中间那两个「空格」其实是**真实的控制字节**（NUL 与 0x1F），
        // 合起来构成一个从 0x00 到 0x1F 的字符区间，即「删掉所有控制字符」。
        // 普通编辑器与多数读取工具会把它们渲染成空格，于是看着像
        // 「连空格和连字符一起删」—— 照抄那个理解会让「我的 书」变成
        // 「我的书」，默认文件名与 Electron 版对不上。
        || (ch as u32) < 0x20
}

/// `trim()` 的 JS 口径。
///
/// 不能用 `str::trim()`：Rust 的 `char::is_whitespace` 按 Unicode
/// `White_Space` 走（含 U+0085 NEL、不含 U+FEFF 零宽不换行空格），
/// 而 JS 的 `\s` 恰好相反。差一个字符，书名尾部的零宽空格就会留下来。
fn trim_js(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.replace(/\s+/g, ' ')` 的等价物（按 JS 的 `\s` 定义）。
fn collapse_js_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;

    for ch in text.chars() {
        if is_js_whitespace(ch) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(ch);
            in_run = false;
        }
    }

    out
}

/// 按 UTF-16 码元截断，对齐 JS 的 `slice(0, n)`。
///
/// 截断处落在代理对中间时，JS 会留下一个孤立的高位代理（渲染成「�」），
/// Rust 的 `String` 装不下它，只能替换成 U+FFFD —— 表现一致。
fn truncate_utf16(text: &str, max: usize) -> String {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_string();
    }
    units.truncate(max);
    String::from_utf16_lossy(&units)
}
