import type {
  Chapter,
  ChapterListItem,
  ChapterListQuery,
  ChapterMoveInput,
  ChapterReorderInput,
  ChapterSaveContentInput,
  ChapterStatus,
  ChapterUpdateInput,
  ChapterCreateInput
} from '@shared/modules/chapters'
import { CHAPTER_STATUSES } from '@shared/modules/chapters'
import type { Db } from '../../db/types'
import { toNumber } from '../../db/sql-utils'

interface ChapterListRow {
  id: number
  book_id: number
  volume_id: number | null
  title: string
  status: string
  order_index: number
  hanzi_count: number
  char_count: number
  target_words: number
  created_at: string
  updated_at: string
}

interface ChapterRow extends ChapterListRow {
  content_html: string
  content_text: string
}

/**
 * 列表查询的列清单。
 *
 * 刻意不含 content_html / content_text：一本书的正文可能有几十上百万字，
 * 列表接口若顺手把正文一起 select 出来，序列化过 IPC 的开销会随书本规模线性增长，
 * 而列表页一个字的正文都不需要。正文只在 chapters:get 里按需取。
 */
const LIST_COLUMNS = `
  c.id, c.book_id, c.volume_id, c.title, c.status, c.order_index,
  c.hanzi_count, c.char_count, c.target_words, c.created_at, c.updated_at
`

function normalizeStatus(raw: string): ChapterStatus {
  return (CHAPTER_STATUSES as readonly string[]).includes(raw) ? (raw as ChapterStatus) : 'draft'
}

function toListItem(row: ChapterListRow): ChapterListItem {
  return {
    id: row.id,
    bookId: row.book_id,
    volumeId: row.volume_id,
    title: row.title,
    status: normalizeStatus(row.status),
    orderIndex: row.order_index,
    hanziCount: toNumber(row.hanzi_count),
    charCount: toNumber(row.char_count),
    targetWords: toNumber(row.target_words),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toChapter(row: ChapterRow): Chapter {
  return {
    ...toListItem(row),
    contentHtml: row.content_html,
    contentText: row.content_text
  }
}

/**
 * 容器条件。
 *
 * volumeId 为 null 时必须用 `IS NULL` 而不是 `= NULL`——后者在 SQL 里
 * 永远不成立，症状是「未分卷的章节列表永远是空的」，而且不会报任何错。
 */
function containerCondition(volumeId: number | null): { sql: string; params: Array<number> } {
  return volumeId === null
    ? { sql: 'c.book_id = ? AND c.volume_id IS NULL', params: [] }
    : { sql: 'c.book_id = ? AND c.volume_id = ?', params: [volumeId] }
}

export class ChapterRepository {
  constructor(private readonly db: Db) {}

  /** 整本书的章节，或某个容器（分卷 / 未分卷区间）内的章节 */
  list(query: ChapterListQuery): ChapterListItem[] {
    const { bookId, volumeId } = query

    if (volumeId === undefined) {
      const rows = this.db
        .prepare(
          `SELECT ${LIST_COLUMNS} FROM chapters c
            WHERE c.book_id = ?
            ORDER BY c.volume_id IS NULL, c.volume_id ASC, c.order_index ASC, c.id ASC`
        )
        .all(bookId) as ChapterListRow[]
      return rows.map(toListItem)
    }

    const condition = containerCondition(volumeId)
    const rows = this.db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM chapters c
          WHERE ${condition.sql}
          ORDER BY c.order_index ASC, c.id ASC`
      )
      .all(bookId, ...condition.params) as ChapterListRow[]

    return rows.map(toListItem)
  }

  findById(id: number): Chapter | null {
    const row = this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(id) as ChapterRow | undefined
    return row ? toChapter(row) : null
  }

  findListItemById(id: number): ChapterListItem | null {
    const row = this.db
      .prepare(`SELECT ${LIST_COLUMNS} FROM chapters c WHERE c.id = ?`)
      .get(id) as ChapterListRow | undefined
    return row ? toListItem(row) : null
  }

  exists(id: number): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM chapters WHERE id = ?').get(id) as
      | { ok: number }
      | undefined
    return row?.ok === 1
  }

  countByBook(bookId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?')
      .get(bookId) as { n: number }
    return toNumber(row.n)
  }

  countInContainer(bookId: number, volumeId: number | null): number {
    const condition = containerCondition(volumeId)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM chapters c WHERE ${condition.sql}`)
      .get(bookId, ...condition.params) as { n: number }
    return toNumber(row.n)
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number }
    return toNumber(row.n)
  }

  /** 容器内的章节 id，按当前顺序。重排与移动都以它为基准 */
  listIdsInContainer(bookId: number, volumeId: number | null): number[] {
    const condition = containerCondition(volumeId)
    const rows = this.db
      .prepare(
        `SELECT c.id FROM chapters c WHERE ${condition.sql} ORDER BY c.order_index ASC, c.id ASC`
      )
      .all(bookId, ...condition.params) as Array<{ id: number }>
    return rows.map((row) => row.id)
  }

  nextOrderIndex(bookId: number, volumeId: number | null): number {
    const condition = containerCondition(volumeId)
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(c.order_index) + 1, 0) AS n FROM chapters c WHERE ${condition.sql}`
      )
      .get(bookId, ...condition.params) as { n: number }
    return toNumber(row.n)
  }

  insert(input: ChapterCreateInput, orderIndex: number, now: string): ChapterListItem {
    const result = this.db
      .prepare(
        `INSERT INTO chapters (book_id, volume_id, title, content_html, content_text,
                               hanzi_count, char_count, target_words, status, order_index,
                               created_at, updated_at)
         VALUES (@bookId, @volumeId, @title, '', '', 0, 0, @targetWords, 'draft', @orderIndex,
                 @createdAt, @updatedAt)`
      )
      .run({
        bookId: input.bookId,
        volumeId: input.volumeId,
        title: input.title,
        targetWords: input.targetWords,
        orderIndex,
        createdAt: now,
        updatedAt: now
      })

    const created = this.findListItemById(Number(result.lastInsertRowid))
    if (!created) {
      throw new Error('新增章节后无法回读记录')
    }
    return created
  }

  /** 元数据更新（标题 / 状态 / 所属分卷 / 本章目标），不碰正文 */
  updateMeta(input: ChapterUpdateInput, now: string): ChapterListItem | null {
    const result = this.db
      .prepare(
        `UPDATE chapters
            SET title = @title, status = @status, volume_id = @volumeId,
                target_words = @targetWords, updated_at = @updatedAt
          WHERE id = @id`
      )
      .run({
        id: input.id,
        title: input.title,
        status: input.status,
        volumeId: input.volumeId,
        targetWords: input.targetWords,
        updatedAt: now
      })

    if (result.changes === 0) return null
    return this.findListItemById(input.id)
  }

  /**
   * 保存正文。
   *
   * 三个派生值（content_text / hanzi_count / char_count）与正文在**同一条 UPDATE**
   * 里写入。拆成多条语句的话，任何一条失败都会留下「正文是新的、字数是旧的」
   * 这种自相矛盾的状态，而统计页会长期显示一个错的数字。
   */
  saveContent(
    input: ChapterSaveContentInput,
    derived: { contentText: string; hanziCount: number; charCount: number },
    now: string
  ): { id: number; hanziCount: number; charCount: number; updatedAt: string } | null {
    const result = this.db
      .prepare(
        `UPDATE chapters
            SET content_html = @contentHtml,
                content_text = @contentText,
                hanzi_count  = @hanziCount,
                char_count   = @charCount,
                updated_at   = @updatedAt
          WHERE id = @id`
      )
      .run({
        id: input.id,
        contentHtml: input.contentHtml,
        contentText: derived.contentText,
        hanziCount: derived.hanziCount,
        charCount: derived.charCount,
        updatedAt: now
      })

    if (result.changes === 0) return null
    return {
      id: input.id,
      hanziCount: derived.hanziCount,
      charCount: derived.charCount,
      updatedAt: now
    }
  }

  deleteById(id: number): boolean {
    const result = this.db.prepare('DELETE FROM chapters WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** 按传入顺序重写某个容器内的 order_index */
  reorder(input: ChapterReorderInput, now: string): number {
    const statement = this.db.prepare(
      `UPDATE chapters
          SET order_index = @orderIndex, updated_at = @updatedAt
        WHERE id = @id AND book_id = @bookId`
    )

    let changed = 0
    input.orderedIds.forEach((id, index) => {
      changed += statement.run({
        orderIndex: index,
        updatedAt: now,
        id,
        bookId: input.bookId
      }).changes
    })

    return changed
  }

  /** 把一章挪到另一个容器并落到指定位置。调用方负责算好两份 id 序列 */
  applyMove(
    move: ChapterMoveInput,
    sourceOrderedIds: readonly number[],
    targetOrderedIds: readonly number[],
    now: string
  ): void {
    this.db
      .prepare('UPDATE chapters SET volume_id = @volumeId, updated_at = @updatedAt WHERE id = @id')
      .run({ id: move.id, volumeId: move.volumeId, updatedAt: now })

    // 两个容器都要重写：源容器要合拢被抽走留下的空位，
    // 目标容器要接纳新成员。只改一边会让某一边出现重复的 order_index。
    const statement = this.db.prepare(
      'UPDATE chapters SET order_index = @orderIndex WHERE id = @id'
    )
    targetOrderedIds.forEach((id, index) => {
      statement.run({ orderIndex: index, id })
    })

    const sourceIds = sourceOrderedIds.filter((id) => id !== move.id)
    sourceIds.forEach((id, index) => {
      statement.run({ orderIndex: index, id })
    })
  }

  /** 供统计：全书最近编辑的章节（用于首页「继续写作」） */
  findLatestByBook(bookId: number): { id: number; title: string; updatedAt: string } | null {
    const row = this.db
      .prepare(
        'SELECT id, title, updated_at FROM chapters WHERE book_id = ? ORDER BY updated_at DESC LIMIT 1'
      )
      .get(bookId) as { id: number; title: string; updated_at: string } | undefined

    return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : null
  }

  /** 一天之内被编辑过的章节数，供统计页展示 */
  countUpdatedBetween(fromIso: string, toIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE updated_at >= ? AND updated_at <= ?')
      .get(fromIso, toIso) as { n: number }
    return toNumber(row.n)
  }

  /** 全书最近一次编辑时间，供首页「最后编辑 2 小时前」 */
  latestUpdateAt(): string | null {
    const row = this.db.prepare('SELECT MAX(updated_at) AS latest FROM chapters').get() as {
      latest: string | null
    }
    return row.latest ?? null
  }

  /**
   * 一次查出多本书各自最近编辑的那一章。
   *
   * 用窗口函数而不是「循环里对每本书查一次」：后者是标准的 N+1，
   * 首页显示 5 本书就是 5 次查询，统计页要对比 20 本时变成 20 次。
   * SQLite 3.25 起支持窗口函数，better-sqlite3 内置的版本远高于此。
   */
  latestByBooks(bookIds: readonly number[]): Map<number, { id: number; title: string }> {
    const result = new Map<number, { id: number; title: string }>()
    if (bookIds.length === 0) return result

    const placeholders = bookIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT book_id, id, title FROM (
           SELECT book_id, id, title,
                  ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY updated_at DESC, id DESC) AS rn
             FROM chapters
            WHERE book_id IN (${placeholders})
         ) WHERE rn = 1`
      )
      .all(...bookIds) as Array<{ book_id: number; id: number; title: string }>

    for (const row of rows) {
      result.set(row.book_id, { id: row.id, title: row.title })
    }
    return result
  }
}
