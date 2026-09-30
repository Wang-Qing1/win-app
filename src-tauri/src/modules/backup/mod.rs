//! 数据库备份模块：把当前库整份导出成用户选定的 .db 文件。
//!
//! 只有一条通道（`backup:database`），没有入参；也没有自己的表 ——
//! 它读的是「连接本身」，不是某张表。

pub mod commands;
pub mod models;
pub mod service;
