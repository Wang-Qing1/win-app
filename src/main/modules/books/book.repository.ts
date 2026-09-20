import {
  BOOK_STATUSES,
  type Book,
  type BookCreateInput,
  type BookListItem,
  type BookListQuery,
  type BookListResult,
  type BookSortField,
  type BookStats,
  type BookStatus,
  type BookUpdateInput
} from '@shared/modules/books'
import type { Db } from '../../db/types'
import { containsPattern, toNumber } from '../../db/sql-utils'

interface BookRow {
  id: number
  title: string
  pen_name: string
  genre: string
  status: string
  summary: string
  target_words: number
  chapter_words: number
  accent_color: string
  created_at: string
  updated_at: string
}

interface BookAggregateRow extends BookRow {
  volume_count: number | null
  chapter_count: number | null
  hanzi_count: number | null
  last_edited_at: string | null
}

interface CountRow {
  total: number
}

/**
 * 排序列白名单。
 * 客户端传来的 sortBy 已在共享层归一化为 BookSortField，
 * 这里再映射成真实列名 —— 从不把客户端字符串拼进 SQL。
 * hanziCount 是聚合出来的别名，SQLite 允许在 ORDER BY 里引用它。
 */
const SORT_COLUMN: Record<BookSortField, string> = {
  title: 'b.title COLLATE NOCASE',
  createdAt: 'b.created_at',
  updatedAt: 'b.updated_at',
  hanziCount: 'hanzi_count'
}

/**
 * 列表用的聚合子查询。
 *
 * 刻意用两个独立子查询而不是 `LEFT JOIN chapters ... LEFT JOIN volumes ...`：
 * 两个一对多关联同时 JOIN 会产生笛卡尔积，章节会被按分卷数重复累加，
 * SUM(hanzi_count) 于是虚高——而且分卷越多错得越离谱，很难第一时间发现。
 * 各自先聚合再关联，从根上避免这个问题。
 */
const AGGREGATE_JOINS = `
  LEFT JOIN (
    SELECT book_id, COUNT(*) AS volume_count
      FROM volumes
     GROUP BY book_id
  ) v ON v.book_id = b.id
  LEFT JOIN (
    SELECT book_id,
           COUNT(*)          AS chapter_count,
           SUM(hanzi_count)  AS hanzi_count,
           MAX(updated_at)   AS last_edited_at
      FROM chapters
     GROUP BY book_id
  ) c ON c.book_id = b.id
`

function toBook(row: BookRow): Book {
  return {
    id: row.id,
    title: row.title,
    penName: row.pen_name,
    // 数据库里存的是字符串，读出来时收敛到联合类型。
    // 理论上不可能越界（写入侧有 Zod），但真出现脏数据时不该让前端崩掉
    status: (BOOK_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as BookStatus)
      : 'idea',
    genre: row.genre,
    summary: row.summary,
    targetWords: row.target_words,
    chapterWords: row.chapter_words,
    accentColor: row.accent_color,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toBookListItem(row: BookAggregateRow): BookListItem {
  return {
    ...toBook(row),
    volumeCount: toNumber(row.volume_count),
    chapterCount: toNumber(row.chapter_count),
    hanziCount: toNumber(row.hanzi_count),
    lastEditedAt: row.last_edited_at
  }
}

/**
 * 仓储层：只负责 SQL 与行↔领域对象映射，不含任何业务判断。
 */
export class BookRepository {
  constructor(private readonly db: Db) {}

  list(query: BookListQuery): BookListResult {
    const { keyword, status, page, pageSize, sortBy, sortOrder } = query

    const conditions: string[] = []
    const params: Record<string, unknown> = {}

    if (keyword.length > 0) {
      // 书名、笔名、题材都参与搜索 —— 写了几十本之后，靠记忆找书名的成本很高
      conditions.push(
        `(b.title LIKE @keyword ESCAPE '\\' OR b.pen_name LIKE @keyword ESCAPE '\\' OR b.genre LIKE @keyword ESCAPE '\\')`
      )
      params.keyword = containsPattern(keyword)
    }

    if (status !== null) {
      conditions.push('b.status = @status')
      params.status = status
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const total = toNumber(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM books b ${whereClause}`).get(params) as
        | CountRow
        | undefined)?.total
    )

    const pageCount = total === 0 ? 0 : Math.ceil(total / pageSize)
    const safePage = pageCount === 0 ? 1 : Math.min(page, pageCount)
    const offset = (safePage - 1) * pageSize

    const rows = this.db
      .prepare(
        `SELECT b.id, b.title, b.pen_name, b.genre, b.status, b.summary,
                b.target_words, b.chapter_words, b.accent_color, b.created_at, b.updated_at,
                COALESCE(v.volume_count, 0)  AS volume_count,
                COALESCE(c.chapter_count, 0) AS chapter_count,
                COALESCE(c.hanzi_count, 0)   AS hanzi_count,
                c.last_edited_at
           FROM books b
           ${AGGREGATE_JOINS}
           ${whereClause}
          ORDER BY ${SORT_COLUMN[sortBy]} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}, b.id DESC
          LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset }) as BookAggregateRow[]

    return {
      items: rows.map(toBookListItem),
      total,
      page: safePage,
      pageSize,
      pageCount
    }
  }

  findById(id: number): Book | null {
    const row = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined
    return row ? toBook(row) : null
  }

  /** 业务唯一性校验用：同名（不区分大小写）即视为重复，可排除自身 */
  findByTitle(title: string, excludeId?: number): Book | null {
    const row = (excludeId === undefined
      ? this.db.prepare('SELECT * FROM books WHERE title = ? COLLATE NOCASE LIMIT 1').get(title)
      : this.db
          .prepare('SELECT * FROM books WHERE title = ? COLLATE NOCASE AND id <> ? LIMIT 1')
          .get(title, excludeId)) as BookRow | undefined
    return row ? toBook(row) : null
  }

  exists(id: number): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM books WHERE id = ?').get(id) as
      | { ok: number }
      | undefined
    return row?.ok === 1
  }

  insert(input: BookCreateInput, now: string): Book {
    const result = this.db
      .prepare(
        `INSERT INTO books (title, pen_name, genre, status, summary, target_words, chapter_words, accent_color, created_at, updated_at)
         VALUES (@title, @penName, @genre, @status, @summary, @targetWords, @chapterWords, @accentColor, @createdAt, @updatedAt)`
      )
      .run({
        title: input.title,
        penName: input.penName,
        genre: input.genre,
        status: input.status,
        summary: input.summary,
        targetWords: input.targetWords,
        chapterWords: input.chapterWords,
        accentColor: input.accentColor,
        createdAt: now,
        updatedAt: now
      })

    const created = this.findById(Number(result.lastInsertRowid))
    if (!created) {
      throw new Error('新增书籍后无法回读记录')
    }
    return created
  }

  update(input: BookUpdateInput, now: string): Book | null {
    const result = this.db
      .prepare(
        `UPDATE books
            SET title = @title,
                pen_name = @penName,
                genre = @genre,
                status = @status,
                summary = @summary,
                target_words = @targetWords,
                chapter_words = @chapterWords,
                accent_color = @accentColor,
                updated_at = @updatedAt
          WHERE id = @id`
      )
      .run({
        id: input.id,
        title: input.title,
        penName: input.penName,
        genre: input.genre,
        status: input.status,
        summary: input.summary,
        targetWords: input.targetWords,
        chapterWords: input.chapterWords,
        accentColor: input.accentColor,
        updatedAt: now
      })

    if (result.changes === 0) return null
    return this.findById(input.id)
  }

  /**
   * 只更新 updated_at（"碰一下"）。
   *
   * 章节保存后必须调用它：书籍列表默认按 updated_at 排序，
   * 如果不碰，用户写了三万字但书的排序位置还停在创建那一刻。
   */
  touch(id: number, now: string): void {
    this.db.prepare('UPDATE books SET updated_at = ? WHERE id = ? AND updated_at < ?').run(now, id, now)
  }

  deleteById(id: number): boolean {
    // 外键已开启且都带 ON DELETE CASCADE，
    // 删书会连带删掉它的分卷、章节、大纲节点与卡片（书写记录会保留，见迁移注释）
    const result = this.db.prepare('DELETE FROM books WHERE id = ?').run(id)
    return result.changes > 0
  }

  countAll(): number {
    return toNumber(
      (this.db.prepare('SELECT COUNT(*) AS total FROM books').get() as CountRow | undefined)?.total
    )
  }

  countByStatus(status: BookStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM books WHERE status = ?').get(status) as {
      n: number
    }
    return toNumber(row.n)
  }

  /**
   * 在写书籍的目标字数之和。
   *
   * 首页进度用的是「已写字数 / 在写目标」，而不是「已写字数 / 全部书籍目标之和」——
   * 后者会把构思阶段的空目标、以及已完结的书的目标也算进分母，
   * 于是完成度永远偏低，看起来像是一直没进展。
   */
  sumTargetWordsByStatus(status: BookStatus): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(target_words), 0) AS n FROM books WHERE status = ?')
      .get(status) as { n: number }
    return toNumber(row.n)
  }

  /** 最近编辑过的前 N 本，供首页「在写书籍」列表 */
  listRecent(limit: number): Book[] {
    const rows = this.db
      .prepare('SELECT * FROM books ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as BookRow[]
    return rows.map(toBook)
  }

  stats(): BookStats {
    const total = this.countAll()

    const byStatus = Object.fromEntries(BOOK_STATUSES.map((status) => [status, 0])) as Record<
      BookStatus,
      number
    >
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM books GROUP BY status')
      .all() as Array<{ status: string; n: number }>
    for (const row of statusRows) {
      if ((BOOK_STATUSES as readonly string[]).includes(row.status)) {
        byStatus[row.status as BookStatus] = toNumber(row.n)
      }
    }

    const chapterRow = this.db
      .prepare(
        'SELECT COUNT(*) AS chapter_count, COALESCE(SUM(hanzi_count), 0) AS hanzi_count, COALESCE(SUM(char_count), 0) AS char_count FROM chapters'
      )
      .get() as { chapter_count: number; hanzi_count: number; char_count: number }

    const volumeRow = this.db.prepare('SELECT COUNT(*) AS n FROM volumes').get() as { n: number }
    const targetRow = this.db
      .prepare('SELECT COALESCE(SUM(target_words), 0) AS n FROM books')
      .get() as { n: number }

    return {
      total,
      byStatus,
      chapterCount: toNumber(chapterRow.chapter_count),
      volumeCount: toNumber(volumeRow.n),
      hanziCount: toNumber(chapterRow.hanzi_count),
      charCount: toNumber(chapterRow.char_count),
      totalTargetWords: toNumber(targetRow.n)
    }
  }
}
