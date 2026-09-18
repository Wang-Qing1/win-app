import {
  CARD_TYPES,
  isCardType,
  normalizeExtra,
  normalizeTags,
  type Card,
  type CardBookScope,
  type CardExtra,
  type CardListQuery,
  type CardSortField,
  type CardType
} from '@shared/modules/cards'
import type { Db } from '../../db/types'
import { containsPattern, parseJsonArray, parseJsonObject, toNumber } from '../../db/sql-utils'

interface CardRow {
  id: number
  book_id: number | null
  card_type: string
  title: string
  subtitle: string
  content: string
  tags: string
  extra: string
  created_at: string
  updated_at: string
}

interface CountRow {
  total: number
}

const SELECT_COLUMNS = `
  id, book_id, card_type, title, subtitle, content, tags, extra, created_at, updated_at
`

/**
 * 排序列白名单。
 * 客户端传来的 sortBy 已在共享层归一化为 CardSortField，这里再映射成真实列名 ——
 * 从不把客户端字符串拼进 SQL。
 */
const SORT_COLUMN: Record<CardSortField, string> = {
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  title: 'title COLLATE NOCASE'
}

/**
 * 一行 → 领域对象。
 *
 * `card_type` / `tags` / `extra` 三列在数据库里都是自由的 TEXT/JSON，
 * 这里统一做一次收敛：认不出的类型退回「灵感」，坏掉的 JSON 退回空集，
 * extra 则按类型投影成完整字段集。
 *
 * 退回「灵感」而不是「人物」是因为它的专属字段最少 —— 脏数据摊到它头上
 * 只会多出几个空输入框，而摊到人物卡上会凭空长出一组误导性的身份字段。
 */
function toCard(row: CardRow): Card {
  const cardType: CardType = isCardType(row.card_type) ? row.card_type : 'inspiration'

  return {
    id: row.id,
    bookId: row.book_id,
    cardType,
    title: row.title,
    subtitle: row.subtitle,
    content: row.content,
    tags: normalizeTags(parseJsonArray(row.tags)),
    extra: normalizeExtra(cardType, parseJsonObject(row.extra)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 待写入的一行。
 *
 * extra 与 tags 都是**已经规范化过**的值，由服务层准备好再传进来：
 * 仓储只负责 SQL 与行↔对象映射，不含业务判断。这样「写进库里的
 * extra 一定是完整字段集」这条不变式只有服务层一处实现。
 */
export interface CardWriteData {
  bookId: number | null
  cardType: CardType
  title: string
  subtitle: string
  content: string
  tags: string[]
  extra: CardExtra
}

interface FilterClause {
  where: string
  params: Record<string, unknown>
}

/**
 * 把查询条件拼成 WHERE 子句。
 *
 * 抽出来是因为同一个筛选条件要被跑三次：取本页数据、取总数、取各类型计数。
 * 三处各写一遍的话，任何一处漏掉一个条件都会让「总数」与「实际列出的条数」
 * 对不上，而且界面看起来完全正常（只是数字略大）。
 *
 * `includeType` 是给类型计数用的开关：它必须**忽略 cardType 这一项**，
 * 否则选中「人物」之后另外两类的计数会全变成 0。
 */
function buildFilter(query: CardListQuery, includeType: boolean): FilterClause {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  /*
   * 书籍范围。
   *
   * 「仅通用卡片」必须写成 `book_id IS NULL` 而不是 `book_id = NULL`：
   * 后者在 SQL 里永远不成立（NULL = NULL 既不是真也不是假），
   * 症状是「通用卡片一张都查不出来」，且不报任何错。
   */
  if (query.bookScope === 'global') {
    conditions.push('book_id IS NULL')
  } else if (query.bookScope === 'book' && query.bookId !== null) {
    conditions.push('book_id = @bookId')
    params.bookId = query.bookId
  }

  if (includeType && query.cardType !== null) {
    conditions.push('card_type = @cardType')
    params.cardType = query.cardType
  }

  if (query.keyword.length > 0) {
    /*
     * 标题、简介、正文、标签都参与搜索：卡片库的价值恰恰在于
     * 「记得有这么张卡、但想不起叫什么」时还能找回来。
     *
     * LIKE 的通配符必须转义（containsPattern 里做），否则用户搜 `100%`
     * 会变成「以 100 开头的一切」，搜 `_` 会变成「任意一个字符」——
     * 结果看起来是「能搜到东西」，所以这种 bug 通常很久都没人发现。
     */
    conditions.push(
      `(title LIKE @keyword ESCAPE '\\'
        OR subtitle LIKE @keyword ESCAPE '\\'
        OR content LIKE @keyword ESCAPE '\\'
        OR tags LIKE @keyword ESCAPE '\\')`
    )
    params.keyword = containsPattern(query.keyword)
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

/**
 * 仓储层：只负责 SQL 与行↔领域对象映射，不含任何业务判断。
 */
export class CardRepository {
  constructor(private readonly db: Db) {}

  /**
   * 取一页卡片，顺带算出总数与页码。
   *
   * 分页数学放在仓储而不是服务层：页码要基于**筛选后的总数**夹紧，
   * 拆成两处会让「第 3 页填不满时该显示第几页」这类边界出现两个版本。
   */
  listPaged(query: CardListQuery): {
    items: Card[]
    total: number
    page: number
    pageSize: number
    pageCount: number
  } {
    const filter = buildFilter(query, true)

    const total = toNumber(
      (
        this.db.prepare(`SELECT COUNT(*) AS total FROM cards ${filter.where}`).get(filter.params) as
          | CountRow
          | undefined
      )?.total
    )

    const pageCount = total === 0 ? 0 : Math.ceil(total / query.pageSize)
    const safePage = pageCount === 0 ? 1 : Math.min(query.page, pageCount)
    const offset = (safePage - 1) * query.pageSize

    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           FROM cards
           ${filter.where}
          ORDER BY ${SORT_COLUMN[query.sortBy]} ${query.sortOrder === 'asc' ? 'ASC' : 'DESC'}, id DESC
          LIMIT @limit OFFSET @offset`
      )
      .all({ ...filter.params, limit: query.pageSize, offset }) as CardRow[]

    return {
      items: rows.map(toCard),
      total,
      page: safePage,
      pageSize: query.pageSize,
      pageCount
    }
  }

  /**
   * 按类型计数（忽略 cardType 筛选，见 buildFilter 的说明）。
   *
   * 用一条 GROUP BY 而不是对三类各查一次：三次查询之间若发生写入，
   * 三个数字之和就可能不等于总数，界面上「人物 1 + 物品 1 + 灵感 2 ≠ 共 3」
   * 会让人怀疑整个数据。
   */
  countByType(query: CardListQuery): Record<CardType, number> {
    const filter = buildFilter(query, false)
    const rows = this.db
      .prepare(
        `SELECT card_type AS card_type, COUNT(*) AS n
           FROM cards
           ${filter.where}
          GROUP BY card_type`
      )
      .all(filter.params) as Array<{ card_type: string; n: number }>

    const counts = {} as Record<CardType, number>
    for (const cardType of CARD_TYPES) counts[cardType] = 0
    for (const row of rows) {
      // 认不出的类型不进任何一格：它们会被 toCard 归到「灵感」，
      // 但这里若也归进去，「灵感」的计数就会与实际列出的条数不符
      if (isCardType(row.card_type)) counts[row.card_type] = toNumber(row.n)
    }

    return counts
  }

  /** 不受书籍范围影响的「通用卡片」计数：只看当前的关键字与类型条件 */
  countGlobal(query: CardListQuery): number {
    const scope: CardBookScope = 'global'
    const filter = buildFilter({ ...query, bookScope: scope }, true)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM cards ${filter.where}`)
      .get(filter.params) as CountRow | undefined
    return toNumber(row?.total)
  }

  findById(id: number): Card | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM cards WHERE id = ?`).get(id) as
      | CardRow
      | undefined
    return row ? toCard(row) : null
  }

  /**
   * 业务唯一性校验：**同一本书、同一类型**下标题不可重名（不区分大小写）。
   *
   * 为什么把范围收紧到「同书 + 同类型」：
   *   - 不同书里出现同名的「林澈」完全正常（同一角色在不同书稿里）；
   *   - 人物卡与灵感卡同名也无所谓，本就是两类东西。
   * 这条规则挡的是「手滑又建了一张一模一样的卡」——多建一张就再也删不干净，
   * 因为两张卡看起来毫无区别。
   *
   * `book_id IS ?` 而不是 `= ?`：`= NULL` 恒不成立，会让**通用卡片之间的查重
   * 静默失效**（建十张同名通用灵感卡都不报错）。SQLite 的 `IS` 是 NULL 安全的比较。
   *
   * `excludeId` 默认 -1 表示「不排除任何行」：id 是自增主键、恒为正数，
   * 因此 `id <> -1` 恒成立。这样比「有没有 excludeId 就拼两种 SQL」少一条分支。
   */
  findByTitle(
    bookId: number | null,
    cardType: CardType,
    title: string,
    excludeId = -1
  ): Card | null {
    const row = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           FROM cards
          WHERE book_id IS ?
            AND card_type = ?
            AND title = ? COLLATE NOCASE
            AND id <> ?
          LIMIT 1`
      )
      .get(bookId, cardType, title, excludeId) as CardRow | undefined

    return row ? toCard(row) : null
  }

  countByBook(bookId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE book_id = ?').get(bookId) as {
      n: number
    }
    return toNumber(row.n)
  }

  /** 复制卡片时用来生成不撞名的标题 */
  listTitles(bookId: number | null, cardType: CardType): string[] {
    const rows = this.db
      .prepare('SELECT title FROM cards WHERE book_id IS ? AND card_type = ?')
      .all(bookId, cardType) as Array<{ title: string }>
    return rows.map((row) => row.title)
  }

  insert(data: CardWriteData, now: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO cards (book_id, card_type, title, subtitle, content, tags, extra, created_at, updated_at)
         VALUES (@bookId, @cardType, @title, @subtitle, @content, @tags, @extra, @createdAt, @updatedAt)`
      )
      .run({
        bookId: data.bookId,
        cardType: data.cardType,
        title: data.title,
        subtitle: data.subtitle,
        content: data.content,
        tags: JSON.stringify(data.tags),
        extra: JSON.stringify(data.extra),
        createdAt: now,
        updatedAt: now
      })

    return Number(result.lastInsertRowid)
  }

  update(data: CardWriteData & { id: number }, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE cards
            SET book_id = @bookId, card_type = @cardType, title = @title, subtitle = @subtitle,
                content = @content, tags = @tags, extra = @extra, updated_at = @updatedAt
          WHERE id = @id`
      )
      .run({
        id: data.id,
        bookId: data.bookId,
        cardType: data.cardType,
        title: data.title,
        subtitle: data.subtitle,
        content: data.content,
        tags: JSON.stringify(data.tags),
        extra: JSON.stringify(data.extra),
        updatedAt: now
      })

    return result.changes > 0
  }

  deleteById(id: number): boolean {
    const result = this.db.prepare('DELETE FROM cards WHERE id = ?').run(id)
    return result.changes > 0
  }
}
