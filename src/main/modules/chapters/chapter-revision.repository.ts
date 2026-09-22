import type { Db } from '../../db/types'
import type { ChapterRestoreResult, ChapterRevision, ChapterRevisionSummary } from '../../../shared/modules/chapters'

/**
 * 章节历史版本的存取。
 *
 * 与 ChapterRepository 分开放，而不是塞进那一个 405 行的文件里：两者
 * 读写的是两张不同的表、各有一套查询形状，而「版本」这一侧只有
 * 三个动作（写一版、列一页、读一版）外加一个剪枝。分开之后
 * chapter.repository 不必为一堆只碰 revisions 表的 SQL 让出篇幅。
 *
 * 这里**不含事务**：留快照、剪枝、回档三件事都必须与「写正文」在
 * 同一个事务里，否则会出现「正文已经改了但快照没留」或反过来的
 * 半成品状态。事务由 service 统一开。
 */

/** 列表查询结果：多个计数字段做增量时需要知道该章是否已有版本 */
export interface ChapterRevisionRow extends ChapterRevisionSummary {
  /** 同一章内比它更早的版本有几个，用于判断「最早的一版」 */
  earlierCount: number
}

export class ChapterRevisionRepository {
  constructor(private readonly db: Db) {}

  /**
   * 列某一章的版本，最新在前。
   *
   * deltaHanzi（相对前一版增减）不落库 —— 它由「本版与「本版的下一版，
   * 也就是时间上更早的那个」相减得到，是纯派生值。存起来反而会引入
   * 「剪枝删掉中间某版后，存下来的 delta 全部失真」这类问题；
   * 用窗口函数现算，剪枝之后自动就是对的。
   */
  listByChapter(chapterId: number): ChapterRevisionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id,
                chapter_id  AS chapterId,
                hanzi_count AS hanziCount,
                created_at  AS createdAt,
                LEAD(hanzi_count) OVER (ORDER BY created_at DESC, id DESC) AS earlierHanzi,
                ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC)      AS seq,
                COUNT(*) OVER ()                                            AS total
           FROM chapter_revisions
          WHERE chapter_id = @chapterId
          ORDER BY created_at DESC, id DESC`
      )
      .all({ chapterId }) as Array<{
      id: number
      chapterId: number
      hanziCount: number
      createdAt: string
      earlierHanzi: number | null
      seq: number
      total: number
    }>

    return rows.map((row) => ({
      id: row.id,
      chapterId: row.chapterId,
      hanziCount: row.hanziCount,
      // null 表示这是最早的一版，前面没有可比对象
      deltaHanzi: row.earlierHanzi === null ? null : row.hanziCount - row.earlierHanzi,
      createdAt: row.createdAt,
      earlierCount: row.seq - 1
    }))
  }

  /** 读一版完整内容。返回 null 表示这版已被剪枝或本就属于别的章节 */
  findById(id: number): ChapterRevision | null {
    const row = this.db
      .prepare(
        `SELECT id,
                chapter_id   AS chapterId,
                content_html AS contentHtml,
                content_text AS contentText,
                hanzi_count  AS hanziCount,
                char_count   AS charCount,
                created_at   AS createdAt
           FROM chapter_revisions
          WHERE id = @id`
      )
      .get({ id }) as Omit<ChapterRevision, 'deltaHanzi'> | undefined

    if (!row) return null

    // 详情页只看这一版本身，不显示增减；delta 只在列表里有意义
    return { ...row, deltaHanzi: null } satisfies ChapterRevision
  }

  /** 写一版快照。返回新版本的 id */
  insertSnapshot(input: {
    chapterId: number
    contentHtml: string
    contentText: string
    hanziCount: number
    charCount: number
    createdAt: string
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO chapter_revisions
           (chapter_id, content_html, content_text, hanzi_count, char_count, created_at)
         VALUES
           (@chapterId, @contentHtml, @contentText, @hanziCount, @charCount, @createdAt)`
      )
      .run(input)

    return Number(result.lastInsertRowid)
  }

  /** 该章现有版本数 */
  countByChapter(chapterId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM chapter_revisions WHERE chapter_id = @chapterId`)
      .get({ chapterId }) as { n: number }
    return row.n
  }

  /**
   * 剪枝：只留最新 keep 版。
   *
   * 用 `id NOT IN (最新的 keep 个)` 而不是「按 created_at 排序删旧的」——
   * 同一秒内可能落两版（自动保存与手动保存撞在一起），此时 created_at
   * 无法分出先后，而 id 是单调的，永远能分出。排序键与 listByChapter
   * 一致（created_at DESC, id DESC），两边对「哪几版是新的」判断相同。
   */
  prune(chapterId: number, keep: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM chapter_revisions
          WHERE chapter_id = @chapterId
            AND id NOT IN (
                  SELECT id FROM chapter_revisions
                   WHERE chapter_id = @chapterId
                   ORDER BY created_at DESC, id DESC
                   LIMIT @keep
                )`
      )
      .run({ chapterId, keep })

    return result.changes
  }

  /** 删掉某章的全部版本。章节本身被删时由外键 CASCADE 负责，这里是显式入口 */
  deleteByChapter(chapterId: number): number {
    return this.db.prepare(`DELETE FROM chapter_revisions WHERE chapter_id = @chapterId`).run({ chapterId })
      .changes
  }

  /** 版本总数，冒烟与备份体积估算用 */
  countAll(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM chapter_revisions`).get() as { n: number }).n
  }
}

/** 供 service 回执使用，避免在两个文件里各写一遍字段 */
export type { ChapterRestoreResult }
