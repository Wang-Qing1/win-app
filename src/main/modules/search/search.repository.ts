import type { SearchField, SearchQuery, SearchSource } from '@shared/modules/search'
import type { Db } from '../../db/types'
import { containsPattern, parseJsonArray, toNumber } from '../../db/sql-utils'

/**
 * 检索仓储。
 *
 * 只负责 SQL 与行 → 中间结构的映射，不含任何「怎么切片段」的判断。
 * 四张表的结构差异在这一层被抹平：每个来源都产出同一种
 * `{ id, bookId, bookTitle, title, updatedAt, hits, fields[] }`，
 * 服务层因此只需要一个循环，不需要按来源 switch —— 将来再加一个来源
 * （比如「写作会话备注」）时，改动只落在这个文件和一份来源表上。
 */

/** 字段在 SQL 里的列名 + 它在契约里的字段名 */
interface FieldSpec {
  column: string
  field: SearchField
}

/**
 * 一个来源的检索描述。
 *
 * `fields` 的顺序有意义：它是**片段锚定的优先级**——正文排在标题前面，
 * 因为用户找的通常是一段话，而不是一个标题（标题命中会单独显示在结果里）。
 */
interface SourceSpec {
  source: SearchSource
  /** FROM 子句，含 LEFT JOIN 出来的 book_title */
  from: string
  /** 用于 bookId 过滤的列；books 表用自己 */
  bookColumn: string
  fields: readonly FieldSpec[]
}

const SOURCES: readonly SourceSpec[] = [
  {
    source: 'chapter',
    from: 'chapters t LEFT JOIN books b ON b.id = t.book_id',
    bookColumn: 't.book_id',
    fields: [
      { column: 't.content_text', field: 'content' },
      { column: 't.title', field: 'title' }
    ]
  },
  {
    source: 'card',
    from: 'cards t LEFT JOIN books b ON b.id = t.book_id',
    bookColumn: 't.book_id',
    fields: [
      { column: 't.content', field: 'content' },
      { column: 't.subtitle', field: 'subtitle' },
      { column: 't.tags', field: 'tags' },
      { column: 't.title', field: 'title' }
    ]
  },
  {
    source: 'outline',
    from: 'outline_nodes t LEFT JOIN books b ON b.id = t.book_id',
    bookColumn: 't.book_id',
    fields: [
      { column: 't.summary', field: 'summary' },
      { column: 't.title', field: 'title' }
    ]
  },
  {
    source: 'book',
    from: 'books t',
    bookColumn: 't.id',
    fields: [
      { column: 't.summary', field: 'summary' },
      { column: 't.genre', field: 'genre' },
      { column: 't.pen_name', field: 'penName' },
      { column: 't.title', field: 'title' }
    ]
  }
]

/** 行 → 服务层消费的中间结构 */
export interface SearchSourceRow {
  id: number
  bookId: number | null
  bookTitle: string | null
  title: string
  updatedAt: string
  /** 该来源命中的总条数，由窗口函数在同一次扫描里算出 */
  hits: number
  /** 字段名 → 已折成可展示文本的内容，顺序即锚定优先级 */
  fields: Array<{ field: SearchField; text: string }>
}

interface RawRow {
  id: number
  book_id: number | null
  book_title: string | null
  title: string
  updated_at: string
  hits: number
  [column: string]: unknown
}

export interface SearchSourcePage {
  rows: SearchSourceRow[]
  total: number
  truncated: boolean
}

/**
 * 拼检索条件。
 *
 * 语义是「**每个关键词都要在某个字段里命中**」，也就是 AND 套 OR：
 *
 *     词1 出现在任一字段  AND  词2 出现在任一字段  AND  …
 *
 * 这是全文检索的通行做法，也符合直觉：搜「林澈 星云」想找的是同时提到
 * 这两者的地方，而不是分别提到两者之一的所有地方。跨字段算命中 ——
 * 一个词落在标题、另一个落在正文，同样算这条记录同时满足两个词。
 *
 * 关键词一律经 `containsPattern` 转义并配 `ESCAPE '\'`：
 * 不转义时搜「100%」会退化成「以 100 开头的一切」，搜「_」会变成
 * 「任意一个字符」—— 结果看起来「能搜到东西」，所以这种 bug 很难被发现。
 */
function buildCondition(
  spec: SourceSpec,
  query: SearchQuery,
  params: Record<string, unknown>
): string {
  const clauses: string[] = []

  query.keywords.forEach((keyword, index) => {
    const name = `kw${index}`
    params[name] = containsPattern(keyword)
    const ors = spec.fields.map((field) => `${field.column} LIKE @${name} ESCAPE '\\'`).join(' OR ')
    clauses.push(`(${ors})`)
  })

  if (query.bookId !== null) {
    clauses.push(`${spec.bookColumn} = @bookId`)
    params.bookId = query.bookId
  }

  return clauses.join(' AND ')
}

/**
 * 标签列是 JSON 字符串（`["主角团","领航员"]`），直接当片段展示会带着
 * 方括号和引号，很难看。这里折成「主角团、领航员」。
 *
 * 折完之后关键词仍然是它的子串（搜「主角团」照样找得到），
 * 所以片段切片不会因为这一步而失去锚点。
 */
function displayTags(raw: string): string {
  return parseJsonArray(raw).join('、')
}

export class SearchRepository {
  constructor(private readonly db: Db) {}

  /**
   * 查一个来源。
   *
   * 只有**一条** SELECT，靠窗口函数 `COUNT(*) OVER ()` 在同一个游标里
   * 同时拿到「命中总数」和「本页若干行」。分成两条 SQL（一条 COUNT、
   * 一条取行）意味着对正文多扫一遍 —— 全库 1000 万字时那一遍是 50 毫秒，
   * 而窗口函数是免费的。窗口函数在逻辑执行顺序上早于 LIMIT，
   * 因此它统计的是**筛选后的全部行**，不受 LIMIT 影响。
   *
   * 多取一条（`limit + 1`）用来判断是否截断：比再跑一次计数便宜，
   * 而且天然与 LIMIT 口径一致。
   */
  searchSource(source: SearchSource, query: SearchQuery): SearchSourcePage {
    const spec = SOURCES.find((item) => item.source === source)
    if (!spec) return { rows: [], total: 0, truncated: false }

    const params: Record<string, unknown> = {}
    const condition = buildCondition(spec, query, params)

    const columns = spec.fields
      .map((field) => `${field.column} AS "${field.field}"`)
      .join(', ')

    const sql = `
      SELECT t.id                 AS id,
             ${spec.source === 'book' ? 't.id' : 't.book_id'} AS book_id,
             ${spec.source === 'book' ? 't.title' : 'b.title'} AS book_title,
             t.title              AS title,
             t.updated_at         AS updated_at,
             COUNT(*) OVER ()     AS hits,
             ${columns}
        FROM ${spec.from}
       WHERE ${condition}
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT @limit OFFSET 0
    `

    const rows = this.db
      .prepare(sql)
      .all({ ...params, limit: query.limit + 1 }) as RawRow[]

    const truncated = rows.length > query.limit
    const page = truncated ? rows.slice(0, query.limit) : rows

    return {
      rows: page.map((row) => this.toSourceRow(spec, row)),
      total: rows.length > 0 ? toNumber(rows[0].hits) : 0,
      truncated
    }
  }

  private toSourceRow(spec: SourceSpec, row: RawRow): SearchSourceRow {
    const fields = spec.fields.map((field) => {
      const raw = row[field.field]
      const text = typeof raw !== 'string' ? '' : raw
      return { field: field.field, text: field.field === 'tags' ? displayTags(text) : text }
    })

    return {
      id: toNumber(row.id),
      bookId: typeof row.book_id === 'number' ? row.book_id : null,
      bookTitle: typeof row.book_title === 'string' ? row.book_title : null,
      title: row.title,
      updatedAt: row.updated_at,
      hits: toNumber(row.hits),
      fields
    }
  }
}

/** 来源列表导出给服务层遍历，避免它自己再维护一份顺序 */
export const SEARCH_SOURCE_ORDER: readonly SearchSource[] = SOURCES.map((spec) => spec.source)
