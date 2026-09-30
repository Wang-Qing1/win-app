//! 卡片关联的服务层。
//!
//! 这里只守一条规则，但它是这个功能成立的前提：**两边必须属于同一本书**。
//! 跨书的关联点过去会跳到另一本书的某一章，读者只会以为点错了；
//! 而这种关联一旦建立，界面上没有任何东西能提示「它们其实没关系」。
//!
//! 通用卡片（bookId 为 None）不能关联 —— 它不属于任何书，
//! 自然也就没有「这本书的某一章」可言。

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::time::now_iso;
use crate::db::in_transaction;
use crate::modules::cards::service as card_service;
use crate::modules::chapters::service as chapter_service;
use crate::modules::outline::models::OutlineNodeRow;
use crate::modules::outline::repository as outline_repository;

use super::models::{
    sort_relation_pair, CardChapterLink, CardOutlineLink, CardRelation, CardRelationEdge,
    ChapterCardRef, OutlineCardRef,
};
use super::repository;

/* ------------------------------------------------------------------ *
 * 章节侧
 * ------------------------------------------------------------------ */

/// 这张卡用在哪几章。
pub fn list_by_card(conn: &Connection, card_id: i64) -> AppResult<Vec<CardChapterLink>> {
    card_service::require_card(conn, card_id)?;
    repository::list_by_card(conn, card_id)
}

/// 这一章用到了哪几张卡。
pub fn list_by_chapter(conn: &Connection, chapter_id: i64) -> AppResult<Vec<ChapterCardRef>> {
    chapter_service::get_by_id(conn, chapter_id)?;
    repository::list_by_chapter(conn, chapter_id)
}

/// 建立关联，返回这张卡关联后的完整列表。
///
/// 返回列表而不是「刚建的那一条」：调用方拿到即可替换本地状态，不必再发一次
/// 查询；也顺带让「关联成功后列表没刷新」这类时序问题根本没有发生的机会。
///
/// 幂等：重复关联同一对不报错、也不产生第二行（仓储用 INSERT OR IGNORE）。
/// 界面上的「快速连点」因此是安全的。
pub fn link(conn: &Connection, card_id: i64, chapter_id: i64) -> AppResult<Vec<CardChapterLink>> {
    in_transaction(conn, |conn| {
        let card = card_service::require_card(conn, card_id)?;
        let chapter = chapter_service::get_by_id(conn, chapter_id)?;
        assert_same_book(card.book_id, chapter.book_id, &card.title, &chapter.title)?;

        repository::insert(conn, card_id, chapter_id, &now_iso())?;
        logger::info(
            "卡片已关联章节",
            logger::fields(vec![
                ("cardId", serde_json::json!(card_id)),
                ("chapterId", serde_json::json!(chapter_id)),
            ]),
        );

        repository::list_by_card(conn, card_id)
    })
}

pub fn unlink(conn: &Connection, card_id: i64, chapter_id: i64) -> AppResult<Vec<CardChapterLink>> {
    in_transaction(conn, |conn| {
        card_service::require_card(conn, card_id)?;
        chapter_service::get_by_id(conn, chapter_id)?;

        repository::delete(conn, card_id, chapter_id)?;
        logger::info(
            "卡片已解除章节关联",
            logger::fields(vec![
                ("cardId", serde_json::json!(card_id)),
                ("chapterId", serde_json::json!(chapter_id)),
            ]),
        );

        repository::list_by_card(conn, card_id)
    })
}

/* ------------------------------------------------------------------ *
 * 大纲节点侧
 *
 * 同一条「两边同书」规则在这里同样成立，而且更容易踩到：
 * 大纲节点永远属于某一本书，卡片却可能是通用的。
 * ------------------------------------------------------------------ */

/// 这张卡挂在哪些节点上。
pub fn list_nodes_by_card(conn: &Connection, card_id: i64) -> AppResult<Vec<CardOutlineLink>> {
    card_service::require_card(conn, card_id)?;
    repository::list_nodes_by_card(conn, card_id)
}

/// 这个节点用到了哪几张卡。
pub fn list_by_node(conn: &Connection, node_id: i64) -> AppResult<Vec<OutlineCardRef>> {
    require_node(conn, node_id)?;
    repository::list_by_node(conn, node_id)
}

pub fn link_node(conn: &Connection, card_id: i64, node_id: i64) -> AppResult<Vec<CardOutlineLink>> {
    in_transaction(conn, |conn| {
        let card = card_service::require_card(conn, card_id)?;
        let node = require_node(conn, node_id)?;
        assert_same_book(card.book_id, node.book_id, &card.title, &node.title)?;

        repository::insert_node(conn, card_id, node_id, &now_iso())?;
        logger::info(
            "卡片已关联大纲节点",
            logger::fields(vec![
                ("cardId", serde_json::json!(card_id)),
                ("nodeId", serde_json::json!(node_id)),
            ]),
        );

        repository::list_nodes_by_card(conn, card_id)
    })
}

pub fn unlink_node(
    conn: &Connection,
    card_id: i64,
    node_id: i64,
) -> AppResult<Vec<CardOutlineLink>> {
    in_transaction(conn, |conn| {
        card_service::require_card(conn, card_id)?;
        require_node(conn, node_id)?;

        repository::delete_node(conn, card_id, node_id)?;
        logger::info(
            "卡片已解除大纲节点关联",
            logger::fields(vec![
                ("cardId", serde_json::json!(card_id)),
                ("nodeId", serde_json::json!(node_id)),
            ]),
        );

        repository::list_nodes_by_card(conn, card_id)
    })
}

/* ------------------------------------------------------------------ *
 * 卡片 ↔ 卡片
 *
 * 关系与上面两类关联共享「两边必须同属一本书」这条规则，但另有两条
 * 它自己才有的：不能和自己建立关系，以及两边都得真的存在。
 * ------------------------------------------------------------------ */

/// 这张卡与哪些卡有关系（一条边的两头都能看到它）。
pub fn list_relations(conn: &Connection, card_id: i64) -> AppResult<Vec<CardRelation>> {
    card_service::require_card(conn, card_id)?;
    repository::list_relations(conn, card_id)
}

/// 这本书里所有的关系边，给关系网用。
///
/// **刻意不校验书是否存在**：与前端契约一致 —— 一本书还没有任何关系时也应当
/// 正常返回空数组，而不是报「书籍不存在」。关系网是一个只读视图，
/// 它的空状态是合法的。
pub fn list_relations_by_book(conn: &Connection, book_id: i64) -> AppResult<Vec<CardRelationEdge>> {
    repository::list_relations_by_book(conn, book_id)
}

/// 建立 / 改写一条关系，返回这张卡关系后的完整列表。
///
/// 幂等：同一对卡重复建立不产生第二条边，只把关系名改成最新的（仓储走 UPSERT）。
/// 于是「改关系名」与「建关系」是同一个操作，界面上不必先删再建。
///
/// 返回的列表是**被查询那一张卡**的视角：调用方（面板）直接拿它替换本地状态
/// 即可。另一头看不到这次改动，由前端再失效一次 —— 一条边两头的列表内容
/// 相同但视角不同，没法用同一份返回值顶替。
pub fn relate(
    conn: &Connection,
    card_id: i64,
    related_id: i64,
    relation: &str,
) -> AppResult<Vec<CardRelation>> {
    in_transaction(conn, |conn| {
        let card = card_service::require_card(conn, card_id)?;
        let other = card_service::require_card(conn, related_id)?;

        if card_id == related_id {
            return Err(AppError::validation(format!(
                "不能给「{}」和自己建立关系",
                card.title
            )));
        }
        assert_same_relation_book(card.book_id, other.book_id, &card.title, &other.title)?;

        // 表上有 CHECK (card_id < related_id)：一条边只有一种写法，
        // 于是「A 连 B」与「B 连 A」不会存成两条
        let (left, right) = sort_relation_pair(card_id, related_id);
        repository::upsert_relation(conn, left, right, relation, &now_iso())?;
        logger::info(
            "卡片关系已建立",
            logger::fields(vec![
                ("cardId", serde_json::json!(card_id)),
                ("relatedId", serde_json::json!(related_id)),
                ("relation", serde_json::json!(relation)),
            ]),
        );

        repository::list_relations(conn, card_id)
    })
}

/// 解除一条关系，返回这张卡解除后的完整列表。
pub fn unrelate(
    conn: &Connection,
    card_id: i64,
    related_id: i64,
) -> AppResult<Vec<CardRelation>> {
    in_transaction(conn, |conn| {
        card_service::require_card(conn, card_id)?;
        card_service::require_card(conn, related_id)?;

        let (left, right) = sort_relation_pair(card_id, related_id);
        repository::delete_relation(conn, left, right)?;
        logger::info(
            "卡片关系已解除",
            logger::fields(vec![
                ("cardId", serde_json::json!(card_id)),
                ("relatedId", serde_json::json!(related_id)),
            ]),
        );

        repository::list_relations(conn, card_id)
    })
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/// 取一个大纲节点，不存在即 NOT_FOUND。
///
/// 走仓储的 `find_by_id` 而不是服务层的 `tree`：关联只需要节点自己的
/// bookId 与 title，把整棵树拉出来再找一遍是几十倍的代价。
fn require_node(conn: &Connection, id: i64) -> AppResult<OutlineNodeRow> {
    outline_repository::find_by_id(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("大纲节点不存在（ID: {id}）")))
}

/// 同书校验。
///
/// 报错文案里带上两边各自的名字与归属：只说「不能跨书关联」的话，
/// 用户不知道是哪一边选错了 —— 而这里最常见的错因恰恰是
/// 「卡片建在了另一本书下」，得让用户能自己看出来。
fn assert_same_book(
    card_book_id: Option<i64>,
    other_book_id: i64,
    card_title: &str,
    other_title: &str,
) -> AppResult<()> {
    let Some(card_book_id) = card_book_id else {
        return Err(AppError::conflict(format!(
            "「{card_title}」是通用卡片，不属于任何书，没法关联到《{other_title}》。先把它指定到一本书下。"
        )));
    };

    if card_book_id != other_book_id {
        return Err(AppError::conflict(format!(
            "「{card_title}」不属于《{other_title}》所在的这本书，跨书关联没有意义。"
        )));
    }

    Ok(())
}

/// 关系两端的同书校验。
///
/// 不复用 `assert_same_book`：那一版的文案是按「卡片 ↔ 章节」写的
/// （「先把它指定到一本书下」对一张卡没有意义），而关系的两边都是卡片，
/// 常见错因是「另一张卡建在了别的书里」—— 文案得指向那一边。
fn assert_same_relation_book(
    left_book_id: Option<i64>,
    right_book_id: Option<i64>,
    left_title: &str,
    right_title: &str,
) -> AppResult<()> {
    if left_book_id.is_none() || right_book_id.is_none() {
        // 哪一边是通用卡片就点哪一边的名：两边都点名会让用户以为两张卡都要改
        let culprit = if left_book_id.is_none() {
            left_title
        } else {
            right_title
        };
        return Err(AppError::conflict(format!(
            "「{culprit}」是通用卡片，不属于任何书，建立关系前先把它指定到一本书下。"
        )));
    }

    if left_book_id != right_book_id {
        return Err(AppError::conflict(format!(
            "「{left_title}」与「{right_title}」不属于同一本书，跨书的关系在关系网里没有落点。"
        )));
    }

    Ok(())
}
