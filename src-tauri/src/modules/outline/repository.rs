//! 大纲仓储。
//!
//! 只做平铺的取与写，不做树形组装 —— 理由见 `models::OutlineNodeRow` 的注释。

use rusqlite::{Connection, Row};

use crate::core::errors::AppResult;
use crate::db::sql_utils::to_number;

use super::models::{
    is_valid_node_type, is_valid_status, OutlineAttachChapterInput, OutlineNode,
    OutlineNodeCreateInput, OutlineNodeRow, OutlineNodeUpdateInput,
};

const SELECT_COLUMNS: &str = "
  o.id, o.book_id, o.parent_id, o.chapter_id, o.node_type, o.title, o.summary,
  o.status, o.order_index, o.created_at, o.updated_at,
  c.title  AS chapter_title,
  c.status AS chapter_status
";

/// 关联章节用 LEFT JOIN 而不是子查询：主查询本身就要取全表，子查询会对每一行
/// 再跑一次。JOIN 一次搞定，且能顺带拿到章节状态。
///
/// `AND c.deleted_at IS NULL` 放在 **ON** 里而不是 WHERE 里，这是关键：
/// 写进 WHERE 会让「章节进了回收站」的节点整行被滤掉 —— 作者会看到大纲上
/// 凭空少了一个情节节点，而那个节点的层级、备注、其它信息都还在，只是它关联的
/// 章节被删了。放进 ON 之后，节点照常出现，只是它的 `chapter_id` 读出来是 null
/// （那一章确实已经不在工作视野里了）；作者从回收站把章节捞回来，这个关联就
/// 自动恢复 —— 这正是软删除比起硬删除多出来的那一份能力。
const FROM_CLAUSE: &str = "
  FROM outline_nodes o
  LEFT JOIN chapters c ON c.id = o.chapter_id AND c.deleted_at IS NULL
";

/// 行 → 领域对象。
///
/// `node_type` / `status` 在数据库里是 TEXT，理论上允许任意字符串。这里做一次
/// 收敛：认不出来的值退回默认，而不是原样透传给前端 —— 否则前端拿到未知枚举
/// 会渲染出空白标签，且类型系统还以为它是安全的。正常流程写不进非法值
/// （边界校验挡着），这是针对手工改库或旧版本数据的兜底。
fn read_row(row: &Row<'_>) -> rusqlite::Result<OutlineNodeRow> {
    let node_type: String = row.get("node_type")?;
    let status: String = row.get("status")?;
    Ok(OutlineNodeRow {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        parent_id: row.get("parent_id")?,
        chapter_id: row.get("chapter_id")?,
        node_type: if is_valid_node_type(&node_type) {
            node_type
        } else {
            "event".to_string()
        },
        title: row.get("title")?,
        summary: row.get("summary")?,
        status: if is_valid_status(&status) {
            status
        } else {
            "planned".to_string()
        },
        order_index: row.get("order_index")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        chapter_title: row.get("chapter_title")?,
        chapter_status: row.get("chapter_status")?,
    })
}

/// 行 → 契约里的节点。
pub fn to_outline_node(row: &OutlineNodeRow) -> OutlineNode {
    OutlineNode {
        id: row.id,
        book_id: row.book_id,
        parent_id: row.parent_id,
        chapter_id: row.chapter_id,
        node_type: row.node_type.clone(),
        title: row.title.clone(),
        summary: row.summary.clone(),
        status: row.status.clone(),
        order_index: row.order_index,
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

/// 章节状态在数据库里也是 TEXT，同样需要收敛成枚举再交给前端。
/// 未关联章节时为 None，这里原样保留。
pub fn to_chapter_status(value: Option<String>) -> Option<String> {
    value.filter(|status| crate::modules::chapters::models::is_valid_status(status))
}

/// 取一本书的全部节点（平铺）。
///
/// 按 `order_index` 全局排序即可：服务层会按 `parent_id` 分组，同一父节点下的
/// 相对顺序就保持住了，不需要为每个父节点单独排序。
pub fn list_by_book(conn: &Connection, book_id: i64) -> AppResult<Vec<OutlineNodeRow>> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS}
           {FROM_CLAUSE}
          WHERE o.book_id = ?
          ORDER BY o.order_index ASC, o.id ASC"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([book_id], read_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<OutlineNodeRow>> {
    let sql = format!("SELECT {SELECT_COLUMNS} {FROM_CLAUSE} WHERE o.id = ?");
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query_map([id], read_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn count_by_book(conn: &Connection, book_id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COUNT(*) AS n FROM outline_nodes WHERE book_id = ?",
        [book_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 找出已经关联了这个章节的其它节点。
///
/// 用于阻止两个节点同时指向同一章：那样「这一章要写什么」就有两个答案，
/// 落地的含义被稀释，而作者本人往往意识不到自己挂重了。一条支线跨多章是正常的，
/// 但那是「一个节点 + 多个章节」，应该用嵌套节点或父子结构表达，
/// 而不是让两个节点争夺同一章。
pub fn find_by_chapter_id(
    conn: &Connection,
    chapter_id: i64,
    exclude_id: i64,
) -> AppResult<Option<(i64, String)>> {
    let mut statement = conn.prepare(
        "SELECT id, title FROM outline_nodes WHERE chapter_id = ? AND id <> ? LIMIT 1",
    )?;
    let mut rows = statement.query_map([chapter_id, exclude_id], |row| {
        Ok((row.get::<_, i64>("id")?, row.get::<_, String>("title")?))
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 某个父节点下的子节点 id，按当前顺序。用于移动时重编号。
pub fn list_ids_by_parent(
    conn: &Connection,
    book_id: i64,
    parent_id: Option<i64>,
) -> AppResult<Vec<i64>> {
    let mut statement = conn.prepare(
        "SELECT id FROM outline_nodes
          WHERE book_id = ? AND parent_id IS ?
          ORDER BY order_index ASC, id ASC",
    )?;
    let rows = statement.query_map(rusqlite::params![book_id, parent_id], |row| {
        row.get::<_, i64>("id")
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 追加到某个父节点末尾时的下标。
///
/// `parent_id IS ?` 而不是 `= ?`：SQLite 的 `=` 遇到 NULL 结果是 NULL（视同假），
/// 用 `=` 查根层节点会永远查不到，表现为「新建的根节点下标永远是 0」。
pub fn next_order_index(
    conn: &Connection,
    book_id: i64,
    parent_id: Option<i64>,
) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "SELECT COALESCE(MAX(order_index) + 1, 0) AS n FROM outline_nodes
          WHERE book_id = ? AND parent_id IS ?",
        rusqlite::params![book_id, parent_id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

/// 子孙节点总数（不含自身）。删除前用它提示会影响多少节点。
pub fn count_descendants(conn: &Connection, id: i64) -> AppResult<i64> {
    Ok(to_number(conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
           SELECT id FROM outline_nodes WHERE parent_id = ?
           UNION ALL
           SELECT o.id FROM outline_nodes o JOIN subtree s ON o.parent_id = s.id
         )
         SELECT COUNT(*) AS n FROM subtree",
        [id],
        |row| row.get::<_, Option<i64>>(0),
    )?))
}

pub fn insert(
    conn: &Connection,
    input: &OutlineNodeCreateInput,
    order_index: i64,
    now: &str,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO outline_nodes
           (book_id, parent_id, chapter_id, node_type, title, summary, status, order_index, created_at, updated_at)
         VALUES
           (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            input.book_id,
            input.parent_id,
            input.node_type,
            input.title,
            input.summary,
            input.status,
            order_index,
            now,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_meta(
    conn: &Connection,
    input: &OutlineNodeUpdateInput,
    now: &str,
) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE outline_nodes
            SET node_type = ?, title = ?, summary = ?, status = ?, updated_at = ?
          WHERE id = ?",
        rusqlite::params![
            input.node_type,
            input.title,
            input.summary,
            input.status,
            now,
            input.id
        ],
    )?;
    Ok(changed > 0)
}

/// 移动节点并重编号。
///
/// 顺序**完全由数据库的当前状态算出**，不接受调用方提交的兄弟列表 ——
/// 客户端手里的树可能是旧的，并发拖拽时提交上来的顺序会覆盖别人的改动。
/// 调用方只表达「放到谁的下面、第几个」。
///
/// 这个方法刻意把「源父节点要不要压缩」也自己判断，而不是让服务层传两个列表
/// 进来：那个判断很容易写错（章节移动就先踩过一次 —— 同容器换位时多压缩了
/// 一遍源容器，把目标容器刚编好的下标覆盖回去，产生了重复的 order_index）。
/// 放在这里只有一处实现，调用方没有机会传错。
pub fn move_node(
    conn: &Connection,
    id: i64,
    parent_id: Option<i64>,
    target_index: i64,
    now: &str,
) -> AppResult<bool> {
    let current = conn
        .query_row(
            "SELECT book_id, parent_id FROM outline_nodes WHERE id = ?",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>("book_id")?,
                    row.get::<_, Option<i64>>("parent_id")?,
                ))
            },
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;

    let Some((book_id, current_parent_id)) = current else {
        return Ok(false);
    };

    // 目标父节点下除自己以外的顺序，再把自己插到落点
    let mut target_siblings = list_ids_by_parent(conn, book_id, parent_id)?;
    target_siblings.retain(|sibling_id| *sibling_id != id);

    let index = target_index.clamp(0, target_siblings.len() as i64) as usize;
    let mut next_target = target_siblings.clone();
    next_target.insert(index, id);

    conn.execute(
        "UPDATE outline_nodes SET parent_id = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![parent_id, now, id],
    )?;

    let mut statement =
        conn.prepare("UPDATE outline_nodes SET order_index = ? WHERE id = ?")?;

    // 上面这一遍已经把目标父节点下的全部兄弟（含自己）编号好了
    for (position, sibling_id) in next_target.iter().enumerate() {
        statement.execute(rusqlite::params![position as i64, sibling_id])?;
    }

    // 只有换了父节点才需要压缩源：同父节点内换位时，源与目标是同一批节点，
    // 再编一遍只会把上一步的结果覆盖掉
    if current_parent_id != parent_id {
        let mut source_siblings = list_ids_by_parent(conn, book_id, current_parent_id)?;
        source_siblings.retain(|sibling_id| *sibling_id != id);
        for (position, sibling_id) in source_siblings.iter().enumerate() {
            statement.execute(rusqlite::params![position as i64, sibling_id])?;
        }
    }

    Ok(true)
}

pub fn attach_chapter(
    conn: &Connection,
    input: &OutlineAttachChapterInput,
    now: &str,
) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE outline_nodes SET chapter_id = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![input.chapter_id, now, input.id],
    )?;
    Ok(changed > 0)
}

pub fn delete_by_id(conn: &Connection, id: i64) -> AppResult<bool> {
    // 子节点由 parent_id 的 ON DELETE CASCADE 一并删除；
    // chapters.chapter_id 则是 ON DELETE SET NULL，删章节不会带走大纲节点。
    let changed = conn.execute("DELETE FROM outline_nodes WHERE id = ?", [id])?;
    Ok(changed > 0)
}
