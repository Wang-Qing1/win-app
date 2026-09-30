//! 回收站服务—— 一台**纯粹的编排器**，
//! 自己一行 SQL 也没有。
//!
//! 之所以能这么薄，是因为「哪些卡片在回收站里」「恢复一章要落到哪个位置」
//! 这类问题各自只有卡片服务与章节服务知道答案（卡片有「认不出的类型退回
//! 灵感」的口径，章节有「容器与顺序」的概念）。让回收站直接拿两个仓储去查，
//! 等于把这两套口径复制一份到第三个地方 —— 从此「同一张卡在卡片库与回收站里
//! 显示成不同类型」这类问题就有了生长的土壤。
//!
//! 它负责的只有三种**跨实体**的判断，这三种恰好谁都不该管：
//!   1. 把两张表的条目按删除时间混排成一个列表（时间轴是唯一的视角）；
//!   2. 按 kind 分派恢复 / 彻底删除（同一个动作作用在两种东西上）；
//!   3. 清空时分别统计两边的条数，合成一个回执。
//!
//! 依赖方向是单向的：trash → cards / chapters。两个模块完全不认识「回收站」
//! 这个概念，它们只知道「有一列 deleted_at」。将来再加一种可回收的实体
//! （比如大纲节点），只需要它自己长出 list_deleted / restore_from_trash
//! 这几个方法，然后在这里多一行 —— 不需要改任何现有模块。

use std::cmp::Ordering;
use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::core::errors::AppResult;
use crate::core::logger;
use crate::modules::cards::service as card_service;
use crate::modules::chapters::service as chapter_service;

use super::models::{TrashEmptyResult, TrashItem, TrashItemRef, TrashListResult, TRASH_ITEMS_LIMIT};

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/// 混排的回收站列表。
///
/// `kind_counts` 刻意**不受 kind 筛选影响**（两种都数、都取）：
/// 界面上它是页签旁的数字，切到「章节」时若卡片那格变成 0，
/// 读起来像「卡片被删光了」。这与卡片库 count_by_type 的处理一致。
///
/// 取数上限用同一个 `TRASH_ITEMS_LIMIT` 逐边截断再合并，因此
/// 「卡片 500 条 + 章节 500 条」时合并后的 1000 条会被再截一次 ——
/// 截断是双向的，但 `total` 永远是真实总数，界面据此提示「仅显示最近 N 条」。
pub fn list(conn: &Connection, kind: Option<&str>) -> AppResult<TrashListResult> {
    let kind_counts: BTreeMap<String, i64> = BTreeMap::from([
        ("card".to_string(), card_service::count_deleted(conn)?),
        ("chapter".to_string(), chapter_service::count_deleted(conn)?),
    ]);

    let mut items: Vec<TrashItem> = Vec::new();

    if kind.is_none() || kind == Some("card") {
        for entry in card_service::list_deleted(conn, TRASH_ITEMS_LIMIT)? {
            items.push(TrashItem {
                kind: "card".to_string(),
                entry,
            });
        }
    }

    if kind.is_none() || kind == Some("chapter") {
        for entry in chapter_service::list_deleted(conn, TRASH_ITEMS_LIMIT)? {
            items.push(TrashItem {
                kind: "chapter".to_string(),
                entry,
            });
        }
    }

    // 按删除时间倒序。
    //
    // 二级键必须存在：两张表的 id 是各自独立的自增序列，而删除时间只精确到
    // 毫秒 —— 连续删掉一张卡与一章就可能落在同一毫秒里，
    // 仅按时间排会让顺序取决于 SQLite 的返回顺序，而那个顺序是没有保证的，
    // 刷新两次列表可能就不是一个样子。用 (kind, id) 兜底：
    // 它没有任何业务含义，但**确定**。
    items.sort_by(|left, right| {
        if left.entry.deleted_at != right.entry.deleted_at {
            return if left.entry.deleted_at < right.entry.deleted_at {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
        if left.kind != right.kind {
            return if left.kind < right.kind {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        right.entry.id.cmp(&left.entry.id)
    });

    items.truncate(TRASH_ITEMS_LIMIT as usize);

    // 未筛选时 total 是两种之和（真实总数，不是截断后的条数）
    let total = match kind {
        None => kind_counts.get("card").copied().unwrap_or(0)
            + kind_counts.get("chapter").copied().unwrap_or(0),
        Some(kind) => kind_counts.get(kind).copied().unwrap_or(0),
    };

    Ok(TrashListResult {
        items,
        total,
        kind_counts,
    })
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/// 把一条捞回来。
///
/// 分派只做一次，就在这一层 —— 两个实体的恢复语义完全不同（卡片只是清掉标记，
/// 章节还要决定落回哪个容器的哪个位置），所以这里只负责「找对人」，
/// 不试图把两者统一成一种写法。
///
/// `kind` 由命令边界严格校验过（写操作拒绝非法值），所以这里只需要二分。
pub fn restore(conn: &Connection, kind: &str, id: i64) -> AppResult<TrashItemRef> {
    if kind == "card" {
        card_service::restore_from_trash(conn, id)
    } else {
        chapter_service::restore_from_trash(conn, id)
    }
}

/// 彻底删除一条。不可恢复 —— 界面上的确认框必须说清楚这一点。
pub fn purge(conn: &Connection, kind: &str, id: i64) -> AppResult<TrashItemRef> {
    if kind == "card" {
        card_service::purge_from_trash(conn, id)
    } else {
        chapter_service::purge_from_trash(conn, id)
    }
}

/// 清空回收站。
///
/// 两条 DELETE 放在同一次调用里，但**不在同一个事务里**：两个模块各自的方法
/// 内部已经各起了一个 SAVEPOINT，这里再套一层会让「一边成功一边失败」变成
/// 「两边一起回滚」—— 语义上更好，但那要求两个模块各暴露一个「无事务」的变体，
/// 代价是每个模块多一个只为回收站存在的入口。
///
/// 这个取舍是划算的：清空失败时最坏的结果是「卡片删掉了、章节还在」，
/// 而用户看到的是页面刷新后还剩几条 —— 再点一次即完成。
/// 它不是账务操作，不存在「扣了钱没到账」那种必须原子性的语义。
pub fn empty(conn: &Connection, kind: Option<&str>) -> AppResult<TrashEmptyResult> {
    let removed_cards = if kind.is_none() || kind == Some("card") {
        card_service::purge_all_from_trash(conn)?
    } else {
        0
    };
    let removed_chapters = if kind.is_none() || kind == Some("chapter") {
        chapter_service::purge_all_from_trash(conn)?
    } else {
        0
    };

    let removed = removed_cards + removed_chapters;
    if removed > 0 {
        logger::info(
            "回收站已清空",
            logger::fields(vec![
                ("removedCards", serde_json::json!(removed_cards)),
                ("removedChapters", serde_json::json!(removed_chapters)),
            ]),
        );
    }

    Ok(TrashEmptyResult {
        removed,
        removed_cards,
        removed_chapters,
    })
}
