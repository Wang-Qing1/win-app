import {
  SEARCH_LIMITS,
  countKeywordHits,
  sliceSnippet,
  type SearchField,
  type SearchGroup,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SearchSource,
  type Snippet
} from '@shared/modules/search'
import {
  SEARCH_SOURCE_ORDER,
  type SearchRepository,
  type SearchSourceRow
} from './search.repository'

/**
 * 检索服务。
 *
 * 四张表的结构差异已经由仓储抹平，这里只有一个循环：查来源 → 行转命中 →
 * 组装分组。所有「怎么从一行的若干字段里挑出该展示的那一段」的判断
 * 都收在 `toHit` 一处。
 */
export class SearchService {
  constructor(private readonly repository: SearchRepository) {}

  /**
   * 一次检索。
   *
   * 空查询直接返回空结果、**不发任何 SQL**：全库扫描是有成本的，
   * 而「搜索框刚被聚焦、还没输入」是个非常高频的状态，
   * 让它去扫一遍全部正文纯属浪费。
   *
   * 只把有命中的来源放进结果：界面上显示「书籍信息 0」既不提供信息，
   * 又会把真正有结果的来源挤到下面去。
   */
  query(query: SearchQuery): SearchResult {
    if (query.keywords.length === 0) {
      return { keywords: [], groups: [], total: 0 }
    }

    const groups: SearchGroup[] = []
    let total = 0

    for (const source of SEARCH_SOURCE_ORDER) {
      const page = this.repository.searchSource(source, query)
      total += page.total

      if (page.rows.length === 0) continue

      groups.push({
        source,
        hits: page.rows.map((row) => this.toHit(source, row, query.keywords)),
        total: page.total,
        truncated: page.truncated
      })
    }

    return { keywords: query.keywords, groups, total }
  }

  /**
   * 一行 → 一条命中。
   *
   * 两件事：挑出锚定字段、算出展示用的标题与所属书。
   */
  private toHit(source: SearchSource, row: SearchSourceRow, keywords: readonly string[]): SearchHit {
    const picked = pickField(row.fields, keywords)

    /*
     * 兜底：SQL 说这行命中了，但没有任何一个字段能在应用层切出片段。
     * 这种情况只可能来自「SQL 匹配的原文」与「展示用文本」不一致 ——
     * 目前唯一的来源是标签列（SQL 查的是 JSON 原文 `["主角团"]`，
     * 展示的是折过的「主角团」）。真发生了也不能把这条丢掉：
     * 丢掉会让界面上的「共 N 条」比实际列出来的多，而人只会怀疑整个检索坏了。
     */
    const snippet: Snippet = picked?.snippet ?? {
      text: row.fields[0]?.text.slice(0, SEARCH_LIMITS.context * 2).replace(/\n/g, ' ') ?? '',
      highlights: [],
      offset: 0,
      anchor: keywords[0] ?? '',
      clippedStart: false,
      clippedEnd: (row.fields[0]?.text.length ?? 0) > SEARCH_LIMITS.context * 2
    }

    return {
      source,
      id: row.id,
      bookId: row.bookId,
      bookTitle: row.bookTitle,
      // 书籍这一来源的标题就是它自己，row.title 已经是正确值
      title: row.title,
      field: picked?.field ?? row.fields[0]?.field ?? 'title',
      snippet: snippet.text,
      highlights: snippet.highlights,
      offset: snippet.offset,
      anchor: snippet.anchor,
      matchedKeywords: countMatchedKeywords(row.fields, keywords),
      updatedAt: row.updatedAt
    }
  }
}

/** 跨全部字段命中的关键词种类数 —— 比只看锚定字段更诚实 */
function countMatchedKeywords(
  fields: readonly { field: SearchField; text: string }[],
  keywords: readonly string[]
): number {
  const kinds = new Set<string>()
  for (const item of fields) {
    for (const keyword of keywords) {
      if (kinds.has(keyword.toLowerCase())) continue
      if (countKeywordHits(item.text, [keyword]) > 0) kinds.add(keyword.toLowerCase())
    }
  }
  return kinds.size
}

interface PickedField {
  field: SearchField
  snippet: Snippet
}

/**
 * 选锚定字段：命中关键词**种类**最多的那个，并列时取 fields 里靠前的。
 *
 * fields 的顺序由仓储给出（正文优先于标题），因此「并列取靠前」这条
 * 就把优先级编码进了数据本身，不需要在这里再写一遍 if 判断。
 */
function pickField(
  fields: readonly { field: SearchField; text: string }[],
  keywords: readonly string[]
): PickedField | null {
  let best: PickedField | null = null
  let bestScore = 0

  for (const item of fields) {
    const snippet = sliceSnippet(item.text, keywords)
    if (!snippet) continue

    const score = countKeywordHits(item.text, keywords)
    if (score > bestScore) {
      bestScore = score
      best = { field: item.field, snippet }
    }
  }

  return best
}
