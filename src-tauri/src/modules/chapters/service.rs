//! 章节服务。全应用最核心的一层。
//!
//! 三条不显然但必须保留的性质：
//!
//! 1. **回档本身也是可以再回档的**。执行前先把当前正文按正常规则留一份快照，
//!    于是「误点回档」不会造成新的不可逆损失 —— 作者再回一次就能回到回档之前。
//!    少了这一步，回档就成了整个功能里唯一一个会真丢数据的地方。
//! 2. **删除是软删除，且在回收站外重排容器**。章节的 `order_index` 在活着的
//!    章节里必须是连续的 `0..n-1` —— 拖拽移动的算法建立在这个前提上。
//!    留着空位的话，下一次移动会基于带空洞的序列计算，结果看起来像是「跳了一格」。
//! 3. **恢复不动书的 `updated_at`**，而删除会动。恢复没有改变这本书的内容，
//!    只是把之前拿走的东西还回去；碰它的话，从回收站捞一章回来就会把整本书
//!    顶到书架最前面 —— 而那个位置应当留给真的在写的书。

use std::collections::HashSet;

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::text::{html_to_text, measure_text};
use crate::core::time::now_iso;
use crate::db::in_transaction;
use crate::modules::books::service as book_service;
use crate::modules::trash::models::{TrashEntry, TrashItemRef};
use crate::modules::volumes::repository as volume_repository;

use super::models::{
    Chapter, ChapterCreateInput, ChapterListItem, ChapterListQuery, ChapterMoveInput,
    ChapterRemovalResult, ChapterReorderInput, ChapterReorderResult, ChapterRestoreResult,
    ChapterRevision, ChapterRevisionSummary, ChapterSaveContentInput, ChapterSaveResult,
    ChapterUpdateInput, RevisionBaseline, RevisionBaselines, LIMIT_PER_BOOK,
    REVISION_MIN_DELTA_RATIO, REVISION_MIN_HANZI, REVISION_PER_CHAPTER,
};
use super::{repository, revision_repository};

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

pub fn list(conn: &Connection, query: &ChapterListQuery) -> AppResult<Vec<ChapterListItem>> {
    book_service::assert_book_exists(conn, query.book_id)?;
    if let Some(Some(volume_id)) = query.volume_id {
        assert_volume_in_book(conn, volume_id, query.book_id)?;
    }
    repository::list(conn, query)
}

pub fn get_by_id(conn: &Connection, id: i64) -> AppResult<Chapter> {
    repository::find_by_id(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {id}）")))
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

pub fn create(conn: &Connection, input: &ChapterCreateInput) -> AppResult<ChapterListItem> {
    in_transaction(conn, |conn| {
        book_service::assert_book_exists(conn, input.book_id)?;
        if let Some(volume_id) = input.volume_id {
            assert_volume_in_book(conn, volume_id, input.book_id)?;
        }

        if repository::count_by_book(conn, input.book_id)? >= LIMIT_PER_BOOK {
            return Err(AppError::validation(format!(
                "单本书的章节数量不能超过 {LIMIT_PER_BOOK} 章"
            )));
        }

        // 章节标题刻意不强制唯一：多篇「番外」、分上下篇用同名标题
        // 在真实创作里都是合理的，强制唯一只会逼作者加无意义的编号后缀。
        let now = now_iso();
        let order_index = repository::next_order_index(conn, input.book_id, input.volume_id)?;
        let created = repository::insert(
            conn,
            input.book_id,
            input.volume_id,
            &input.title,
            input.target_words,
            order_index,
            &now,
        )?;

        book_service::touch_book(conn, input.book_id)?;
        logger::info(
            "章节已创建",
            logger::fields(vec![
                ("id", serde_json::json!(created.id)),
                ("bookId", serde_json::json!(created.book_id)),
            ]),
        );
        Ok(created)
    })
}

/// 更新元数据。若同时改变了所属分卷，等价于一次「移动」——
/// 但它应该落到目标容器的末尾，因为用户是在编辑弹窗里改归属，
/// 不是在列表里拖拽，没有落点信息。
pub fn update(conn: &Connection, input: &ChapterUpdateInput) -> AppResult<ChapterListItem> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {}）", input.id)))?;

        if let Some(volume_id) = input.volume_id {
            assert_volume_in_book(conn, volume_id, existing.book_id)?;
        }

        let now = now_iso();
        let container_changed = input.volume_id != existing.volume_id;

        if container_changed {
            let mut target_ids = repository::list_ids_in_container(conn, existing.book_id, input.volume_id)?;
            target_ids.retain(|id| *id != input.id);
            target_ids.push(input.id);

            // 源容器的重排序列必须在移动**之前**取，且要包含自己——
            // apply_move 内部会把它过滤掉，再合拢剩下的空位
            let source_ids =
                repository::list_ids_in_container(conn, existing.book_id, existing.volume_id)?;

            repository::apply_move(
                conn,
                input.id,
                input.volume_id,
                &source_ids,
                &target_ids,
                &now,
            )?;
        }

        let updated = repository::update_meta(conn, input, &now)?
            .ok_or_else(|| AppError::internal(format!("章节更新失败（ID: {}）", input.id)))?;

        book_service::touch_book(conn, existing.book_id)?;
        logger::info(
            "章节已更新",
            logger::fields(vec![
                ("id", serde_json::json!(updated.id)),
                ("containerChanged", serde_json::json!(container_changed)),
            ]),
        );
        Ok(updated)
    })
}

/// 保存正文。
///
/// 这是全应用写入最频繁的接口（编辑器自动保存）。三个派生值由后端从 HTML
/// 现算，而不是让前端把算好的字数一并送过来 —— 派生数据只允许有一个
/// 产生它的地方，否则迟早出现「正文和字数对不上」的记录。
///
/// 顺带留一份历史版本：抓的是**被替换掉的旧正文**，也就是作者后悔时想退回的那一版。
pub fn save_content(
    conn: &Connection,
    baselines: &mut RevisionBaselines,
    input: &ChapterSaveContentInput,
) -> AppResult<ChapterSaveResult> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {}）", input.id)))?;

        // 只转一次文本：measure_text 内部不会再走一遍 html_to_text，
        // 两者都调用等于把同一份 HTML 解析两次
        let content_text = html_to_text(&input.content_html);
        let metrics = measure_text(&content_text);
        let now = now_iso();

        // 留快照必须在覆盖之前，此时 existing 里还是旧正文
        let snapshot_kept = keep_snapshot(conn, baselines, &existing, &now)?;

        let saved = repository::save_content(
            conn,
            input,
            &content_text,
            metrics.hanzi as i64,
            metrics.characters as i64,
            &now,
        )?
        .ok_or_else(|| AppError::internal(format!("章节正文保存失败（ID: {}）", input.id)))?;

        // 碰一下书，让书架按「最近写作」排序而不是按创建时间
        book_service::touch_book(conn, existing.book_id)?;

        logger::debug(
            "章节正文已保存",
            logger::fields(vec![
                ("id", serde_json::json!(saved.id)),
                ("hanzi", serde_json::json!(saved.hanzi_count)),
                ("chars", serde_json::json!(saved.char_count)),
                ("snapshotKept", serde_json::json!(snapshot_kept)),
            ]),
        );

        Ok(ChapterSaveResult {
            id: saved.id,
            hanzi_count: saved.hanzi_count,
            char_count: saved.char_count,
            updated_at: saved.updated_at,
        })
    })
}

/* ------------------------------------------------------------------ *
 * 历史版本
 * ------------------------------------------------------------------ */

pub fn list_revisions(conn: &Connection, chapter_id: i64) -> AppResult<Vec<ChapterRevisionSummary>> {
    // 章节不存在就报错，而不是返回空数组：前者是调用方 bug，
    // 后者会让界面显示「暂无历史版本」这个误导性的空状态
    if !repository::exists(conn, chapter_id)? {
        return Err(AppError::not_found(format!("章节不存在（ID: {chapter_id}）")));
    }
    revision_repository::list_by_chapter(conn, chapter_id)
}

pub fn get_revision(conn: &Connection, id: i64) -> AppResult<ChapterRevision> {
    revision_repository::find_by_id(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("历史版本不存在（ID: {id}）")))
}

/// 回档到某一版。见文件头第 1 条性质。
pub fn restore_revision(
    conn: &Connection,
    baselines: &mut RevisionBaselines,
    chapter_id: i64,
    revision_id: i64,
) -> AppResult<ChapterRestoreResult> {
    in_transaction(conn, |conn| {
        let chapter = repository::find_by_id(conn, chapter_id)?
            .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {chapter_id}）")))?;

        let revision = revision_repository::find_by_id(conn, revision_id)?
            .ok_or_else(|| AppError::not_found(format!("历史版本不存在（ID: {revision_id}）")))?;

        // 版本 id 与章节 id 是两个独立的自增序列，用户传任意组合都能过 schema。
        // 不做这一步校验的话，A 章的版本能被灌进 B 章，造成跨章节的静默污染。
        if revision.chapter_id != chapter_id {
            return Err(AppError::validation("该版本不属于此章节，无法回档"));
        }

        let now = now_iso();

        // 先留当前版本 —— 回档是可撤销的（见文件头）
        let snapshot_kept = keep_snapshot(conn, baselines, &chapter, &now)?;

        /*
         * 正文与三个派生值同样取自快照，**不重算** hanzi / char。
         *
         * 重算在正常情况下会得到同样的数字，但快照存的正是「当时正文 +
         * 当时算出的字数」，两者一致；一旦重算，任何一次度量口径的调整
         * 都会让回档后的字数与历史列表里显示的对不上，看着像回档没生效。
         * 直接搬运保持这一版的自我一致。
         */
        let input = ChapterSaveContentInput {
            id: chapter_id,
            content_html: revision.content_html.clone(),
        };
        let restored = repository::save_content(
            conn,
            &input,
            &revision.content_text,
            revision.hanzi_count,
            revision.char_count,
            &now,
        )?
        .ok_or_else(|| AppError::internal(format!("章节回档失败（ID: {chapter_id}）")))?;

        // 回档也是一次写作上的改动，书架排序应当跟上
        book_service::touch_book(conn, chapter.book_id)?;

        logger::info(
            "章节已回档",
            logger::fields(vec![
                ("chapterId", serde_json::json!(chapter_id)),
                ("revisionId", serde_json::json!(revision_id)),
                ("hanzi", serde_json::json!(restored.hanzi_count)),
                ("snapshotKept", serde_json::json!(snapshot_kept)),
            ]),
        );

        Ok(ChapterRestoreResult {
            id: restored.id,
            hanzi_count: restored.hanzi_count,
            char_count: restored.char_count,
            updated_at: restored.updated_at,
            snapshot_kept,
        })
    })
}

/// 三条留版路径 + 三个跳过条件。详见 前端同名方法那一大段注释，这里只记结论：
///
/// **基准是「上一次真正留版时被替换掉的那份正文」**，不是「最新一版快照」，
/// 也不是「上一次见过的正文」——
///   - 拿快照表当基准：被阈值拒掉的改动不留快照，基准会越来越旧，
///     接下来每次改动都在跟一个陈旧的版本比，比例越算越大，
///     最后「每敲一个字都留一版」，配额被瞬间填满；
///   - 拿「上一次见过的正文」当基准：基准变「新」得太快，小改动
///     永远累积不到阈值，而「持续小改」恰恰是最常见的写作节奏。
fn keep_snapshot(
    conn: &Connection,
    baselines: &mut RevisionBaselines,
    chapter: &Chapter,
    now: &str,
) -> AppResult<bool> {
    let metrics = measure_text(&chapter.content_text);

    /*
     * 正文过短：**不记基准**。
     *
     * 短正文（新建的章第一次保存，改动前是空正文）没有保存价值，而它
     * 恰恰是基准最容易被一个无意义的值占住的时刻 —— 章刚建好，作者的
     * 输入集中在开头几秒，而自动保存两秒一次，很容易把「空正文」或
     * 「三个字」记成基准。此后每一次真实输入都在跟这个几乎为零的分母比，
     * 比例必然巨大，于是**开头连着留好几版碎片**。
     * 不记基准，等于把基准的初始化推迟到「正文已经写得像样」之后。
     */
    if metrics.hanzi == 0 || metrics.hanzi < REVISION_MIN_HANZI {
        return Ok(false);
    }

    // 先把决策算出来，再动 baselines：否则「读基准」的不可变借用会与
    // 「写基准」的可变借用打架（顺带也省掉了每两秒一次的快照内容克隆）
    enum Decision {
        /// 首次见到这一章的正文，无条件留下
        First,
        /// 与基准完全相同 / 差异过小，跳过
        Skip,
        Keep,
    }

    let decision = match baselines.get(&chapter.id) {
        None => Decision::First,
        Some(baseline) => {
            if baseline.content_html == chapter.content_html {
                Decision::Skip
            } else {
                /*
                 * 分母是**基准**而不是「改动前的正文」：基准是上一次留版时
                 * 留下的那一份，因此这里量的是「自上一版留存至今累计改了多少」。
                 * 单次敲三个字不达标，但连敲二十次就是一大段 —— 累积量越线时
                 * 自然会被留下。预留下限 1 是为了避免短正文时除零。
                 */
                let reference = baseline.hanzi_count.max(1) as f64;
                let delta = (metrics.hanzi as i64 - baseline.hanzi_count).unsigned_abs() as f64;
                if delta / reference < REVISION_MIN_DELTA_RATIO {
                    Decision::Skip
                } else {
                    Decision::Keep
                }
            }
        }
    };

    match decision {
        Decision::Skip => Ok(false),
        Decision::First | Decision::Keep => {
            insert_snapshot_of(conn, chapter, metrics.hanzi as i64, metrics.characters as i64, now)?;

            // 基准前移到**刚刚存进快照的这一份**：它正是「现在可以用回档
            // 换回来的那一版」。下一次判定就是拿候选正文与它比 ——
            // 这样每一次留版之间至少隔着一个阈值。
            baselines.insert(
                chapter.id,
                RevisionBaseline {
                    content_html: chapter.content_html.clone(),
                    hanzi_count: metrics.hanzi as i64,
                },
            );

            revision_repository::prune(conn, chapter.id, REVISION_PER_CHAPTER)?;
            Ok(true)
        }
    }
}

/// 把这一份正文写成一版快照。
fn insert_snapshot_of(
    conn: &Connection,
    chapter: &Chapter,
    hanzi_count: i64,
    char_count: i64,
    now: &str,
) -> AppResult<i64> {
    revision_repository::insert_snapshot(
        conn,
        chapter.id,
        &chapter.content_html,
        &chapter.content_text,
        hanzi_count,
        char_count,
        now,
    )
}

/* ------------------------------------------------------------------ *
 * 删除（软删除）与回收站
 * ------------------------------------------------------------------ */

pub fn remove(conn: &Connection, id: i64) -> AppResult<ChapterRemovalResult> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {id}）")))?;

        let now = now_iso();
        if !repository::soft_delete(conn, id, &now)? {
            return Err(AppError::internal(format!("章节删除失败（ID: {id}）")));
        }

        // 删掉中间一章后要合拢空位，否则 order_index 出现空洞，
        // 下次拖拽移动时基于顺序的计算会带上这些幽灵下标
        reindex_container(conn, existing.book_id, existing.volume_id, &now)?;

        // 历史版本不随软删除消失（chapter_revisions 的 CASCADE 只在真正
        // DELETE 时触发）—— 这正是「恢复之后历史版本还在」的原因。
        // 恢复一章却发现它的历史被清空了，比不恢复更让人难受。

        book_service::touch_book(conn, existing.book_id)?;

        logger::info(
            "章节已移入回收站",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("bookId", serde_json::json!(existing.book_id)),
            ]),
        );
        Ok(ChapterRemovalResult { id })
    })
}

/// 回收站里的章节，最近删除的在前。
pub fn list_deleted(conn: &Connection, limit: i64) -> AppResult<Vec<TrashEntry>> {
    let rows = repository::list_deleted(conn, limit)?;
    Ok(rows
        .into_iter()
        .map(|row| TrashEntry {
            id: row.id,
            title: row.title,
            // 卷名放在副标题位置：一本书里「第 3 章」这种标题会重复出现，
            // 卷名是唯一能立刻区分两条记录的线索（未分卷时它为空串）
            subtitle: row.volume_title.unwrap_or_default(),
            book_id: Some(row.book_id),
            book_title: row.book_title,
            deleted_at: row.deleted_at,
            // 章节没有类型这一维
            card_type: None,
            hanzi_count: row.hanzi_count,
        })
        .collect())
}

pub fn count_deleted(conn: &Connection) -> AppResult<i64> {
    repository::count_deleted(conn)
}

/// 把一章从回收站捞回来，落在容器的末尾。
pub fn restore_from_trash(conn: &Connection, id: i64) -> AppResult<TrashItemRef> {
    in_transaction(conn, |conn| {
        let entry = repository::find_deleted_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("回收站里没有这一章（ID: {id}）")))?;

        // 书被删掉时会 CASCADE 掉它的全部章节（含回收站里的），所以一般情况下
        // 这一行根本查不到；这条校验是为了兜住「书的删除路径将来改成软删除」
        // 这类演进 —— 那时它就会真的生效。
        if !crate::modules::books::repository::exists(conn, entry.book_id)? {
            return Err(AppError::not_found("这一章所属的书籍已经被删除了，无法恢复"));
        }

        // 落点用 next_order_index 而不是原来的 order_index：原位置可能
        // 已经被别的章节占了（见仓储 restore_by_id 的注释）
        let order_index = repository::next_order_index(conn, entry.book_id, entry.volume_id)?;
        let now = now_iso();

        if !repository::restore_by_id(conn, id, order_index, &now)? {
            return Err(AppError::internal(format!("章节恢复失败（ID: {id}）")));
        }

        logger::info(
            "章节已从回收站恢复",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("bookId", serde_json::json!(entry.book_id)),
                ("volumeId", serde_json::json!(entry.volume_id)),
                ("orderIndex", serde_json::json!(order_index)),
            ]),
        );

        Ok(TrashItemRef {
            kind: "chapter".into(),
            id,
            title: entry.title,
        })
    })
}

/// 彻底删除。历史版本与卡片关联随外键 CASCADE 一并消失。
pub fn purge_from_trash(conn: &Connection, id: i64) -> AppResult<TrashItemRef> {
    in_transaction(conn, |conn| {
        let entry = repository::find_deleted_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("回收站里没有这一章（ID: {id}）")))?;

        if !repository::purge_by_id(conn, id)? {
            return Err(AppError::internal(format!("章节彻底删除失败（ID: {id}）")));
        }

        logger::info(
            "章节已彻底删除",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("bookId", serde_json::json!(entry.book_id)),
            ]),
        );

        Ok(TrashItemRef {
            kind: "chapter".into(),
            id,
            title: entry.title,
        })
    })
}

/// 清空回收站里的章节。返回真正删掉的条数。
pub fn purge_all_from_trash(conn: &Connection) -> AppResult<i64> {
    in_transaction(conn, |conn| {
        let removed = repository::purge_all(conn)?;
        if removed > 0 {
            logger::info(
                "回收站里的章节已清空",
                logger::fields(vec![("removed", serde_json::json!(removed))]),
            );
        }
        Ok(removed)
    })
}

/* ------------------------------------------------------------------ *
 * 排序与移动
 * ------------------------------------------------------------------ */

pub fn reorder(conn: &Connection, input: &ChapterReorderInput) -> AppResult<ChapterReorderResult> {
    in_transaction(conn, |conn| {
        book_service::assert_book_exists(conn, input.book_id)?;
        if let Some(volume_id) = input.volume_id {
            assert_volume_in_book(conn, volume_id, input.book_id)?;
        }

        let total = repository::count_in_container(conn, input.book_id, input.volume_id)?;

        // 与分卷重排同样的约束：必须提交完整顺序，否则未提交的条目保留旧下标，
        // 产生重复的 order_index，最终顺序取决于 SQLite 的返回顺序而变得不确定
        if input.ordered_ids.len() as i64 != total {
            return Err(AppError::validation("章节顺序提交不完整，请刷新页面后重试"));
        }

        let current: HashSet<i64> =
            repository::list_ids_in_container(conn, input.book_id, input.volume_id)?
                .into_iter()
                .collect();
        let submitted: HashSet<i64> = input.ordered_ids.iter().copied().collect();

        if current != submitted {
            return Err(AppError::validation(
                "提交的章节与当前列表不匹配，请刷新页面后重试",
            ));
        }

        let changed = repository::reorder(conn, input, &now_iso())?;
        logger::info(
            "章节顺序已更新",
            logger::fields(vec![
                ("bookId", serde_json::json!(input.book_id)),
                ("changed", serde_json::json!(changed)),
            ]),
        );
        Ok(ChapterReorderResult { count: changed })
    })
}

/// 把一章移动到另一个容器（或同容器内换位置）。
///
/// 这是拖拽落点的实现：调用方只给「目标容器 + 目标下标」，两份新顺序都由
/// 服务层基于当前数据库状态算出来，不接受客户端提交顺序 —— 否则并发拖拽时
/// 客户端手里的旧列表会覆盖掉别人的改动。
pub fn move_chapter(conn: &Connection, input: &ChapterMoveInput) -> AppResult<ChapterListItem> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {}）", input.id)))?;

        if let Some(volume_id) = input.volume_id {
            assert_volume_in_book(conn, volume_id, existing.book_id)?;
        }

        // 目标容器内除自己以外的顺序，然后把自己插到目标下标处
        let mut target_ids =
            repository::list_ids_in_container(conn, existing.book_id, input.volume_id)?;
        target_ids.retain(|id| *id != input.id);

        let target_index = input
            .target_index
            .clamp(0, target_ids.len() as i64) as usize;

        let mut next_target_ids = target_ids.clone();
        next_target_ids.insert(target_index, input.id);

        /*
         * 源容器需要「合拢被抽走留下的空位」—— 但**仅当容器真的换了**。
         *
         * 同容器内换位时不能再压缩一次源：此时 next_target_ids 已经包含
         * 全部兄弟节点并编号为 0..n-1，若再拿「去掉自己的旧列表」按 0..n-2
         * 编一遍，就会把它前面那些节点的下标覆盖回去，出现两个相同的
         * order_index。结果取决于 SQLite 的返回顺序 —— 把末位节点往前移
         * 就会排错。传空切片表示「源容器没有需要压缩的东西」。
         */
        let source_ids = if input.volume_id == existing.volume_id {
            Vec::new()
        } else {
            repository::list_ids_in_container(conn, existing.book_id, existing.volume_id)?
        };

        let now = now_iso();
        repository::apply_move(conn, input.id, input.volume_id, &source_ids, &next_target_ids, &now)?;
        book_service::touch_book(conn, existing.book_id)?;

        let updated = repository::find_list_item_by_id(conn, input.id)?
            .ok_or_else(|| AppError::internal(format!("章节移动后无法回读（ID: {}）", input.id)))?;

        logger::info(
            "章节已移动",
            logger::fields(vec![
                ("id", serde_json::json!(updated.id)),
                ("bookId", serde_json::json!(existing.book_id)),
                ("targetIndex", serde_json::json!(target_index)),
            ]),
        );
        Ok(updated)
    })
}

/* ------------------------------------------------------------------ *
 * 私有助手
 * ------------------------------------------------------------------ */

fn reindex_container(
    conn: &Connection,
    book_id: i64,
    volume_id: Option<i64>,
    now: &str,
) -> AppResult<()> {
    let ordered_ids = repository::list_ids_in_container(conn, book_id, volume_id)?;
    if ordered_ids.is_empty() {
        return Ok(());
    }
    repository::reorder(
        conn,
        &ChapterReorderInput {
            book_id,
            volume_id,
            ordered_ids,
        },
        now,
    )?;
    Ok(())
}

fn assert_volume_in_book(conn: &Connection, volume_id: i64, book_id: i64) -> AppResult<()> {
    let volume = volume_repository::find_by_id(conn, volume_id)?
        .ok_or_else(|| AppError::not_found(format!("分卷不存在（ID: {volume_id}）")))?;

    // 跨书挂载是典型的越权写入：会让 A 书的章节出现在 B 书的目录里。
    // 校验归属而不是只校验存在，是这类 bug 的唯一防线。
    if volume.book_id != book_id {
        return Err(AppError::validation("分卷不属于当前书籍，无法挂载章节"));
    }
    Ok(())
}
