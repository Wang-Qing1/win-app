//! 统计模块：只读聚合，没有自己的表、也不直接写 SQL。
//!
//! 所有数字都来自 books / chapters / writing_sessions 三个模块已有的仓储查询，
//! 因此统计口径不会出现第二份副本。

pub mod commands;
pub mod models;
pub mod service;
