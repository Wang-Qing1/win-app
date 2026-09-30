//! 全库检索模块：章节正文 / 卡片库 / 大纲 / 书籍信息四个来源的 LIKE 全库扫描。
//!
//! 选 LIKE 而不是 FTS5 的理由见 `models.rs` 文件头（中文人名多是两个字，
//! `trigram` 分词器会直接给一个静默的空列表）。

pub mod commands;
pub mod models;
pub mod repository;
pub mod service;
