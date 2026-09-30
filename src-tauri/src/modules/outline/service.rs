//! 大纲服务（对应 TS 侧 `outline.service.ts`）。
//!
//! 这里是**自由树最容易出错的地方**：节点的父指针可以指向任意节点，于是
//! 「把 A 拖到 A 的子孙之下」这种操作天然可表达，一旦放过去，树上就出现一个环
//! —— 从任何根节点都走不到它（节点凭空消失），而递归渲染这类结构会直接爆栈。
//! 所以环检测是硬约束，不是优化；深度上限同理。

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::time::now_iso;
use crate::db::in_transaction;
use crate::modules::books::service as book_service;
use crate::modules::chapters::models::ChapterCreateInput;
use crate::modules::chapters::repository as chapter_repository;
use crate::modules::chapters::service as chapter_service;

use super::models::{
    OutlineAttachChapterInput, OutlineMaterializeInput, OutlineMaterializeResult,
    OutlineNode, OutlineNodeCreateInput, OutlineNodeMoveInput, OutlineNodeRow,
    OutlineNodeUpdateInput, OutlineRemovalResult, OutlineTreeNode, OutlineTreeResult,
    LIMIT_DEPTH, LIMIT_PER_BOOK, NODE_TYPES, STATUSES,
};
use super::repository;

/// 树的索引。一次查询换两份映射，避免同一棵树被反复取回。
///
/// `parent_of` 用于「往上走」的判断（环检测、算层数），
/// `children_of` 用于「往下走」的判断（算子树的自身高度）。
struct OutlineIndex {
    parent_of: HashMap<i64, Option<i64>>,
    children_of: HashMap<i64, Vec<i64>>,
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

pub fn tree(conn: &Connection, book_id: i64) -> AppResult<OutlineTreeResult> {
    book_service::assert_book_exists(conn, book_id)?;

    let rows = repository::list_by_book(conn, book_id)?;
    let (nodes, depth) = build_tree(&rows);

    let mut status_counts: std::collections::BTreeMap<String, i64> =
        STATUSES.iter().map(|s| (s.to_string(), 0)).collect();
    let mut type_counts: std::collections::BTreeMap<String, i64> =
        NODE_TYPES.iter().map(|t| (t.to_string(), 0)).collect();
    let mut landed_count = 0i64;

    for row in &rows {
        let node = repository::to_outline_node(row);
        if let Some(count) = status_counts.get_mut(&node.status) {
            *count += 1;
        }
        if let Some(count) = type_counts.get_mut(&node.node_type) {
            *count += 1;
        }
        if node.chapter_id.is_some() {
            landed_count += 1;
        }
    }

    Ok(OutlineTreeResult {
        book_id,
        nodes,
        total: rows.len() as i64,
        depth,
        status_counts,
        type_counts,
        landed_count,
    })
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

pub fn create(conn: &Connection, input: &OutlineNodeCreateInput) -> AppResult<OutlineNode> {
    in_transaction(conn, |conn| {
        book_service::assert_book_exists(conn, input.book_id)?;

        if repository::count_by_book(conn, input.book_id)? >= LIMIT_PER_BOOK {
            return Err(AppError::validation(format!(
                "单本书的大纲节点不能超过 {LIMIT_PER_BOOK} 个"
            )));
        }

        let index = load_index(conn, input.book_id)?;

        if let Some(parent_id) = input.parent_id {
            if !index.parent_of.contains_key(&parent_id) {
                return Err(AppError::validation("父节点不存在或不属于当前书籍"));
            }
        }

        // 新建的节点自身没有子树，所以只需要看「父节点层数 + 1」
        let depth = match input.parent_id {
            None => 1,
            Some(parent_id) => depth_of(parent_id, &index.parent_of) + 1,
        };
        if depth > LIMIT_DEPTH {
            return Err(AppError::validation(format!(
                "大纲最多 {LIMIT_DEPTH} 层，不能再往下了。请先把节点移到一个更浅的位置"
            )));
        }

        let now = now_iso();
        let order_index = repository::next_order_index(conn, input.book_id, input.parent_id)?;
        let id = repository::insert(conn, input, order_index, &now)?;

        let created = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::internal(format!("新增大纲节点后无法回读记录（ID: {id}）")))?;

        logger::info(
            "大纲节点已创建",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("bookId", serde_json::json!(input.book_id)),
                ("parentId", serde_json::json!(input.parent_id)),
                ("depth", serde_json::json!(depth)),
            ]),
        );
        Ok(repository::to_outline_node(&created))
    })
}

pub fn update(conn: &Connection, input: &OutlineNodeUpdateInput) -> AppResult<OutlineNode> {
    in_transaction(conn, |conn| {
        if repository::find_by_id(conn, input.id)?.is_none() {
            return Err(AppError::not_found(format!(
                "大纲节点不存在（ID: {}）",
                input.id
            )));
        }

        if !repository::update_meta(conn, input, &now_iso())? {
            return Err(AppError::internal(format!(
                "大纲节点更新失败（ID: {}）",
                input.id
            )));
        }

        let updated = repository::find_by_id(conn, input.id)?.ok_or_else(|| {
            AppError::internal(format!("大纲节点更新后无法回读（ID: {}）", input.id))
        })?;

        logger::info(
            "大纲节点已更新",
            logger::fields(vec![("id", serde_json::json!(input.id))]),
        );
        Ok(repository::to_outline_node(&updated))
    })
}

pub fn remove(conn: &Connection, id: i64) -> AppResult<OutlineRemovalResult> {
    in_transaction(conn, |conn| {
        if repository::find_by_id(conn, id)?.is_none() {
            return Err(AppError::not_found(format!("大纲节点不存在（ID: {id}）")));
        }

        // 子节点由外键级联删除。先数清楚是为了让调用方能提示
        // 「将同时删除 N 个子节点」—— 删一棵长了两层的支线不该毫无预警。
        let removed_count = 1 + repository::count_descendants(conn, id)?;

        if !repository::delete_by_id(conn, id)? {
            return Err(AppError::internal(format!("大纲节点删除失败（ID: {id}）")));
        }

        logger::info(
            "大纲节点已删除",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("removedCount", serde_json::json!(removed_count)),
            ]),
        );
        Ok(OutlineRemovalResult { id, removed_count })
    })
}

pub fn move_node(conn: &Connection, input: &OutlineNodeMoveInput) -> AppResult<OutlineNode> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("大纲节点不存在（ID: {}）", input.id)))?;

        let node = repository::to_outline_node(&existing);
        let index = load_index(conn, node.book_id)?;

        if let Some(parent_id) = input.parent_id {
            if !index.parent_of.contains_key(&parent_id) {
                return Err(AppError::validation("目标父节点不存在或不属于当前书籍"));
            }
        }

        assert_no_cycle(node.id, input.parent_id, &index.parent_of)?;

        // 移动后的最大层数 = 目标父节点的层数 + 被移动子树自身的层数
        let subtree_height = subtree_height(node.id, &index.children_of);
        let parent_depth = match input.parent_id {
            None => 0,
            Some(parent_id) => depth_of(parent_id, &index.parent_of),
        };
        let new_depth = parent_depth + subtree_height;

        if new_depth > LIMIT_DEPTH {
            return Err(AppError::validation(format!(
                "移动后最深会到 {new_depth} 层，超过上限 {LIMIT_DEPTH} 层。请先减少这段的嵌套"
            )));
        }

        if !repository::move_node(conn, node.id, input.parent_id, input.target_index, &now_iso())? {
            return Err(AppError::internal(format!(
                "大纲节点移动失败（ID: {}）",
                node.id
            )));
        }

        let updated = repository::find_by_id(conn, node.id)?
            .ok_or_else(|| AppError::internal(format!("大纲节点移动后无法回读（ID: {}）", node.id)))?;

        logger::info(
            "大纲节点已移动",
            logger::fields(vec![
                ("id", serde_json::json!(node.id)),
                ("bookId", serde_json::json!(node.book_id)),
                ("parentId", serde_json::json!(input.parent_id)),
                ("targetIndex", serde_json::json!(input.target_index)),
            ]),
        );
        Ok(repository::to_outline_node(&updated))
    })
}

pub fn attach_chapter(
    conn: &Connection,
    input: &OutlineAttachChapterInput,
) -> AppResult<OutlineNode> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("大纲节点不存在（ID: {}）", input.id)))?;

        let node = repository::to_outline_node(&existing);

        if let Some(chapter_id) = input.chapter_id {
            let chapter = chapter_repository::find_list_item_by_id(conn, chapter_id)?
                .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {chapter_id}）")))?;

            // 跨书关联和跨书挂载分卷是同一类越权写入：
            // 会让 A 书的章节出现在 B 书的大纲里
            if chapter.book_id != node.book_id {
                return Err(AppError::validation("该章节不属于当前书籍，无法关联到大纲"));
            }

            if let Some((_, title)) =
                repository::find_by_chapter_id(conn, chapter_id, node.id)?
            {
                return Err(AppError::conflict(format!(
                    "这一章已经关联到节点「{title}」，请先解除那边的关联"
                )));
            }
        }

        if !repository::attach_chapter(conn, input, &now_iso())? {
            return Err(AppError::internal(format!(
                "关联章节失败（节点 ID: {}）",
                input.id
            )));
        }

        let updated = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::internal(format!("关联章节后无法回读节点（ID: {}）", input.id)))?;

        logger::info(
            "大纲节点关联章节已更新",
            logger::fields(vec![
                ("id", serde_json::json!(input.id)),
                ("chapterId", serde_json::json!(input.chapter_id)),
            ]),
        );
        Ok(repository::to_outline_node(&updated))
    })
}

/// 把节点落地成**新章节**。
///
/// 「落地成章节」复用章节服务，而不是自己往 `chapters` 表插一行。章节创建的
/// 规则（标题处理、字数初始化、分卷归属校验、书籍 touch）都在那里，
/// 另写一份迟早会与它漂移。事务用同一套 SAVEPOINT 机制嵌套，因此
/// 「建章节 + 建关联」对外仍然是一个原子操作。
pub fn materialize(
    conn: &Connection,
    input: &OutlineMaterializeInput,
) -> AppResult<OutlineMaterializeResult> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("大纲节点不存在（ID: {}）", input.id)))?;

        let node = repository::to_outline_node(&existing);

        if let Some(chapter_id) = node.chapter_id {
            let current = chapter_repository::find_list_item_by_id(conn, chapter_id)?;
            let title = current
                .map(|item| item.title)
                .unwrap_or_else(|| format!("章节 {chapter_id}"));
            return Err(AppError::conflict(format!(
                "该节点已经落地到《{title}》。若要重新落地，请先解除现有章节的关联。"
            )));
        }

        let chapter = chapter_service::create(
            conn,
            &ChapterCreateInput {
                book_id: node.book_id,
                volume_id: input.volume_id,
                title: node.title.clone(),
                target_words: input.target_words,
            },
        )?;

        if !repository::attach_chapter(
            conn,
            &OutlineAttachChapterInput {
                id: node.id,
                chapter_id: Some(chapter.id),
            },
            &now_iso(),
        )? {
            return Err(AppError::internal(format!(
                "落地后关联章节失败（节点 ID: {}）",
                node.id
            )));
        }

        logger::info(
            "大纲节点已落地成章节",
            logger::fields(vec![
                ("nodeId", serde_json::json!(node.id)),
                ("chapterId", serde_json::json!(chapter.id)),
                ("bookId", serde_json::json!(node.book_id)),
            ]),
        );

        Ok(OutlineMaterializeResult {
            node_id: node.id,
            chapter_id: chapter.id,
            chapter_title: chapter.title,
        })
    })
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

fn load_index(conn: &Connection, book_id: i64) -> AppResult<OutlineIndex> {
    let mut parent_of: HashMap<i64, Option<i64>> = HashMap::new();
    let mut children_of: HashMap<i64, Vec<i64>> = HashMap::new();

    for row in repository::list_by_book(conn, book_id)? {
        parent_of.insert(row.id, row.parent_id);
        if let Some(parent_id) = row.parent_id {
            children_of.entry(parent_id).or_default().push(row.id);
        }
    }

    Ok(OutlineIndex {
        parent_of,
        children_of,
    })
}

/// 节点层数（根层为 1）。
///
/// 带 `seen` 集合：数据里若已经存在环（手工改库造成），顺着父指针往上走会转圈，
/// 这里必须能自己停下来。
fn depth_of(id: i64, parent_of: &HashMap<i64, Option<i64>>) -> i64 {
    let mut depth = 1;
    let mut cursor = parent_of.get(&id).copied().flatten();
    let mut seen: HashSet<i64> = HashSet::new();
    seen.insert(id);

    while let Some(current) = cursor {
        if seen.contains(&current) {
            break;
        }
        seen.insert(current);
        depth += 1;
        cursor = parent_of.get(&current).copied().flatten();
    }

    depth
}

/// 环检测：把节点挂到 `new_parent_id` 之下，会不会形成环？
///
/// 做法是从候选父节点**往上**走父指针，如果能走回自己，说明候选父节点就在
/// 自己的子树里。比「往下遍历自己的子树找候选父节点」便宜得多，复杂度只跟
/// 深度有关，而深度有上限。
fn assert_no_cycle(
    id: i64,
    new_parent_id: Option<i64>,
    parent_of: &HashMap<i64, Option<i64>>,
) -> AppResult<()> {
    let Some(mut cursor) = new_parent_id else {
        return Ok(());
    };

    let mut seen: HashSet<i64> = HashSet::new();
    loop {
        if cursor == id {
            return Err(AppError::validation(
                "不能把节点移动到它自己或它自己的子节点之下，那样会在树上形成环",
            ));
        }
        // 数据里本来就有环：再走下去是空转，交给「提升到根层显示」那条兜底
        if !seen.insert(cursor) {
            return Ok(());
        }
        match parent_of.get(&cursor).copied().flatten() {
            Some(next) => cursor = next,
            None => return Ok(()),
        }
    }
}

/// 子树的自身层数（叶子为 1）。
///
/// 用逐层展开而不是递归：递归实现遇到环会爆栈，而这里要处理的对象恰恰可能是坏数据。
fn subtree_height(root_id: i64, children_of: &HashMap<i64, Vec<i64>>) -> i64 {
    let mut height = 0;
    let mut frontier = vec![root_id];
    let mut seen: HashSet<i64> = HashSet::new();

    while !frontier.is_empty() {
        height += 1;
        let mut next: Vec<i64> = Vec::new();

        for current in frontier {
            if !seen.insert(current) {
                continue;
            }
            if let Some(children) = children_of.get(&current) {
                next.extend(children.iter().copied());
            }
        }

        frontier = next;
    }

    height
}

/// 平铺的行 → 树。
///
/// 两个防御点，都针对「数据里有环」这种只可能来自手工改库的状态：
///
/// 1. 遍历带 visited 集合，重复访问的节点不再展开 —— 否则递归会无限下去。
/// 2. 环上的节点从任何根都走不到，会整个从界面上消失（数据在却看不见，
///    比顺序不对更难排查）。所以遍历结束后把没访问到的节点提升到根层，
///    让用户至少能看到它并手动整理。
fn build_tree(rows: &[OutlineNodeRow]) -> (Vec<OutlineTreeNode>, i64) {
    let mut base: HashMap<i64, OutlineTreeNode> = HashMap::new();
    for row in rows {
        let node = repository::to_outline_node(row);
        base.insert(
            row.id,
            OutlineTreeNode {
                id: node.id,
                book_id: node.book_id,
                parent_id: node.parent_id,
                chapter_id: node.chapter_id,
                node_type: node.node_type,
                title: node.title,
                summary: node.summary,
                status: node.status,
                order_index: node.order_index,
                created_at: node.created_at,
                updated_at: node.updated_at,
                children: Vec::new(),
                chapter_title: row.chapter_title.clone(),
                chapter_status: repository::to_chapter_status(row.chapter_status.clone()),
                descendant_count: 0,
            },
        );
    }

    let mut children_of: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut roots: Vec<i64> = Vec::new();

    for row in rows {
        match row.parent_id {
            None => roots.push(row.id),
            Some(parent_id) => {
                if base.contains_key(&parent_id) {
                    children_of.entry(parent_id).or_default().push(row.id);
                } else {
                    // 父节点不在本书里（脏数据）—— 也当根层显示
                    roots.push(row.id);
                }
            }
        }
    }

    let mut visited: HashSet<i64> = HashSet::new();
    let mut depth = 0i64;
    let mut ordered: Vec<OutlineTreeNode> = Vec::new();

    for root_id in roots {
        if visited.contains(&root_id) {
            continue;
        }
        let node = build_node(root_id, 1, &base, &children_of, &mut visited, &mut depth);
        ordered.push(node);
    }

    // 兜底：从任何根都到不了的节点（环上的），提升到根层
    for row in rows {
        if visited.contains(&row.id) {
            continue;
        }
        logger::warn(
            "大纲存在从根节点无法到达的节点，已提升到根层显示",
            logger::fields(vec![
                ("id", serde_json::json!(row.id)),
                ("bookId", serde_json::json!(row.book_id)),
                ("parentId", serde_json::json!(row.parent_id)),
            ]),
        );
        let node = build_node(row.id, 1, &base, &children_of, &mut visited, &mut depth);
        ordered.push(node);
    }

    (ordered, depth)
}

fn build_node(
    id: i64,
    level: i64,
    base: &HashMap<i64, OutlineTreeNode>,
    children_of: &HashMap<i64, Vec<i64>>,
    visited: &mut HashSet<i64>,
    depth: &mut i64,
) -> OutlineTreeNode {
    // `base` 里一定有这一条：调用方只会传出现过的 id
    let mut node = match base.get(&id) {
        Some(node) => node.clone(),
        None => return placeholder_node(id),
    };

    visited.insert(id);
    if level > *depth {
        *depth = level;
    }

    let mut total = 0i64;
    if let Some(kids) = children_of.get(&id) {
        for child_id in kids {
            // 已经访问过的子节点不再挂一次：数据里有环时，挂上去会让 JSON
            // 序列化陷入无限递归（TS 版在这一点上其实会爆掉，只是环只可能
            // 来自手工改库，所以一直没暴露）。跳过之后这个节点仍然会以根层
            // 的身份出现在结果里，用户至少能看到它并手动整理。
            if visited.contains(child_id) {
                continue;
            }
            let child = build_node(*child_id, level + 1, base, children_of, visited, depth);
            total += child.descendant_count + 1;
            node.children.push(child);
        }
    }
    node.descendant_count = total;
    node
}

/// 理论到不了这里的分支：`build_node` 只会被传入 `base` 里存在的 id。
/// 真到了这里也不 panic —— 一个树节点渲染成空节点，比整个大纲接口 500 好。
fn placeholder_node(id: i64) -> OutlineTreeNode {
    OutlineTreeNode {
        id,
        book_id: 0,
        parent_id: None,
        chapter_id: None,
        node_type: String::new(),
        title: String::new(),
        summary: String::new(),
        status: "planned".into(),
        order_index: 0,
        created_at: String::new(),
        updated_at: String::new(),
        children: Vec::new(),
        chapter_title: None,
        chapter_status: None,
        descendant_count: 0,
    }
}
