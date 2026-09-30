//! 检索服务（对应 TS 侧 `search.service.ts`）。
//!
//! 四张表的结构差异已经由仓储抹平，这里只有一个循环：查来源 → 行转命中 →
//! 组装分组。所有「怎么从一行的若干字段里挑出该展示的那一段」的判断
//! 都收在 `to_hit` 一处。

use std::collections::HashSet;

use rusqlite::Connection;

use crate::core::errors::AppResult;

use super::models::{
    count_keyword_hits, slice_head_text, slice_snippet, FieldText, SearchGroup, SearchHit,
    SearchQuery, SearchResult, Snippet, SEARCH_SOURCE_ORDER, LIMIT_CONTEXT,
};
use super::repository::{self, SearchSourceRow};

/// 一次检索。
///
/// 空查询直接返回空结果、**不发任何 SQL**：全库扫描是有成本的，
/// 而「搜索框刚被聚焦、还没输入」是个非常高频的状态，
/// 让它去扫一遍全部正文纯属浪费。
///
/// 只把有命中的来源放进结果：界面上显示「书籍信息 0」既不提供信息，
/// 又会把真正有结果的来源挤到下面去。
pub fn query(conn: &Connection, query: &SearchQuery) -> AppResult<SearchResult> {
    if query.keywords.is_empty() {
        return Ok(SearchResult {
            keywords: Vec::new(),
            groups: Vec::new(),
            total: 0,
        });
    }

    let mut groups: Vec<SearchGroup> = Vec::new();
    let mut total = 0i64;

    for source in SEARCH_SOURCE_ORDER {
        let page = repository::search_source(conn, source, query)?;
        total += page.total;

        if page.rows.is_empty() {
            continue;
        }

        let hits = page
            .rows
            .iter()
            .map(|row| to_hit(source, row, &query.keywords))
            .collect();

        groups.push(SearchGroup {
            source: source.to_string(),
            hits,
            total: page.total,
            truncated: page.truncated,
        });
    }

    Ok(SearchResult {
        keywords: query.keywords.clone(),
        groups,
        total,
    })
}

/// 一行 → 一条命中。
///
/// 两件事：挑出锚定字段、算出展示用的标题与所属书。
fn to_hit(source: &str, row: &SearchSourceRow, keywords: &[String]) -> SearchHit {
    let picked = pick_field(&row.fields, keywords);
    let first_field = row.fields.first();

    let (field, snippet, highlights, offset, anchor) = match picked {
        Some(picked) => (
            picked.field,
            picked.snippet.text,
            picked.snippet.highlights,
            picked.snippet.offset,
            picked.snippet.anchor,
        ),
        /*
         * 兜底：SQL 说这行命中了，但没有任何一个字段能在应用层切出片段。
         * 这种情况只可能来自「SQL 匹配的原文」与「展示用文本」不一致 ——
         * 目前唯一的来源是标签列（SQL 查的是 JSON 原文 `["主角团"]`，
         * 展示的是折过的「主角团」）。真发生了也不能把这条丢掉：
         * 丢掉会让界面上的「共 N 条」比实际列出来的多，
         * 而人只会怀疑整个检索坏了。
         */
        None => (
            first_field
                .map(|item| item.field.clone())
                .unwrap_or_else(|| "title".to_string()),
            slice_head_text(
                first_field.map(|item| item.text.as_str()).unwrap_or_default(),
                LIMIT_CONTEXT * 2,
            ),
            Vec::new(),
            0,
            keywords.first().cloned().unwrap_or_default(),
        ),
    };

    SearchHit {
        source: source.to_string(),
        id: row.id,
        book_id: row.book_id,
        book_title: row.book_title.clone(),
        // 书籍这一来源的标题就是它自己，row.title 已经是正确值
        title: row.title.clone(),
        field,
        snippet,
        highlights,
        offset,
        anchor,
        matched_keywords: count_matched_keywords(&row.fields, keywords),
        updated_at: row.updated_at.clone(),
    }
}

/// 跨全部字段命中的关键词种类数 —— 比只看锚定字段更诚实。
fn count_matched_keywords(fields: &[FieldText], keywords: &[String]) -> usize {
    let mut kinds: HashSet<String> = HashSet::new();
    for item in fields {
        for keyword in keywords {
            let key = keyword.to_lowercase();
            if kinds.contains(&key) {
                continue;
            }
            if count_keyword_hits(&item.text, std::slice::from_ref(keyword)) > 0 {
                kinds.insert(key);
            }
        }
    }
    kinds.len()
}

struct PickedField {
    field: String,
    snippet: Snippet,
}

/// 选锚定字段：命中关键词**种类**最多的那个，并列时取 fields 里靠前的。
///
/// fields 的顺序由仓储给出（正文优先于标题），因此「并列取靠前」这条就把
/// 优先级编码进了数据本身，不需要在这里再写一遍 if 判断。
fn pick_field(fields: &[FieldText], keywords: &[String]) -> Option<PickedField> {
    let mut best: Option<PickedField> = None;
    let mut best_score = 0usize;

    for item in fields {
        let Some(snippet) = slice_snippet(&item.text, keywords, LIMIT_CONTEXT) else {
            continue;
        };

        let score = count_keyword_hits(&item.text, keywords);
        if score > best_score {
            best_score = score;
            best = Some(PickedField {
                field: item.field.clone(),
                snippet,
            });
        }
    }

    best
}
