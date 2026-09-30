//! 卡片服务（对应 TS 侧 `card.service.ts`）：承载业务规则与事务边界。
//!
//! 统一的表结构带来一个必须由服务层兜住的隐患：**卡片的 extra 是自由 JSON，
//! 数据库不会替我们拒绝任何键**。所以每次写入都要经过 `normalize_extra`，
//! 把 extra 投影到「目标类型声明的字段集」上 —— 见 `prepare_write` 的说明。
//!
//! 与其它模块一样，这里只吃 `&Connection`：同一个函数既能在命令层被调用，
//! 也能被回收站与关联模块复用，规则永远只有一份实现。

use std::collections::HashSet;

use rusqlite::Connection;

use crate::core::errors::{AppError, AppResult};
use crate::core::logger;
use crate::core::time::now_iso;
use crate::db::in_transaction;
use crate::modules::books::service as book_service;
use crate::modules::trash::models::{TrashEntry, TrashItemRef};

use super::models::{
    card_type_label, is_card_type, normalize_tags, renormalize_extra, Card, CardCreateInput,
    CardListQuery, CardListResult, CardRemovalResult, CardTimelineOrderInput, CardUpdateInput,
    CardWriteData, LIMIT_TITLE,
};
use super::repository;

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/// 卡片列表。
///
/// 几个数字来自几条 SQL（本页数据 + 总数 + 各维度计数），它们共用同一份
/// WHERE 条件（见仓储的 build_filter），因此不会出现「共 3 张、却列出 4 行」
/// 这种自相矛盾 —— 那比数字算错更难排查，因为看起来像是界面出了问题。
pub fn list(conn: &Connection, query: &CardListQuery) -> AppResult<CardListResult> {
    let paged = repository::list_paged(conn, query)?;

    Ok(CardListResult {
        items: paged.items,
        total: paged.total,
        page: paged.page,
        page_size: paged.page_size,
        page_count: paged.page_count,
        type_counts: repository::count_by_type(conn, query)?,
        setting_counts: repository::count_by_setting_category(conn, query)?,
        global_count: repository::count_global(conn, query)?,
    })
}

/// 取一张活卡片，不存在即 NOT_FOUND。
///
/// 供关联模块（卡片 ↔ 章节 / 大纲节点 / 卡片）复用：那边需要的正是
/// 「卡片存在、并且拿到它的 bookId 与 title 做同书校验」。
pub fn require_card(conn: &Connection, id: i64) -> AppResult<Card> {
    repository::find_by_id(conn, id)?
        .ok_or_else(|| AppError::not_found(format!("卡片不存在（ID: {id}）")))
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

pub fn create(conn: &Connection, input: &CardCreateInput) -> AppResult<Card> {
    let data = &input.data;

    in_transaction(conn, |conn| {
        assert_book_exists(conn, data.book_id)?;
        assert_title_free(conn, data.book_id, &data.card_type, &data.title, -1)?;

        let id = repository::insert(conn, &prepare_write(data), &now_iso())?;

        let created = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::internal(format!("新增卡片后无法回读记录（ID: {id}）")))?;

        logger::info(
            "卡片已创建",
            logger::fields(vec![
                ("id", serde_json::json!(created.id)),
                ("cardType", serde_json::json!(created.card_type)),
                ("bookId", serde_json::json!(created.book_id)),
            ]),
        );
        Ok(created)
    })
}

/// 更新卡片。
///
/// 允许改类型（比如「本来想记成灵感，写下来发现是个设定」），
/// 此时 extra 会被投影到新类型的字段集上：旧类型的键全部丢弃、
/// 新类型的键补齐为空串。不这么做的话，一张物品卡里会永远留着一份
/// 谁也不会显示的「身份定位」，直到某天导出时才暴露出来。
pub fn update(conn: &Connection, input: &CardUpdateInput) -> AppResult<Card> {
    let id = input.id;
    let data = &input.data;

    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("卡片不存在（ID: {id}）")))?;

        assert_book_exists(conn, data.book_id)?;
        assert_title_free(conn, data.book_id, &data.card_type, &data.title, id)?;

        if !repository::update(conn, id, &prepare_write(data), &now_iso())? {
            return Err(AppError::internal(format!("卡片更新失败（ID: {id}）")));
        }

        let updated = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::internal(format!("卡片更新后无法回读（ID: {id}）")))?;

        logger::info(
            "卡片已更新",
            logger::fields(vec![
                ("id", serde_json::json!(updated.id)),
                ("cardType", serde_json::json!(updated.card_type)),
                (
                    "typeChanged",
                    serde_json::json!(existing.card_type != updated.card_type),
                ),
            ]),
        );
        Ok(updated)
    })
}

/// 删除卡片 —— 是**软删除**，进回收站。
///
/// 只打一个 deleted_at 时间戳，行还在库里，关联（章节 / 大纲节点 /
/// 人物关系）也全都原样留着 —— 于是恢复的那一刻，这张卡在界面上的
/// 所有牵连都自动回来，不需要任何反向补偿逻辑。
///
/// 前端那句提示语必须与这里一致：**「已移到回收站」而不是「已删除」**。
/// 文案说「删除」而数据只是被标记时，用户不会想到去回收站找。
pub fn remove(conn: &Connection, id: i64) -> AppResult<CardRemovalResult> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("卡片不存在（ID: {id}）")))?;

        if !repository::soft_delete(conn, id, &now_iso())? {
            return Err(AppError::internal(format!("卡片删除失败（ID: {id}）")));
        }

        logger::info(
            "卡片已移入回收站",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("cardType", serde_json::json!(existing.card_type)),
            ]),
        );
        Ok(CardRemovalResult {
            id,
            title: existing.title,
        })
    })
}

/// 复制一张卡片。
///
/// 人物卡常需要「同一个模板改几笔」——比如同一阵营的三个配角，
/// 身份与阵营字段完全一样，只有关系不同。逐字段重填的代价远高于复制一份。
///
/// 标题自动加「副本」后缀并**避开重名**：直接复用原标题会被上面的
/// 唯一性规则拒掉，那样复制功能在第一步就不可用。
pub fn duplicate(conn: &Connection, id: i64) -> AppResult<Card> {
    in_transaction(conn, |conn| {
        let source = repository::find_by_id(conn, id)?
            .ok_or_else(|| AppError::not_found(format!("卡片不存在（ID: {id}）")))?;

        assert_book_exists(conn, source.book_id)?;

        let title = next_copy_title(conn, source.book_id, &source.card_type, &source.title)?;
        let data = CardWriteData {
            book_id: source.book_id,
            card_type: source.card_type.clone(),
            title: title.clone(),
            subtitle: source.subtitle.clone(),
            content: source.content.clone(),
            tags: source.tags.clone(),
            // source.extra 已经过 normalize_extra（读取路径上做过），
            // 这里再走一次是为了不依赖「读路径一定清洗过」这个假设
            extra: renormalize_extra(&source.card_type, &source.extra),
        };

        let new_id = repository::insert(conn, &data, &now_iso())?;
        let created = repository::find_by_id(conn, new_id)?
            .ok_or_else(|| AppError::internal(format!("复制卡片后无法回读记录（ID: {new_id}）")))?;

        logger::info(
            "卡片已复制",
            logger::fields(vec![
                ("sourceId", serde_json::json!(id)),
                ("id", serde_json::json!(new_id)),
                ("title", serde_json::json!(title)),
            ]),
        );
        Ok(created)
    })
}

/// 设定卡时间线重排。
///
/// 三条硬规则，缺一条都会让时间线变成一个说谎的视图：
///   1. **只能是设定卡。** 人物 / 物品卡没有时点，混进来会变成一排空白；
///   2. **必须同一本书。** 跨书的时间线在故事上不存在；
///   3. **同一组里类别必须一致**（给了 category 时）。「地点」与「时间线」
///      混排看着像「这些事按先后发生」，其实一半是静态设定。
///
/// 返回重排后的完整卡片：调用方直接拿它替换本地列表，不必再查一次。
pub fn set_timeline_order(
    conn: &Connection,
    input: &CardTimelineOrderInput,
) -> AppResult<Vec<Card>> {
    in_transaction(conn, |conn| {
        assert_book_exists(conn, input.book_id)?;

        // 重复 id 会让「第 N 位」这个语义自相矛盾：同一张卡既在第 2 位
        // 又在第 5 位，写进去的序号取决于循环顺序，界面上则表现为
        // 「有一行消失了」—— 那个坑排查起来非常费劲
        let mut seen: HashSet<i64> = HashSet::with_capacity(input.ordered_ids.len());
        for id in &input.ordered_ids {
            if !seen.insert(*id) {
                return Err(AppError::validation("排序里出现了同一张卡片，请刷新后重试"));
            }
        }

        let mut cards: Vec<Card> = Vec::with_capacity(input.ordered_ids.len());
        for id in &input.ordered_ids {
            let card = repository::find_by_id(conn, *id)?
                .ok_or_else(|| AppError::not_found(format!("卡片不存在（ID: {id}）")))?;

            if card.card_type != "setting" {
                return Err(AppError::validation(format!(
                    "「{}」不是设定卡，排不进时间线",
                    card.title
                )));
            }
            // 用 IS 语义比较而不是 ==：两边都可能是 None（通用设定卡），
            // 而 Option 的比较正好就是 NULL 安全的
            if card.book_id != input.book_id {
                return Err(AppError::validation(format!(
                    "「{}」不属于这本书，不能跟这本书的设定排在同一条时间线上",
                    card.title
                )));
            }
            if let Some(category) = &input.category {
                let current = card.extra.get("category").cloned().unwrap_or_default();
                if current != *category {
                    let shown = if current.is_empty() {
                        "（未分类）".to_string()
                    } else {
                        current
                    };
                    return Err(AppError::validation(format!(
                        "「{}」的类别是{shown}，排不进「{category}」这一组",
                        card.title
                    )));
                }
            }

            cards.push(card);
        }

        let entries: Vec<(i64, i64)> = cards
            .iter()
            .enumerate()
            .map(|(index, card)| (card.id, index as i64))
            .collect();
        repository::set_timeline_order(conn, &entries)?;

        let mut result = Vec::with_capacity(cards.len());
        for card in &cards {
            let saved = repository::find_by_id(conn, card.id)?.ok_or_else(|| {
                AppError::internal(format!("时间线重排后无法回读卡片（ID: {}）", card.id))
            })?;
            result.push(saved);
        }
        Ok(result)
    })
}

/* ------------------------------------------------------------------ *
 * 回收站
 *
 * 这一节里的几个函数只被 TrashService 调用 —— 卡片模块自己不展示回收站，
 * 它只负责回答「哪些卡片在回收站里」「把某一张捞回来」「把某一张彻底抹掉」。
 * 把这些放在这里而不是让回收站直接拿卡片仓储：卡片的读取口径（认不出的
 * 类型退回灵感、bookId 为 None 是通用卡片）只在这一层发生过，绕开它就会在
 * 回收站里长出一套稍有不同的口径 —— 那是同一张卡在两处显示不同的开端。
 * ------------------------------------------------------------------ */

/// 回收站里的卡片，最近删除的在前。
pub fn list_deleted(conn: &Connection, limit: i64) -> AppResult<Vec<TrashEntry>> {
    Ok(repository::list_deleted(conn, limit)?
        .into_iter()
        .map(|row| TrashEntry {
            id: row.id,
            title: row.title,
            // 卡片拿「一句话简介」放在副标题位置：它比类型名更能帮人认出是哪张
            subtitle: row.subtitle,
            book_id: row.book_id,
            book_title: row.book_title,
            deleted_at: row.deleted_at,
            // 认不出的类型退回「灵感」，与 read_card 同一口径 —— 免得同一张卡
            // 在卡片库与回收站里显示成不同的类型
            card_type: Some(if is_card_type(&row.card_type) {
                row.card_type
            } else {
                "inspiration".to_string()
            }),
            // 卡片不算汉字数：正文上限 5000 字符，「多少字」不是它的识别特征
            hanzi_count: 0,
        })
        .collect())
}

pub fn count_deleted(conn: &Connection) -> AppResult<i64> {
    repository::count_deleted(conn)
}

/// 把一张卡从回收站捞回来。
///
/// **不校验重名**：回收站里那张卡的标题，是它进回收站之前确实用过的名字。
/// 在它还躺在回收站期间，作者完全可能新建了一张同名的卡 —— 此时「恢复」
/// 若以重名为由拒绝，用户就陷入了一个死结：不删掉新建的那张，就永远救不回
/// 旧的那张，而两张卡的内容未必相同。允许重名是这里唯一说得通的选择：
/// 数据库层面本来也没有唯一约束，重名只是业务规则，而这条规则应当让位于
/// 「把用户的东西还给他」。
pub fn restore_from_trash(conn: &Connection, id: i64) -> AppResult<TrashItemRef> {
    in_transaction(conn, |conn| {
        let entry = repository::find_deleted_by_id(conn, id)?.ok_or_else(|| {
            AppError::not_found(format!("回收站里没有这张卡片（ID: {id}）"))
        })?;

        if !repository::restore_by_id(conn, id, &now_iso())? {
            return Err(AppError::internal(format!("卡片恢复失败（ID: {id}）")));
        }

        logger::info(
            "卡片已从回收站恢复",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("cardType", serde_json::json!(entry.card_type)),
            ]),
        );
        Ok(TrashItemRef {
            kind: "card".to_string(),
            id,
            title: entry.title,
        })
    })
}

/// 彻底删除。关联（章节 / 大纲节点 / 卡片关系）随外键 CASCADE 一并消失。
pub fn purge_from_trash(conn: &Connection, id: i64) -> AppResult<TrashItemRef> {
    in_transaction(conn, |conn| {
        let entry = repository::find_deleted_by_id(conn, id)?.ok_or_else(|| {
            AppError::not_found(format!("回收站里没有这张卡片（ID: {id}）"))
        })?;

        if !repository::purge_by_id(conn, id)? {
            return Err(AppError::internal(format!("卡片彻底删除失败（ID: {id}）")));
        }

        logger::info(
            "卡片已彻底删除",
            logger::fields(vec![
                ("id", serde_json::json!(id)),
                ("cardType", serde_json::json!(entry.card_type)),
            ]),
        );
        Ok(TrashItemRef {
            kind: "card".to_string(),
            id,
            title: entry.title,
        })
    })
}

/// 清空回收站里的卡片。返回真正删掉的条数。
pub fn purge_all_from_trash(conn: &Connection) -> AppResult<i64> {
    in_transaction(conn, |conn| {
        let removed = repository::purge_all(conn)?;
        if removed > 0 {
            logger::info(
                "回收站里的卡片已清空",
                logger::fields(vec![("removed", serde_json::json!(removed))]),
            );
        }
        Ok(removed)
    })
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/// 由入参准备出待写入的一行。
///
/// 两个规范化都收在这里：
///   - tags：去空白、丢空串、去重（前端解析标签用同一份规则，见契约层）
///   - extra：**按目标类型投影**，这是统一建模下最关键的一步。
///     入参里可能带着不属于当前类型的键（改类型时前端表单还没来得及清理），
///     不经投影就会被原样写进库。
fn prepare_write(data: &CardWriteData) -> CardWriteData {
    CardWriteData {
        book_id: data.book_id,
        card_type: data.card_type.clone(),
        title: data.title.clone(),
        subtitle: data.subtitle.clone(),
        content: data.content.clone(),
        tags: normalize_tags(&data.tags),
        extra: renormalize_extra(&data.card_type, &data.extra),
    }
}

fn assert_book_exists(conn: &Connection, book_id: Option<i64>) -> AppResult<()> {
    // None 是合法的「通用卡片」，不校验
    match book_id {
        Some(id) => book_service::assert_book_exists(conn, id),
        None => Ok(()),
    }
}

fn assert_title_free(
    conn: &Connection,
    book_id: Option<i64>,
    card_type: &str,
    title: &str,
    exclude_id: i64,
) -> AppResult<()> {
    let Some(occupied) = repository::find_by_title(conn, book_id, card_type, title, exclude_id)?
    else {
        return Ok(());
    };

    let where_label = if book_id.is_none() {
        "通用卡片"
    } else {
        "这本书"
    };
    Err(AppError::conflict(format!(
        "{where_label}里已经有一张叫「{}」的{}卡了，换个名字，或者先改那一张",
        occupied.title,
        card_type_label(card_type)
    )))
}

/// 生成不撞名的副本标题。
///
/// 截断是必需的：卡片标题上限 80 字符，若原标题已经顶到上限，加后缀就会超限。
/// 副本本身能存下去（服务层不重复校验长度），但**下一次从界面保存这张副本时
/// 会被边界校验拒掉** —— 用户会看到一张「点保存就报错」的卡片，
/// 而错因和标题长度毫无关系。
fn next_copy_title(
    conn: &Connection,
    book_id: Option<i64>,
    card_type: &str,
    source_title: &str,
) -> AppResult<String> {
    let taken: HashSet<String> = repository::list_titles(conn, book_id, card_type)?
        .into_iter()
        .map(|title| title.to_lowercase())
        .collect();

    for ordinal in 1..=100i64 {
        let suffix = if ordinal == 1 {
            " 副本".to_string()
        } else {
            format!(" 副本 {ordinal}")
        };
        // 按**字符**截断而不是字节：一条中文占 3 字节，按字节截会把标题砍掉三分之二
        let keep = std::cmp::max(1, LIMIT_TITLE.saturating_sub(suffix.chars().count()));
        let head: String = source_title.chars().take(keep).collect();
        let candidate = format!("{}{}", head.trim(), suffix);

        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
    }

    Err(AppError::conflict("这张卡的副本太多了，先整理一下再复制吧"))
}
