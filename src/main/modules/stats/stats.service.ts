import type {
  BookProgressItem,
  BookProgressQuery,
  DailyWordsPoint,
  HeatmapCell,
  HeatmapResult,
  OverviewStats,
  StatsTrendQuery,
  TrendResult
} from '@shared/modules/stats'
import { levelOf } from '@shared/modules/stats'
import {
  addDays,
  computeStreak,
  eachDayKey,
  endOfLocalDay,
  localDateKey,
  startOfLocalDay
} from '@shared/datetime'
import type { BookRepository } from '../books/book.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'
import type { SessionRepository } from '../sessions/session.repository'

/**
 * 统计服务。
 *
 * 这个模块**没有自己的表**，也不直接写 SQL——所有数字都复用它已有的仓储。
 * 这样做的好处是统计口径不会出现第二份副本：一旦「今日字数怎么算」
 * 需要调整，只改 SessionRepository 一处即可，不会出现「首页和统计页对不上」。
 */

/** 连续写作天数最多回溯的天数，与会话仓储里的查询上限保持一致 */
const STREAK_LOOKBACK_DAYS = 400

export class StatsService {
  constructor(
    private readonly bookRepository: BookRepository,
    private readonly chapterRepository: ChapterRepository,
    private readonly sessionRepository: SessionRepository
  ) {}

  /* ------------------------------------------------------------------ *
   * 概览
   * ------------------------------------------------------------------ */

  overview(): OverviewStats {
    const now = new Date()
    const dayFrom = startOfLocalDay(now)
    const dayTo = endOfLocalDay(now)

    const bookStats = this.bookRepository.stats()
    const todayTotals = this.sessionRepository.totals(
      dayFrom.toISOString(),
      dayTo.toISOString(),
      null
    )

    // 累计时长覆盖全部历史，因此下界取「最早一条会话」。
    // 没有历史时退回今天，结果同样是 0，不需要额外分支
    const historyFrom = this.sessionRepository.earliestStartedAt()
    const totalDurationSeconds = this.sessionRepository.totals(
      historyFrom ?? dayFrom.toISOString(),
      dayTo.toISOString(),
      null
    ).durationSeconds

    const lookbackFrom = startOfLocalDay(addDays(now, -STREAK_LOOKBACK_DAYS)).toISOString()
    const activeDays = new Set(this.sessionRepository.activeDayKeys(lookbackFrom))

    return {
      bookCount: bookStats.total,
      activeBookCount: this.bookRepository.countByStatus('serializing'),
      volumeCount: bookStats.volumeCount,
      chapterCount: bookStats.chapterCount,
      totalHanzi: bookStats.hanziCount,
      totalChars: bookStats.charCount,
      totalDurationSeconds,

      todayWordsWritten: todayTotals.wordsWritten,
      todayWordsNet: todayTotals.wordsNet,
      todayDurationSeconds: todayTotals.durationSeconds,
      todayChapterCount: this.chapterRepository.countUpdatedBetween(
        dayFrom.toISOString(),
        dayTo.toISOString()
      ),

      streakDays: computeStreak(activeDays, now),
      lastEditedAt: this.chapterRepository.latestUpdateAt(),
      ongoingTargetWords: this.bookRepository.sumTargetWordsByStatus('serializing')
    }
  }

  /* ------------------------------------------------------------------ *
   * 字数与时长趋势
   * ------------------------------------------------------------------ */

  trend(query: StatsTrendQuery): TrendResult {
    const now = new Date()
    const to = endOfLocalDay(now)
    // 区间含今天，所以往前推 days - 1 天
    const from = startOfLocalDay(addDays(now, -(query.days - 1)))

    const rows = this.sessionRepository.dailyAggregate(
      from.toISOString(),
      to.toISOString(),
      query.bookId
    )
    const byDay = new Map(rows.map((row) => [row.day, row]))

    // 没有写作的日子也要占一格：SQL 的 GROUP BY 只返回有记录的天，
    // 直接拿去画图会出现日期跳空、曲线被压缩，看起来像「某天写了特别多」
    const days: DailyWordsPoint[] = eachDayKey(addDays(from, -1), to, query.days).map((date) => {
      const row = byDay.get(date)
      return {
        date,
        wordsWritten: row?.words_written ?? 0,
        wordsNet: row?.words_net ?? 0,
        durationSeconds: row?.duration ?? 0,
        sessionCount: row?.session_count ?? 0
      }
    })

    const totalWordsWritten = days.reduce((sum, day) => sum + day.wordsWritten, 0)
    const totalWordsNet = days.reduce((sum, day) => sum + day.wordsNet, 0)
    const totalDurationSeconds = days.reduce((sum, day) => sum + day.durationSeconds, 0)
    const activeDays = days.filter((day) => day.sessionCount > 0).length

    return {
      from: localDateKey(from),
      to: localDateKey(to),
      days,
      totalWordsWritten,
      totalWordsNet,
      totalDurationSeconds,
      activeDays,
      // 按「有写作的天数」求平均，而不是除以区间总天数：
      // 后者会把休息日也算作低产日，得出一个持续下降的假趋势
      averageWordsPerActiveDay: activeDays === 0 ? 0 : Math.round(totalWordsWritten / activeDays)
    }
  }

  /* ------------------------------------------------------------------ *
   * 分书籍进度
   * ------------------------------------------------------------------ */

  books(query: BookProgressQuery): BookProgressItem[] {
    // 复用书籍列表查询拿聚合字段，而不是另写一套 JOIN —— 保证首页的
    // 「总字数」和书架页显示的数字来自同一条 SQL
    const books = this.bookRepository.list({
      keyword: '',
      status: null,
      page: 1,
      pageSize: query.limit,
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    })

    const ids = books.items.map((book) => book.id)
    const latestChapters = this.chapterRepository.latestByBooks(ids)

    const rangeAggregates = new Map<number, { wordsWritten: number; durationSeconds: number }>()
    if (query.rangeDays !== null) {
      const now = new Date()
      const from = startOfLocalDay(addDays(now, -(query.rangeDays - 1)))
      const to = endOfLocalDay(now)
      for (const row of this.sessionRepository.aggregateByBook(from.toISOString(), to.toISOString())) {
        rangeAggregates.set(row.bookId, {
          wordsWritten: row.wordsWritten,
          durationSeconds: row.durationSeconds
        })
      }
    }

    return books.items.map((book) => {
      const latest = latestChapters.get(book.id)
      const range = rangeAggregates.get(book.id)
      return {
        bookId: book.id,
        title: book.title,
        accentColor: book.accentColor,
        status: book.status,
        hanziCount: book.hanziCount,
        targetWords: book.targetWords,
        chapterCount: book.chapterCount,
        lastEditedAt: book.lastEditedAt,
        lastChapterId: latest?.id ?? null,
        lastChapterTitle: latest?.title ?? null,
        rangeWordsWritten: range?.wordsWritten ?? 0,
        rangeDurationSeconds: range?.durationSeconds ?? 0
      }
    })
  }

  /* ------------------------------------------------------------------ *
   * 写作热力日历
   * ------------------------------------------------------------------ */

  heatmap(days: number, bookId: number | null): HeatmapResult {
    const now = new Date()
    const to = endOfLocalDay(now)
    const from = startOfLocalDay(addDays(now, -(days - 1)))

    const rows = this.sessionRepository.dailyAggregate(
      from.toISOString(),
      to.toISOString(),
      bookId
    )
    const byDay = new Map(rows.map((row) => [row.day, row]))

    const raw = eachDayKey(addDays(from, -1), to, days).map((date) => ({
      date,
      wordsWritten: byDay.get(date)?.words_written ?? 0
    }))

    const maxWords = raw.reduce((max, cell) => Math.max(max, cell.wordsWritten), 0)

    const cells: HeatmapCell[] = raw.map((cell) => ({
      ...cell,
      // 等级在服务端算好：前端各处自己定阈值的话，趋势图和热力图
      // 对「同样的字数」会给出不同的颜色，用户会以为其中一个坏了
      level: levelOf(cell.wordsWritten, maxWords)
    }))

    return {
      from: localDateKey(from),
      to: localDateKey(to),
      cells,
      maxWords,
      totalWordsWritten: cells.reduce((sum, cell) => sum + cell.wordsWritten, 0),
      activeDays: cells.filter((cell) => cell.wordsWritten > 0).length
    }
  }
}
