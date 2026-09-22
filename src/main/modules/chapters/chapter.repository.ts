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
 *
 * **顺带带上「没进回收站」这一条**（第三期第 5 件）：走这个条件的四处
 * （列章节、列带正文的章节、数容器内章节数、取容器内 id 序列、取下一个
 * order_index）都必须只看活着的章节。放在这里而不是各调用点，
 * 是因为「容器里有哪些章节」只有这一个定义 —— 少写一处的症状极隐蔽：
 * 比如 countInContainer 漏掉时，重排会因为「提交的 id 数比容器里的少」
 * 而被判成「顺序提交不完整」，而用户只是刚删了一章。
 */
function containerCondition(volumeId: number | null): { sql: string; params: Array<number> } {
  const alive = 'c.deleted_at IS NULL'
  return volumeId === null
    ? { sql: `c.book_id = ? AND c.volume_id IS NULL AND ${alive}`, params: [] }
    : { sql: `c.book_id = ? AND c.volume_id = ? AND ${alive}`, params: [volumeId] }
}

/** 回收站列表用的一行：章节自己的字段 + 书名与卷名。见 listDeleted */
export interface DeletedChapterRow {
  id: number
  title: string
  bookId: number
  /**
   * 这一行**当前**的 volume_id（可能因为分卷被删而变成 null）。
   * 恢复时要用它决定落回哪个容器 —— 不能用「进回收站时的卷」。
   */
  volumeId: number | null
  bookTitle: string | null
  volumeTitle: string | null
  deletedAt: string
  hanziCount: number
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
            WHERE c.book_id = ? AND c.deleted_at IS NULL
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

  /**
   * 整本/整卷导出用：带正文的有序章节列表。
   *
   * 与 {@link list} 用同一套查询条件与排序规则（只多选一列 content_text），
   * 是为了确保“列表页看到的顺序”与“导出文件里的顺序”永远一致——
   * 若各写一份，两边的排序逻辑日后只修了其中一份，导出出来的书会与章节列表页对不上。
   */
  listWithContent(query: ChapterListQuery): Array<ChapterListItem & { contentText: string }> {
    const { bookId, volumeId } = query

    if (volumeId === undefined) {
      const rows = this.db
        .prepare(
          `SELECT ${LIST_COLUMNS}, c.content_text FROM chapters c
            WHERE c.book_id = ? AND c.deleted_at IS NULL
            ORDER BY c.volume_id IS NULL, c.volume_id ASC, c.order_index ASC, c.id ASC`
        )
        .all(bookId) as Array<ChapterListRow & { content_text: string }>
      return rows.map((row) => ({ ...toListItem(row), contentText: row.content_text }))
    }

    const condition = containerCondition(volumeId)
    const rows = this.db
      .prepare(
        `SELECT ${LIST_COLUMNS}, c.content_text FROM chapters c
          WHERE ${condition.sql}
          ORDER BY c.order_index ASC, c.id ASC`
      )
      .all(bookId, ...condition.params) as Array<ChapterListRow & { content_text: string }>

    return rows.map((row) => ({ ...toListItem(row), contentText: row.content_text }))
  }

  /**
   * 按 id 取**还在回收站外**的章节。
   *
   * 不做成「带 includeDeleted 开关」的版本：调用方要么在编辑一章
   * （必须活着），要么在处理回收站条目（必须已删），两个诉求各有一个
   * 语义明确的方法 —— 开关式的接口只要有一处忘了传，就会出现
   * 「自动保存把正文写进了已被删掉的章节」这种情况，而且不报错。
   */
  findById(id: number): Chapter | null {
    const row = this.db
      .prepare('SELECT * FROM chapters WHERE id = ? AND deleted_at IS NULL')
      .get(id) as ChapterRow | undefined
    return row ? toChapter(row) : null
  }

  findListItemById(id: number): ChapterListItem | null {
    const row = this.db
      .prepare(`SELECT ${LIST_COLUMNS} FROM chapters c WHERE c.id = ? AND c.deleted_at IS NULL`)
      .get(id) as ChapterListRow | undefined
    return row ? toListItem(row) : null
  }

  /** 按 id 取**回收站里**的章节。恢复与彻底删除的唯一入口 */
  findDeletedById(id: number): DeletedChapterRow | null {
    const row = this.db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.book_id AS book_id, c.volume_id AS volume_id,
                b.title AS book_title, v.title AS volume_title,
                c.deleted_at AS deleted_at, c.hanzi_count AS hanzi_count
           FROM chapters c
           LEFT JOIN books b   ON b.id = c.book_id
           LEFT JOIN volumes v ON v.id = c.volume_id
          WHERE c.id = ? AND c.deleted_at IS NOT NULL`
      )
      .get(id) as
      | {
          id: number
          title: string
          book_id: number
          volume_id: number | null
          book_title: string | null
          volume_title: string | null
          deleted_at: string
          hanzi_count: number
        }
      | undefined

    if (!row) return null
    return {
      id: row.id,
      title: row.title,
      bookId: row.book_id,
      volumeId: row.volume_id,
      bookTitle: row.book_title,
      volumeTitle: row.volume_title,
      deletedAt: row.deleted_at,
      hanziCount: toNumber(row.hanzi_count)
    }
  }

  exists(id: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM chapters WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { ok: number } | undefined
    return row?.ok === 1
  }

  countByBook(bookId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ? AND deleted_at IS NULL')
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

  /** 全库**活着的**章节数，供健康检查展示 */
  countAll(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE deleted_at IS NULL')
      .get() as { n: number }
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
          WHERE id = @id AND deleted_at IS NULL`
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
   *
   * `deleted_at IS NULL` 是回收站（第三期第 5 件）加的第二道闸：
   * 编辑器可能在另一处删掉这一章之后又自动保存一次，那道写入必须落到
   * 零行上。若它照常写进去，回收站里的章节正文会被悄悄改掉 ——
   * 而这恰恰是「恢复」要还原的东西。
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
          WHERE id = @id AND deleted_at IS NULL`
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

  /*
   * ---------------- 回收站（第三期第 5 件） ----------------
   *
   * 命名与卡片仓储一致：softDelete / restoreById 只改标记，
   * purgeById / purgeAll 真的 DELETE。
   *
   * 每条写语句都带上 `deleted_at IS [NOT] NULL` 作为第二道闸 ——
   * 服务层已经校验过状态，但真正决定「会发生什么」的是 SQL。
   */

  softDelete(id: number, now: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE chapters SET deleted_at = @deletedAt WHERE id = @id AND deleted_at IS NULL'
      )
      .run({ id, deletedAt: now })
    return result.changes > 0
  }

  /**
   * 从回收站恢复，并把它落在容器的**末尾**。
   *
   * 为什么不放回原来的位置：它进回收站的那一刻，所属容器就被重排过
   * （空位已经合拢，见 ChapterService.remove），原来的 order_index
   * 可能已经属于另一章了。硬插回原位会让两章争同一个下标，
   * 此后拖拽移动算出的顺序会变得不确定 —— 而「回到末尾」是确定、
   * 可解释、且不与任何现有章节冲突的。它与新写一章的落点一致，
   * 恢复出来的章节因此看起来就像刚加进来的。
   *
   * orderIndex 由服务层算（要先知道落到哪个容器），仓储不自己查 ——
   * 它只负责写。
   */
  restoreById(id: number, orderIndex: number, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE chapters
            SET deleted_at = NULL, order_index = @orderIndex, updated_at = @updatedAt
          WHERE id = @id AND deleted_at IS NOT NULL`
      )
      .run({ id, orderIndex, updatedAt: now })
    return result.changes > 0
  }

  /**
   * 彻底删除。它的历史版本（chapter_revisions）与卡片关联
   * （card_chapter_links）随外键 CASCADE 一并消失 ——
   * 这正是 006 / 009 里把外键定成 CASCADE 时的预期：
   * 数据真的没了，指向它的关联行留着只是脏数据。
   */
  purgeById(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM chapters WHERE id = @id AND deleted_at IS NOT NULL')
      .run({ id })
    return result.changes > 0
  }

  purgeAll(): number {
    const result = this.db.prepare('DELETE FROM chapters WHERE deleted_at IS NOT NULL').run()
    return result.changes
  }

  /**
   * 回收站里的章节，最近删除的在前。
   *
   * 书名与卷名都用 LEFT JOIN：volume_id 可能已经是 NULL（它所属的分卷
   * 被删过，ON DELETE SET NULL），用内连接会让这些章节整批从回收站里消失 ——
   * 而它们恰恰是最需要被看见的那一批。
   */
  listDeleted(limit: number): DeletedChapterRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.book_id AS book_id, c.volume_id AS volume_id,
                b.title AS book_title, v.title AS volume_title,
                c.deleted_at AS deleted_at, c.hanzi_count AS hanzi_count
           FROM chapters c
           LEFT JOIN books b   ON b.id = c.book_id
           LEFT JOIN volumes v ON v.id = c.volume_id
          WHERE c.deleted_at IS NOT NULL
          ORDER BY c.deleted_at DESC, c.id DESC
          LIMIT @limit`
      )
      .all({ limit }) as Array<{
      id: number
      title: string
      book_id: number
      volume_id: number | null
      book_title: string | null
      volume_title: string | null
      deleted_at: string
      hanzi_count: number
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      bookId: row.book_id,
      volumeId: row.volume_id,
      bookTitle: row.book_title,
      volumeTitle: row.volume_title,
      deletedAt: row.deleted_at,
      hanziCount: toNumber(row.hanzi_count)
    }))
  }

  countDeleted(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE deleted_at IS NOT NULL')
      .get() as { n: number }
    return toNumber(row.n)
  }

  /** 按传入顺序重写某个容器内的 order_index */
  reorder(input: ChapterReorderInput, now: string): number {
    const statement = this.db.prepare(
      `UPDATE chapters
          SET order_index = @orderIndex, updated_at = @updatedAt
        WHERE id = @id AND book_id = @bookId AND deleted_at IS NULL`
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
      .prepare(
        `UPDATE chapters SET volume_id = @volumeId, updated_at = @updatedAt
          WHERE id = @id AND deleted_at IS NULL`
      )
      .run({ id: move.id, volumeId: move.volumeId, updatedAt: now })

    // 两个容器都要重写：源容器要合拢被抽走留下的空位，
    // 目标容器要接纳新成员。只改一边会让某一边出现重复的 order_index。
    const statement = this.db.prepare(
      'UPDATE chapters SET order_index = @orderIndex WHERE id = @id AND deleted_at IS NULL'
    )
    targetOrderedIds.forEach((id, index) => {
      statement.run({ orderIndex: index, id })
    })

    const sourceIds = sourceOrderedIds.filter((id) => id !== move.id)
    sourceIds.forEach((id, index) => {
      statement.run({ orderIndex: index, id })
    })
  }

  /**
   * 供统计：全书最近编辑的章节（用于首页「继续写作」）。
   *
   * 只看活着的章节（第三期第 5 件）：「继续写作」不该把用户送到一章
   * 已经躺在回收站里的正文上 —— 那一章打开就是空的（或直接报不存在），
   * 而用户会以为自己的稿子丢了。
   */
  findLatestByBook(bookId: number): { id: number; title: string; updatedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, title, updated_at FROM chapters
          WHERE book_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(bookId) as { id: number; title: string; updated_at: string } | undefined

    return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : null
  }

  /**
   * 一天之内被编辑过的章节数，供统计页展示。
   *
   * 同样只看活着的：回收站里的章节不该算进「今天写了 N 章」——
   * 那是一句关于「产出」的话，而回收站里的东西是已经被作者否掉的。
   */
  countUpdatedBetween(fromIso: string, toIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM chapters
          WHERE updated_at >= ? AND updated_at <= ? AND deleted_at IS NULL`
      )
      .get(fromIso, toIso) as { n: number }
    return toNumber(row.n)
  }

  /** 全书最近一次编辑时间，供首页「最后编辑 2 小时前」 */
  latestUpdateAt(): string | null {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS latest FROM chapters WHERE deleted_at IS NULL')
      .get() as { latest: string | null }
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
            WHERE book_id IN (${placeholders}) AND deleted_at IS NULL
         ) WHERE rn = 1`
      )
      .all(...bookIds) as Array<{ book_id: number; id: number; title: string }>

    for (const row of rows) {
      result.set(row.book_id, { id: row.id, title: row.title })
    }
    return result
  }
}
