//! 卡片库模块：四类卡片（人物 / 物品 / 灵感 / 设定）共用一张表，
//! 差异只在 `extra` 这一列 JSON 里。
//!
//! 卡片 ↔ 章节 / 大纲节点 / 卡片之间的关联另开一个模块（`card_links`）：
//! 那是两个聚合之间的关系，不属于任何一方的内部契约。命令虽然在
//! `cards:*` 这个命名空间下，但通道名只是字符串，不影响分层。

pub mod commands;
pub mod models;
pub mod repository;
pub mod service;
