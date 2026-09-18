import { z } from 'zod'

/**
 * 全库检索的共享契约。
 *
 * 这个模块里有两段**纯计算**：`parseKeywords`（切词）与 `sliceSnippet`
 * （切片 + 标高亮）。它们刻意放在共享层而不是主进程：
 *   1. 渲染进程要用切词结果即时显示「正在搜索：林澈 + 星云」这样的词条，
 *      两侧各写一份必然出现「界面显示 3 个词、后端只搜了 2 个」这种对不上的情况；
 *   2. 主进程的冒烟测试可以直接对它们做单元断言，不需要起数据库。
 *
 * 检索最终走的是 LIKE 全表扫描，不是 FTS5。这个选择有实测依据：
 * 1024 万字（2000 章）的全库扫描约 52 毫秒，单本书内 5 毫秒，都在感知阈值以下；
 * 而 FTS5 在中文上有两个真实缺陷 —— `trigram` 分词器要求查询至少 3 个字符，
 * 中文人名大多只有 2 字（「林澈」「星云」），搜出来是**静默的空列表**；
 * 自己按字拆再拼 phrase 则会让标点被分词器丢弃，于是「门，外」被当成相邻字符。
 * 用零索引、零维护、零误匹配换用户感知不到的 50 毫秒，这笔交易是亏的。
 */

/* ------------------------------------------------------------------ *
 * 来源
 * ------------------------------------------------------------------ */

export const SEARCH_SOURCES = ['chapter', 'card', 'outline', 'book'] as const
export type SearchSource = (typeof SEARCH_SOURCES)[number]

export const SEARCH_SOURCE_LABELS: Record<SearchSource, string> = {
  chapter: '章节正文',
  card: '卡片库',
  outline: '大纲',
  book: '书籍信息'
}

export function isSearchSource(value: unknown): value is SearchSource {
  return typeof value === 'string' && (SEARCH_SOURCES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 字段
 * ------------------------------------------------------------------ */

export const SEARCH_FIELDS = [
  'title',
  'subtitle',
  'content',
  'summary',
  'tags',
  'penName',
  'genre'
] as const
export type SearchField = (typeof SEARCH_FIELDS)[number]

export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: '标题',
  subtitle: '一句话简介',
  content: '正文',
  summary: '摘要',
  tags: '标签',
  penName: '笔名',
  genre: '题材'
}

/* ------------------------------------------------------------------ *
 * 上限
 * ------------------------------------------------------------------ */

export const SEARCH_LIMITS = {
  /** 原始查询串的长度上限 */
  raw: 120,
  /** 单个关键词的长度上限 */
  keyword: 60,
  /** 最多接受几个关键词。再多的话 AND 语义会让结果常年为空，不如明确收住 */
  keywords: 6,
  /** 片段上下文：锚点命中两侧各取多少字符 */
  context: 36,
  /** 客户端可请求的每来源条数上限 */
  maxPerSource: 50,
  /** 浮层里每来源默认展示多少条 */
  perSource: 10
} as const

/* ------------------------------------------------------------------ *
 * 切词
 * ------------------------------------------------------------------ */

/**
 * 把用户输入的查询串切成关键词数组。
 *
 * 规则就是「空格分词，全部都要命中」（AND），没有引号、没有排除号 ——
 * 一个小说写作工具不需要把自己的检索语法变成一门小语言。用户真想要
 * 精确的连续匹配，多打两个字就行了（LIKE 本来就是子串匹配）。
 *
 * 几处细节：
 *   - `\s` 在 JS 里包含全角空格 `\u3000`，中文输入法下打出的空格能被正确切开，
 *     这一点很关键 —— 否则「林澈　星云」会变成一个永远搜不到的词。
 *   - 按**码点**截断（`[...word]`）而不是 `slice`：后者会把代理对切成两半，
 *     留下一个孤立的半字符，既搜不到也会在界面上显示成方块。
 *   - 去重按小写比较，但保留原大小写用于显示与高亮。
 */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const piece of raw.split(/\s+/)) {
    if (piece.length === 0) continue

    const word = Array.from(piece)
      .slice(0, SEARCH_LIMITS.keyword)
      .join('')
    if (word.length === 0) continue

    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    result.push(word)
    if (result.length >= SEARCH_LIMITS.keywords) break
  }

  return result
}

/* ------------------------------------------------------------------ *
 * 片段
 * ------------------------------------------------------------------ */

export interface SnippetHighlight {
  /** 相对片段起点的起始下标 */
  start: number
  /** 相对片段起点的结束下标（半开区间） */
  end: number
}

export interface Snippet {
  /** 片段正文。换行已折成空格，且是 1:1 替换，因此高亮下标不受影响 */
  text: string
  highlights: SnippetHighlight[]
  /**
   * **锚点命中**在源文本里的起始下标。
   *
   * 注意它是锚点命中的位置，不是片段起点。两者差着 context 个字符，
   * 而调用方拿它去编辑器里找「最近的一次命中」——
   * 若返回片段起点，编辑器会常常选中锚点**之前**的那一次命中。
   */
  offset: number
  /** 锚定到哪个关键词。编辑器用它在自己文档里重新定位 */
  anchor: string
  /** 片段前面还有内容（界面据此补一个省略号） */
  clippedStart: boolean
  /** 片段后面还有内容 */
  clippedEnd: boolean
}

interface RawMatch {
  start: number
  end: number
  keyword: string
}

/**
 * 在文本里找出所有关键词的全部出现位置。
 *
 * 用 `indexOf` 逐段推进而不是正则：关键词是用户随手输入的，里面可能带
 * `(`、`*`、`?`、`\` 这些元字符。转义一遍当然也行，但那是在「用正则做
 * 字符串查找」—— 直接把正则去掉，从根上避免这类 bug。
 * （编辑器里的查找替换也是同样的取舍，两边行为因此天然一致。）
 *
 * 大小写：与 SQL 的 LIKE 对齐 —— LIKE 对 ASCII 忽略大小写，这里也用小写
 * 副本比对。但 `toLowerCase()` 对个别字符会改变长度（`İ` → 两个码元），
 * 一旦长度变了，所有下标就整体错位。因此长度不一致时直接退回区分大小写，
 * 宁可少匹配也不标错位置。
 */
function collectMatches(haystack: string, keywords: readonly string[]): RawMatch[] {
  const lowered = haystack.toLowerCase()
  const caseInsensitive = lowered.length === haystack.length
  const source = caseInsensitive ? lowered : haystack

  const matches: RawMatch[] = []
  for (const keyword of keywords) {
    const needle = caseInsensitive ? keyword.toLowerCase() : keyword
    if (needle.length === 0) continue

    let index = source.indexOf(needle)
    while (index !== -1) {
      matches.push({ start: index, end: index + needle.length, keyword })
      // 步进 needle.length 而不是 1：重叠匹配（「哈哈哈」里找「哈哈」）
      // 只取第一次，与主流编辑器一致，也让片段里不会出现互相压住的下划线
      index = source.indexOf(needle, index + needle.length)
    }
  }

  matches.sort((a, b) => a.start - b.start || a.end - b.end)
  return matches
}

interface Window {
  start: number
  end: number
}

function windowAround(length: number, match: RawMatch, context: number): Window {
  return {
    start: Math.max(0, match.start - context),
    end: Math.min(length, match.end + context)
  }
}

/** 窗口内覆盖了几种关键词（按小写归并，避免把同一个词的多次出现算成多种） */
function distinctKeywordsIn(matches: readonly RawMatch[], window: Window): number {
  const kinds = new Set<string>()
  for (const match of matches) {
    if (match.start >= window.start && match.end <= window.end) kinds.add(match.keyword.toLowerCase())
  }
  return kinds.size
}

/**
 * 这段文本命中了几个**种类**的关键词（同一个词出现多次只算一个）。
 *
 * 用来决定一条结果锚定在哪个字段上：标题和正文都命中时，取命中词更多的
 * 那一边做片段。出现次数不参与比较 —— 「正文里『林澈』出现 5 次、
 * 标题里『林澈』和『星云』都出现」这种情况下，用户想看的是标题那一处。
 */
export function countKeywordHits(text: string, keywords: readonly string[]): number {
  if (text.length === 0 || keywords.length === 0) return 0
  const kinds = new Set<string>()
  for (const match of collectMatches(text, keywords)) kinds.add(match.keyword.toLowerCase())
  return kinds.size
}

/**
 * 切出命中片段，并给出片段内的关键词高亮区间。
 *
 * 锚点选择的规则值得说明：**不是简单取第一次命中**，而是在所有命中里挑一个
 * 「以它为中心开窗，窗口内覆盖的关键词种类最多」的；并列时取最早的那个。
 *
 * 为什么值得多写这个循环：既然是 AND 检索，用户真正想知道的是「这几个词
 * 在哪儿同时出现了」。固定锚定第一次命中时，片段里往往只有第一个词 ——
 * 用户看到高亮的「林澈」，却看不到自己要找的「星云」就在后面 40 个字处，
 * 会以为这软件没看懂他的查询。
 */
export function sliceSnippet(
  text: string,
  keywords: readonly string[],
  context: number = SEARCH_LIMITS.context
): Snippet | null {
  if (text.length === 0 || keywords.length === 0) return null

  const matches = collectMatches(text, keywords)
  if (matches.length === 0) return null

  let anchor = matches[0]
  let bestScore = -1
  for (const candidate of matches) {
    const score = distinctKeywordsIn(matches, windowAround(text.length, candidate, context))
    if (score > bestScore) {
      bestScore = score
      anchor = candidate
    }
  }

  const window = windowAround(text.length, anchor, context)

  /*
   * 换行折成空格：content_text 里段落之间是 `\n\n`，直接展示会出现空行。
   * 用 1:1 的单字符替换而不是「压成空白」，是为了让下标保持有效 ——
   * 长度一变，下面算好的高亮区间就全部偏了。
   * 界面上不会看到两个连续空格，浏览器渲染时会把空白折叠掉。
   */
  const body = text.slice(window.start, window.end).replace(/\n/g, ' ')

  const highlights: SnippetHighlight[] = []
  for (const match of matches) {
    // 只收**完整落在窗口内**的命中：被窗口边界切掉一半的关键词
    // 若也标上，界面上会出现一个只覆盖半个词的高亮，比不标更让人困惑
    if (match.start < window.start || match.end > window.end) continue
    highlights.push({ start: match.start - window.start, end: match.end - window.start })
  }

  return {
    text: body,
    highlights,
    offset: anchor.start,
    anchor: anchor.keyword,
    clippedStart: window.start > 0,
    clippedEnd: window.end < text.length
  }
}

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

export const searchQuerySchema = z.object({
  /** 原始查询串。切词放在共享层做，客户端不必先切好再传 */
  keywords: z
    .string()
    .trim()
    .max(SEARCH_LIMITS.raw, `检索词最多 ${SEARCH_LIMITS.raw} 个字符`)
    .default(''),

  /** 限定在某本书内检索；null 表示全库 */
  bookId: z.number().int().positive('书籍 ID 非法').nullable().default(null),

  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMITS.maxPerSource, `每个来源最多返回 ${SEARCH_LIMITS.maxPerSource} 条`)
    .default(SEARCH_LIMITS.perSource)
})

export type SearchQueryInput = z.input<typeof searchQuerySchema>

export interface SearchQuery {
  keywords: string[]
  raw: string
  bookId: number | null
  limit: number
}

export function normalizeSearchQuery(input: {
  keywords: string
  bookId: number | null
  limit: number
}): SearchQuery {
  return {
    keywords: parseKeywords(input.keywords),
    raw: input.keywords.trim(),
    bookId: input.bookId,
    limit: input.limit
  }
}

export const DEFAULT_SEARCH_QUERY: SearchQueryInput = {
  keywords: '',
  bookId: null,
  limit: SEARCH_LIMITS.perSource
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

export interface SearchHit {
  source: SearchSource
  /** 目标条目在它自己表里的 id */
  id: number
  /** 所属书籍；卡片可以是通用卡片（null），书籍信息就是它自己 */
  bookId: number | null
  /**
   * 所属书籍的书名。
   *
   * 与 bookId 一样必须可空 —— **通用卡片**（`cards.book_id IS NULL`）
   * 不属于任何一本书，界面上显示「通用卡片」而不是一个空字符串。
   */
  bookTitle: string | null
  /** 目标条目的显示标题 */
  title: string
  /** 片段锚定在哪个字段上 —— 界面显示「命中：正文」 */
  field: SearchField
  snippet: string
  highlights: SnippetHighlight[]
  /** 锚点命中的起始偏移，供编辑器定位 */
  offset: number
  /** 锚点关键词，供编辑器在自己文档里重新定位 */
  anchor: string
  /** 该条目命中了几个关键词。AND 语义下等于查询词数，但标题单独命中时会偏小 */
  matchedKeywords: number
  updatedAt: string
}

export interface SearchGroup {
  source: SearchSource
  hits: SearchHit[]
  /** 该来源命中的**总条数**，可能大于 hits.length */
  total: number
  /** 是否因为每来源上限而截断 */
  truncated: boolean
}

export interface SearchResult {
  /** 回显切词结果，让界面能显示实际生效的词条（与后端完全一致） */
  keywords: string[]
  groups: SearchGroup[]
  /** 四类来源命中数之和 */
  total: number
}

export const EMPTY_SEARCH_RESULT: SearchResult = { keywords: [], groups: [], total: 0 }

/** 结果里第一条命中，用于「回车直接打开最相关的一条」 */
export function firstHit(result: SearchResult): SearchHit | null {
  for (const group of result.groups) {
    if (group.hits.length > 0) return group.hits[0]
  }
  return null
}
