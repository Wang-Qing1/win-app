//! 书籍模块：整个应用的第一等实体，其它一切（分卷、章节、大纲、卡片）
//! 都挂在它下面。
//!
//! 分层与 前端一致：`commands`（控制器）→ `service` → `repository`，
//! `models` 是契约类型。

pub mod commands;
pub mod models;
pub mod repository;
pub mod service;
