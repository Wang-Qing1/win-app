//! 草稿导出模块：把正文（单章 / 整本书 / 整卷）写成磁盘上的纯文本文件。
//!
//! 全应用唯一依赖宿主窗口能力的模块 —— 保存对话框挂在主窗口下、
//! 写盘由后端直接落。它不拥有任何一张表，读取全部复用 chapters / books /
//! volumes 已有的仓储（见 `service.rs` 顶部的两段式说明）。

pub mod commands;
pub mod models;
pub mod service;
