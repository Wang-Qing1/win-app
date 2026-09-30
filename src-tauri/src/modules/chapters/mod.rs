//! 章节模块：整个应用的核心实体。
//!
//! 两个文件各管一张表：`repository` 管 `chapters`，`revision_repository`
//! 管 `chapter_revisions`（历史版本）。分开的理由见后者的文件头。

pub mod commands;
pub mod models;
pub mod repository;
pub mod revision_repository;
pub mod service;
