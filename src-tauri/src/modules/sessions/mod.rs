//! 写作会话模块：编辑器里的「进入 → 空闲/离开」结算成一条记录。
//!
//! 它是统计功能的唯一事实源 —— 章节目录只是当前快照，删掉一章就会让历史
//! 写作量凭空消失，而「我昨天写了 2000 字」是既成事实。

pub mod commands;
pub mod models;
pub mod repository;
pub mod service;
