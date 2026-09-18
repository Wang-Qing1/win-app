import { z } from 'zod'

/**
 * 写作会话模块的领域契约。
 *
 * 这是统计功能的唯一事实源。每次「进入编辑器 → 离开或空闲 90 秒」结算一条记录。
 * 为什么要单独记而不是直接从章节目录的字数推：章节目录只是当前快照，
 * 删掉一章就会让历史写作量凭空消失，而「我昨天写了 2000 字」是既成事实。
 */

export interface WritingSession {
  id: number
  bookId: number | null
  chapterId: number | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  startWords: number
  endWords: number
  peakWords: number

  /* 以下两个字段由三个原始字数派生，不在数据库里存 */
  /** 写作量 = 最高字数 − 起始字数。首页「今日写了多少」用它 */
  wordsWritten: number
  /** 净增 = 结束字数 − 起始字数。书籍进度用它，可能为负（校对删字） */
  wordsNet: number
}

const ISO_DATETIME = z.string().refine((value) => {
  const time = new Date(value).getTime()
  return !Number.isNaN(time)
}, '时间格式不正确')

export const SESSION_LIMITS = {
  /** 单次会话时长上限（7 天）。仅防止异常数据，正常会话由空闲检测在 90 秒内结束 */
  durationSeconds: 7 * 24 * 60 * 60,
  /** 单次会话的字数变化上限，防止异常输入写坏统计 */
  words: 10_000_000
} as const

const wordCountField = z
  .number()
  .int('字数必须是整数')
  .min(0, '字数不能为负')
  .max(SESSION_LIMITS.words, '字数超出合理范围')

/**
 * 结算一次写作会话。
 *
 * peak >= start 由 schema 强制：peak 的含义是「会话过程中出现过的最高字数」，
 * 它的初始值就是 start。若客户端算出 peak < start，说明它的采样逻辑有问题，
 * 这种数据写进统计表会污染所有派生指标，所以宁可在这里拒绝。
 */
export const sessionFinishSchema = z
  .object({
    bookId: z.number().int().positive().nullable(),
    chapterId: z.number().int().positive().nullable(),
    startedAt: ISO_DATETIME,
    endedAt: ISO_DATETIME,
    durationSeconds: z
      .number()
      .int('时长必须是整数秒')
      .min(0, '时长不能为负')
      .max(SESSION_LIMITS.durationSeconds, '单次会话时长超出合理范围'),
    startWords: wordCountField,
    endWords: wordCountField,
    peakWords: wordCountField
  })
  .refine((value) => value.peakWords >= value.startWords, {
    message: '最高字数不能小于起始字数',
    path: ['peakWords']
  })
  .refine((value) => new Date(value.endedAt).getTime() >= new Date(value.startedAt).getTime(), {
    message: '结束时间不能早于开始时间',
    path: ['endedAt']
  })

export type SessionFinishInput = z.infer<typeof sessionFinishSchema>

export const sessionListQuerySchema = z.object({
  /** 起始时间下界（含），不传表示不限 */
  from: ISO_DATETIME.optional(),
  /** 结束时间上界（含），不传表示不限 */
  to: ISO_DATETIME.optional(),
  bookId: z.number().int().positive().nullable().default(null),
  limit: z.number().int().min(1).max(500).default(100)
})

export type SessionListQueryInput = z.infer<typeof sessionListQuerySchema>

/** 归一化后的查询条件，主进程内部使用 */
export interface SessionListQuery {
  from: string | undefined
  to: string | undefined
  bookId: number | null
  limit: number
}

export function normalizeSessionListQuery(input: SessionListQueryInput): SessionListQuery {
  return { from: input.from, to: input.to, bookId: input.bookId, limit: input.limit }
}

/**
 * 会话按「开始时间所在的本地日期」归属到某一天。
 *
 * 跨午夜的会话（23:50 开始、00:20 结束）整段算作前一天。这是刻意的简化：
 * 按分钟切分到两天会让「今日写了多少」在半夜出现难以解释的跳变，
 * 而作者对「这天写了多久」的直觉本来就是按开始时刻算的。
 */
export const DEFAULT_SESSION_LIST_QUERY = {
  bookId: null,
  limit: 100
} as const
