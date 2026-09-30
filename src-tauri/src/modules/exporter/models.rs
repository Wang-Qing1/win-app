//! 草稿导出模块的领域契约（前端对应 `shared/modules/exporter.ts`）。
//!
//! 名字虽然叫 export，但它做的其实是「把一章（或一整本、一整卷）的正文
//! 写成磁盘上的一个纯文本文件」。之所以单开一个模块而不是塞进 chapters：
//! 它是**全应用唯一需要宿主能力**（保存对话框 + 写盘）的地方，而 chapters
//! 是纯数据操作 —— 混在一起会让章节服务意外依赖宿主窗口对象，
//! 也就再也无法脱离窗口单测。
//!
//! 关于 txt 与 md 的差别：这里不做任何 Markdown 语法转换，只影响标题行
//! 与段落之间的排版。网文平台接收的是纯文本，所以 txt 是主路径。

use serde::Serialize;

pub const EXPORT_FORMATS: [&str; 2] = ["txt", "md"];

// 刻意**没有** `is_export_format`：前端的 `isExportFormat` 只有两个消费方
// —— 单测，以及三个 schema 里的 `.refine(isExportFormat, '导出格式不支持')`。
// Rust 这边没有单测副本，值域校验由 `commands.rs` 的
// `validator.enum_value("format", &EXPORT_FORMATS, …)` 一次做完，
// 再留一个没人调的函数只会变成第二份会漂移的口径。

/// 默认文件名的长度上限。
///
/// 注意口径：JS 那边是 `fallback.slice(0, EXPORT_FILENAME_MAX)`，
/// 而 `String.prototype.length` 与 `slice` 数的是 **UTF-16 码元**，
/// 不是码点。含补充平面字符（emoji、CJK 扩展 B）时两者会差一截，
/// 所以下面的截断也按码元来，见 `service::truncate_utf16`。
pub const EXPORT_FILENAME_MAX: usize = 120;

#[derive(Debug, Clone)]
pub struct ExportChapterInput {
    pub chapter_id: i64,
    pub format: String,
}

#[derive(Debug, Clone)]
pub struct ExportBookInput {
    pub book_id: i64,
    pub format: String,
}

#[derive(Debug, Clone)]
pub struct ExportVolumeInput {
    pub volume_id: i64,
    pub format: String,
}

/// 单章导出的回执。
///
/// `canceled` 单独成字段而不是靠 `file_path.is_none()` 判断：用户主动取消
/// 与「写文件失败」是两件事，前者不该弹错误提示。把它们混成一种状态
/// 会让每次取消都冒出一条红字，用户会以为出了问题。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChapterResult {
    pub canceled: bool,
    pub file_path: Option<String>,
    pub bytes: i64,
    /// 建议的文件名（导出前的默认名），取消时也返回，便于界面提示
    pub suggested_name: String,
}

/// 整本书 / 整卷导出的回执。
///
/// 比 [`ExportChapterResult`] 多一个 `chapter_count`：界面需要告知用户
/// 「拼接了几章」。若一章也没有则**不弹对话框而是报错** —— 空书导出到硬盘
/// 还是个文件无内容，与「用户取消」同样不算错误，但应让用户知道自己
/// 导出的是个空文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBatchResult {
    pub canceled: bool,
    pub file_path: Option<String>,
    pub bytes: i64,
    pub suggested_name: String,
    pub chapter_count: i64,
}

// 刻意**没有** `EXPORT_FORMAT_LABELS`：那是给渲染层下拉框用的显示文案
// （'纯文本（.txt）' / 'Markdown（.md）'），前端自带一份原样复用，
// 后端从不需要把 label 拼进任何字符串。搬过来只会多一份会漂移的副本。
