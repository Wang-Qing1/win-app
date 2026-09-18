import type { SessionFinishInput, SessionListQuery, WritingSession } from '@shared/modules/sessions'
import type { Db } from '../../db/types'
import { toNumber } from '../../db/sql-utils'

interface SessionRow {
  id: number
  book_id: number | null
  chapter_id: number | null
  started_at: string
  ended_at: string
  duration_seconds: number
  start_words: number
  end_words: number
  peak_words: number
}

export interface DailyAggregateRow {
  day: string
  words_written: number
  words_net: number
  duration: number
  session_count: number
}

export interface SessionTotals {
  wordsWritten: number
  wordsNet: number
  durationSeconds: number
  sessionCount: number
}

/**
 * 把「写作量 / 净增」两个派生口径集中在一处换算。
 *
 * 两个口径的差别（见 shared/modules/sessions.ts）很容易在调用点被搞混，
 * 所以只在这里定义一次，其他任何地方都不许自己写 `peak - start`。
 */
function toSession(row: SessionRow): WritingSession {
  return {
    id: row.id,
    bookId: row.book_id,
    chapterId: row.chapter_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: toNumber(row.duration_seconds),
    startWords: toNumber(row.start_words),
    endWords: toNumber(row.end_words),
    peakWords: toNumber(row.peak_words),
    wordsWritten: Math.max(0, toNumber(row.peak_words) - toNumber(row.start_words)),
    wordsNet: toNumber(row.end_words) - toNumber(row.start_words)
  }
}

interface RangeFilter {
  from?: string
  to?: string
  bookId?: number | null
}

/** 拼出时间区间与书籍过滤条件。所有聚合查询共用，保证口径一致 */
function buildFilter(filter: RangeFilter): { sql: string; params: Record<string, unknown> } {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  if (filter.from !== undefined) {
    conditions.push('started_at >= @from')
    params.from = filter.from
  }
  if (filter.to !== undefined) {
    conditions.push('started_at <= @to')
    params.to = filter.to
  }
  if (filter.bookId !== undefined && filter.bookId !== null) {
    conditions.push('book_id = @bookId')
    params.bookId = filter.bookId
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

/**
 * 仓储层：只负责 SQL 与行↔领域对象映射。
 *
 * 这里是统计功能唯一的数据来源。所有跨表聚合（统计模块）最终都落到这张表上，
 * 因此时间范围与书籍过滤的逻辑集中在本文件，避免各统计入口各写一份 WHERE。
 */
export class SessionRepository {
  constructor(private readonly db: Db) {}

  insert(input: SessionFinishInput): WritingSession {
    const result = this.db
      .prepare(
        `INSERT INTO writing_sessions
           (book_id, chapter_id, started_at, ended_at, duration_seconds, start_words, end_words, peak_words)
         VALUES
           (@bookId, @chapterId, @startedAt, @endedAt, @durationSeconds, @startWords, @endWords, @peakWords)`
      )
      .run({
        bookId: input.bookId,
        chapterId: input.chapterId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds: input.durationSeconds,
        startWords: input.startWords,
        endWords: input.endWords,
        peakWords: input.peakWords
      })

    const row = this.db
      .prepare('SELECT * FROM writing_sessions WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as SessionRow | undefined

    if (!row) {
      throw new Error('写入写作会话后无法回读记录')
    }
    return toSession(row)
  }

  list(query: SessionListQuery): WritingSession[] {
    const filter = buildFilter({ from: query.from, to: query.to, bookId: query.bookId })
    const rows = this.db
      .prepare(
        `SELECT * FROM writing_sessions
         ${filter.sql}
         ORDER BY started_at DESC
         LIMIT @limit`
      )
      .all({ ...filter.params, limit: query.limit }) as SessionRow[]

    return rows.map(toSession)
  }

  /**
   * 按本地日期聚合。
   *
   * 用 SQLite 的 `localtime` 修饰符而不是在 JS 里分组：会话条数会随使用
   * 时间线性增长，把几万条记录拉过内存只为了按天求和是不必要的。
   * 注意这个口径必须与 shared/datetime.ts 的 localDateKey 一致，
   * 否则「今日」在 SQL 与 JS 里会指到不同的日子。
   */
  dailyAggregate(from: string, to: string, bookId: number | null): DailyAggregateRow[] {
    const filter = buildFilter({ from, to, bookId })

    return this.db
      .prepare(
        `SELECT date(started_at, 'localtime')                        AS day,
                COALESCE(SUM(max(peak_words - start_words, 0)), 0)   AS words_written,
                COALESCE(SUM(end_words - start_words), 0)            AS words_net,
                COALESCE(SUM(duration_seconds), 0)                   AS duration,
                COUNT(*)                                             AS session_count
           FROM writing_sessions
           ${filter.sql}
          GROUP BY day
          ORDER BY day ASC`
      )
      .all(filter.params) as DailyAggregateRow[]
  }

  totals(from: string, to: string, bookId: number | null): SessionTotals {
    const filter = buildFilter({ from, to, bookId })

    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(max(peak_words - start_words, 0)), 0) AS words_written,
                COALESCE(SUM(end_words - start_words), 0)          AS words_net,
                COALESCE(SUM(duration_seconds), 0)                 AS duration,
                COUNT(*)                                           AS session_count
           FROM writing_sessions
           ${filter.sql}`
      )
      .get(filter.params) as {
      words_written: number
      words_net: number
      duration: number
      session_count: number
    }

    return {
      wordsWritten: toNumber(row.words_written),
      wordsNet: toNumber(row.words_net),
      durationSeconds: toNumber(row.duration),
      sessionCount: toNumber(row.session_count)
    }
  }

  /**
   * 有写作记录的本地日期集合，从新到旧。
   *
   * 只取最近 400 天：连续写作天数不可能超过这个量级的有意义范围，
   * 而全量 DISTINCT 在用了几年之后会变成一次全表扫描。
   */
  activeDayKeys(fromIso: string, limit = 400): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT date(started_at, 'localtime') AS day
           FROM writing_sessions
          WHERE started_at >= ?
          ORDER BY day DESC
          LIMIT ?`
      )
      .all(fromIso, limit) as Array<{ day: string }>

    return rows.map((row) => row.day)
  }

  /** 某天之后每本书各自的写作量与时长，供统计页的分书对比 */
  aggregateByBook(from: string, to: string): Array<{
    bookId: number
    wordsWritten: number
    durationSeconds: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT book_id,
                COALESCE(SUM(max(peak_words - start_words, 0)), 0) AS words_written,
                COALESCE(SUM(duration_seconds), 0)                 AS duration
           FROM writing_sessions
          WHERE started_at >= @from AND started_at <= @to AND book_id IS NOT NULL
          GROUP BY book_id`
      )
      .all({ from, to }) as Array<{ book_id: number; words_written: number; duration: number }>

    return rows.map((row) => ({
      bookId: row.book_id,
      wordsWritten: toNumber(row.words_written),
      durationSeconds: toNumber(row.duration)
    }))
  }

  /** 最早一条会话的时间，用于把「近一年」的起点夹到真实数据的范围内 */
  earliestStartedAt(): string | null {
    const row = this.db
      .prepare('SELECT MIN(started_at) AS earliest FROM writing_sessions')
      .get() as { earliest: string | null }
    return row.earliest ?? null
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM writing_sessions').get() as { n: number }
    return toNumber(row.n)
  }
}
