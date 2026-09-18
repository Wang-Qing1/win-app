import type {
  Volume,
  VolumeCreateInput,
  VolumeListItem,
  VolumeUpdateInput
} from '@shared/modules/volumes'
import type { Db } from '../../db/types'
import { toNumber } from '../../db/sql-utils'

interface VolumeRow {
  id: number
  book_id: number
  title: string
  summary: string
  order_index: number
  created_at: string
  updated_at: string
}

interface VolumeAggregateRow extends VolumeRow {
  chapter_count: number | null
  hanzi_count: number | null
}

/**
 * 分卷的聚合子查询。
 *
 * 只统计 volume_id 不为空的章节 —— 未分卷的章节不属于任何卷，
 * 若把它们也卷进来，每个卷的章节数都会多出同一批数字。
 */
const AGGREGATE_JOIN = `
  LEFT JOIN (
    SELECT volume_id,
           COUNT(*)         AS chapter_count,
           SUM(hanzi_count) AS hanzi_count
      FROM chapters
     WHERE volume_id IS NOT NULL
     GROUP BY volume_id
  ) c ON c.volume_id = v.id
`

function toVolume(row: VolumeRow): Volume {
  return {
    id: row.id,
    bookId: row.book_id,
    title: row.title,
    summary: row.summary,
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toVolumeListItem(row: VolumeAggregateRow): VolumeListItem {
  return {
    ...toVolume(row),
    chapterCount: toNumber(row.chapter_count),
    hanziCount: toNumber(row.hanzi_count)
  }
}

export class VolumeRepository {
  constructor(private readonly db: Db) {}

  listByBook(bookId: number): VolumeListItem[] {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.book_id, v.title, v.summary, v.order_index, v.created_at, v.updated_at,
                COALESCE(c.chapter_count, 0) AS chapter_count,
                COALESCE(c.hanzi_count, 0)   AS hanzi_count
           FROM volumes v
           ${AGGREGATE_JOIN}
          WHERE v.book_id = ?
          ORDER BY v.order_index ASC, v.id ASC`
      )
      .all(bookId) as VolumeAggregateRow[]

    return rows.map(toVolumeListItem)
  }

  findById(id: number): Volume | null {
    const row = this.db.prepare('SELECT * FROM volumes WHERE id = ?').get(id) as VolumeRow | undefined
    return row ? toVolume(row) : null
  }

  /**
   * 按 id 取带聚合的列表项。
   *
   * 创建/更新后需要回读聚合字段（章节数、字数）来保证返回类型与列表一致。
   * 单条查询而不是「取整本书的分卷再 find」：书的卷数可能有几十个，
   * 每次写操作都全量拉一遍是没必要的小浪费。
   */
  findListItemById(id: number): VolumeListItem | null {
    const row = this.db
      .prepare(
        `SELECT v.id, v.book_id, v.title, v.summary, v.order_index, v.created_at, v.updated_at,
                COALESCE(c.chapter_count, 0) AS chapter_count,
                COALESCE(c.hanzi_count, 0)   AS hanzi_count
           FROM volumes v
           ${AGGREGATE_JOIN}
          WHERE v.id = ?`
      )
      .get(id) as VolumeAggregateRow | undefined

    return row ? toVolumeListItem(row) : null
  }

  /** 书名之内唯一即可：不同书里各有一个「第一卷」是正常的 */
  findByTitle(bookId: number, title: string, excludeId?: number): Volume | null {
    const row = (excludeId === undefined
      ? this.db
          .prepare('SELECT * FROM volumes WHERE book_id = ? AND title = ? COLLATE NOCASE LIMIT 1')
          .get(bookId, title)
      : this.db
          .prepare(
            'SELECT * FROM volumes WHERE book_id = ? AND title = ? COLLATE NOCASE AND id <> ? LIMIT 1'
          )
          .get(bookId, title, excludeId)) as VolumeRow | undefined
    return row ? toVolume(row) : null
  }

  countByBook(bookId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM volumes WHERE book_id = ?')
      .get(bookId) as { n: number }
    return toNumber(row.n)
  }

  /** 追加到末尾时用。COALESCE 保证空表时从 0 开始 */
  nextOrderIndex(bookId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(order_index) + 1, 0) AS n FROM volumes WHERE book_id = ?')
      .get(bookId) as { n: number }
    return toNumber(row.n)
  }

  insert(input: VolumeCreateInput, orderIndex: number, now: string): Volume {
    const result = this.db
      .prepare(
        `INSERT INTO volumes (book_id, title, summary, order_index, created_at, updated_at)
         VALUES (@bookId, @title, @summary, @orderIndex, @createdAt, @updatedAt)`
      )
      .run({
        bookId: input.bookId,
        title: input.title,
        summary: input.summary,
        orderIndex,
        createdAt: now,
        updatedAt: now
      })

    const created = this.findById(Number(result.lastInsertRowid))
    if (!created) {
      throw new Error('新增分卷后无法回读记录')
    }
    return created
  }

  update(input: VolumeUpdateInput, now: string): Volume | null {
    const result = this.db
      .prepare(
        `UPDATE volumes SET title = @title, summary = @summary, updated_at = @updatedAt WHERE id = @id`
      )
      .run({ id: input.id, title: input.title, summary: input.summary, updatedAt: now })

    if (result.changes === 0) return null
    return this.findById(input.id)
  }

  /** 卷下章节数：删除前用它算「这些章节会退回未分卷」的提示文案 */
  countChapters(volumeId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE volume_id = ?')
      .get(volumeId) as { n: number }
    return toNumber(row.n)
  }

  deleteById(id: number): boolean {
    // chapters.volume_id 是 ON DELETE SET NULL：卷下的章节会退回「未分卷」，
    // 而不是跟着卷一起消失。删一个容器不该毁掉里面的内容。
    const result = this.db.prepare('DELETE FROM volumes WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * 重排：按传入顺序重写 order_index。
   *
   * 只对确实属于这本书、且出现在 orderedIds 里的卷生效。
   * 调用方（服务层）已经校验过完整性，这里再做一次归属过滤是纵深防御：
   * 万一将来有人绕过服务层直接调仓储，也不会把别的书的卷顺序改掉。
   */
  reorder(bookId: number, orderedIds: readonly number[], now: string): number {
    const statement = this.db.prepare(
      'UPDATE volumes SET order_index = @orderIndex, updated_at = @updatedAt WHERE id = @id AND book_id = @bookId'
    )

    let changed = 0
    orderedIds.forEach((id, index) => {
      const result = statement.run({ orderIndex: index, updatedAt: now, id, bookId })
      changed += result.changes
    })

    return changed
  }

  /** 校验一批 id 是否全部属于指定书，用于重排前的一致性检查 */
  countMatching(bookId: number, ids: readonly number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM volumes WHERE book_id = ? AND id IN (${placeholders})`)
      .get(bookId, ...ids) as { n: number }
    return toNumber(row.n)
  }
}
