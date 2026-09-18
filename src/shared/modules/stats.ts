import { z } from 'zod'
import type { BookStatus } from './books'

/**
 * 统计模块的领域契约。
 *
 * 这个模块**只有读，没有自己的表**。所有数字都从 books / chapters /
 * writing_sessions 聚合而来，口径的唯一来源也就不会出现第二份副本。
 *
 * 两个字数口径贯穿全局，务必分清（见 sessions.ts 的说明）：
 *   wordsWritten 写作量 —— 只算写进去的正向增量，用于「今天写了多少」
 *   wordsNet     净增   —— 真实的字数变化，可能为负，用于进度
 */

/* ------------------------------------------------------------------ *
 * 时间范围
 * ------------------------------------------------------------------ */

export const STATS_RANGES = [7, 30, 90, 365] as const
export type StatsRange = (typeof STATS_RANGES)[number]

export const STATS_RANGE_LABELS: Record<StatsRange, string> = {
  7: '近 7 天',
  30: '近 30 天',
  90: '近 90 天',
  365: '近一年'
}

export function isStatsRange(value: unknown): value is StatsRange {
  return typeof value === 'number' && (STATS_RANGES as readonly number[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 概览（首页顶部与统计页头部共用）
 * ------------------------------------------------------------------ */

export interface OverviewStats {
  bookCount: number
  /** 状态为「连载中」的书籍数 */
  activeBookCount: number
  volumeCount: number
  chapterCount: number
  /** 全书汉字数（各章 hanzi_count 之和） */
  totalHanzi: number
  /** 全书非空白字符数（含标点），用于与网文平台显示的字数对照 */
  totalChars: number
  totalDurationSeconds: number

  /** 今日写作量：只算写进去的增量，不受删改影响 */
  todayWordsWritten: number
  /** 今日净增：可能为负 */
  todayWordsNet: number
  todayDurationSeconds: number
  /** 今天有过编辑的章节数 */
  todayChapterCount: number

  /** 连续写作天数（今天没写但昨天写了，仍算连续） */
  streakDays: number
  /** 全书最近一次编辑时间，用于首页「最后编辑」提示 */
  lastEditedAt: string | null
  /** 今日已写汉字占目标的比例所需的分母：各连载中书的目标字数之和 */
  ongoingTargetWords: number
}

/* ------------------------------------------------------------------ *
 * 趋势
 * ------------------------------------------------------------------ */

export interface DailyWordsPoint {
  /** 本地日期 YYYY-MM-DD */
  date: string
  wordsWritten: number
  wordsNet: number
  durationSeconds: number
  /** 当天有写作记录的会话条数，用于判断「有没有写过」 */
  sessionCount: number
}

export interface TrendResult {
  from: string
  to: string
  days: DailyWordsPoint[]
  totalWordsWritten: number
  totalWordsNet: number
  totalDurationSeconds: number
  /** 区间内有写作记录的天数 */
  activeDays: number
  /** 区间内平均每天写作量（按有记录的天数算，不含空白日） */
  averageWordsPerActiveDay: number
}

export const statsTrendQuerySchema = z.object({
  days: z.number().int().min(7, '统计区间过短').max(365, '统计区间过长').default(30),
  /** 只看某本书，null 表示全部 */
  bookId: z.number().int().positive().nullable().default(null)
})

export type StatsTrendQueryInput = z.infer<typeof statsTrendQuerySchema>

export interface StatsTrendQuery {
  days: number
  bookId: number | null
}

export function normalizeStatsTrendQuery(input: StatsTrendQueryInput): StatsTrendQuery {
  return { days: input.days, bookId: input.bookId }
}

/* ------------------------------------------------------------------ *
 * 分书籍进度（首页「在写书籍」与统计页对比）
 * ------------------------------------------------------------------ */

export interface BookProgressItem {
  bookId: number
  title: string
  accentColor: string
  status: BookStatus
  hanziCount: number
  targetWords: number
  chapterCount: number
  lastEditedAt: string | null
  /**
   * 最近编辑的那一章，供首页「继续写作」直接跳回上次停笔的地方。
   * 没有它的话，用户每次打开应用都要自己在章节列表里找位置。
   */
  lastChapterId: number | null
  lastChapterTitle: string | null
  /** 区间内这本书贡献的写作量，用于统计页的分书对比 */
  rangeWordsWritten: number
  rangeDurationSeconds: number
}

export const bookProgressQuerySchema = z.object({
  /** 只返回最近编辑过的前 N 本 */
  limit: z.number().int().min(1).max(50).default(5),
  /** 传入后，每本书额外带上该区间内的写作量 */
  rangeDays: z.number().int().min(7).max(365).nullable().default(null)
})

export type BookProgressQueryInput = z.infer<typeof bookProgressQuerySchema>

export interface BookProgressQuery {
  limit: number
  rangeDays: number | null
}

export function normalizeBookProgressQuery(input: BookProgressQueryInput): BookProgressQuery {
  return { limit: input.limit, rangeDays: input.rangeDays }
}

/* ------------------------------------------------------------------ *
 * 写作热力日历
 * ------------------------------------------------------------------ */

export interface HeatmapCell {
  /** 本地日期 YYYY-MM-DD */
  date: string
  wordsWritten: number
  /**
   * 强度等级 0–4。0 表示当天没有写作。
   * 分级在服务端算好，避免前端各处自己定义阈值导致颜色含义不一致。
   */
  level: number
}

export interface HeatmapResult {
  from: string
  to: string
  cells: HeatmapCell[]
  maxWords: number
  totalWordsWritten: number
  activeDays: number
}

export const statsHeatmapQuerySchema = z.object({
  days: z.number().int().min(30, '热力图区间至少 30 天').max(365, '热力图区间最长一年').default(365),
  bookId: z.number().int().positive().nullable().default(null)
})

export type StatsHeatmapQueryInput = z.infer<typeof statsHeatmapQuerySchema>

/* ------------------------------------------------------------------ *
 * 强度分级
 * ------------------------------------------------------------------ */

/** 热力图与趋势柱共用的等级阈值。集中在这里，保证两处颜色含义一致 */
export function levelOf(words: number, maxWords: number): number {
  if (words <= 0) return 0
  if (maxWords <= 0) return 1
  const ratio = words / maxWords
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}
