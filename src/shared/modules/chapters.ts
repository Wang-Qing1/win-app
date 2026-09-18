import { z } from 'zod'

/**
 * 章节模块的领域契约。这是整个应用的核心实体。
 *
 * 一条重要的接口约定：**列表接口不返回正文**。
 * 一本书的正文可能有几十上百万字，若列表顺手把它一起拉过 IPC，
 * 书店页面每翻一页都要序列化几 MB 的字符串。因此分成两个类型：
 *   ChapterListItem —— 列表用，只有元数据与字数
 *   Chapter        —— 详情用，带正文
 */

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

export const CHAPTER_STATUSES = ['draft', 'revising', 'done'] as const
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number]

export const CHAPTER_STATUS_LABELS: Record<ChapterStatus, string> = {
  draft: '草稿',
  revising: '修订中',
  done: '已完成'
}

export function isChapterStatus(value: unknown): value is ChapterStatus {
  return typeof value === 'string' && (CHAPTER_STATUSES as readonly string[]).includes(value)
}

const chapterStatusSchema = z.string().refine(isChapterStatus, '章节状态不合法')

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

/** 章节元数据。列表接口返回的就是它，不含正文 */
export interface ChapterListItem {
  id: number
  bookId: number
  /** null 表示未归入任何分卷 */
  volumeId: number | null
  title: string
  status: ChapterStatus
  orderIndex: number
  /** 汉字数（主口径） */
  hanziCount: number
  /** 非空白字符数（含标点），用于与网文平台对照 */
  charCount: number
  /** 本章目标字数，0 表示未设目标。编辑器底部「计划：剩 N」用它 */
  targetWords: number
  createdAt: string
  updatedAt: string
}

/** 章节详情，带正文 */
export interface Chapter extends ChapterListItem {
  contentHtml: string
  contentText: string
}

/** 保存正文后的回执：把服务端重新算出的权威字数带回给编辑器 */
export interface ChapterSaveResult {
  id: number
  hanziCount: number
  charCount: number
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * 字段定义
 * ------------------------------------------------------------------ */

export const CHAPTER_LIMITS = {
  title: 120,
  /**
   * 正文上限按 HTML 长度算。3,000,000 个字符的 HTML 大约相当于
   * 一百五十万汉字——已经超过任何单章的实际可能。这个值只是防止
   * 异常输入（比如误粘贴一个二进制文件）撑爆数据库，不是业务约束。
   */
  contentHtml: 3_000_000,
  /** 单本书章节数上限，同样是防误操作的护栏 */
  perBook: 20_000,
  /** 一次重排允许提交的条目数 */
  reorderBatch: 20_000,
  /** 单章目标字数上限。网文单章通常 2000–4000 字，这里给足余量 */
  targetWords: 1_000_000
} as const

const chapterFields = {
  title: z
    .string()
    .trim()
    .min(1, '章节标题不能为空')
    .max(CHAPTER_LIMITS.title, `章节标题最多 ${CHAPTER_LIMITS.title} 个字符`),
  contentHtml: z.string().max(CHAPTER_LIMITS.contentHtml, '正文长度超出上限'),
  targetWords: z
    .number()
    .int('目标字数必须是整数')
    .min(0, '目标字数不能为负')
    .max(CHAPTER_LIMITS.targetWords, '目标字数超出合理范围')
}

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

export const chapterCreateSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  volumeId: z.number().int().positive().nullable().default(null),
  title: chapterFields.title,
  targetWords: chapterFields.targetWords.default(0)
})

export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>

/**
 * 元数据更新：标题、状态、所属分卷、本章目标字数。
 *
 * 刻意不包含正文。正文走独立的 saveContent 通道，因为两者的写入时机
 * 完全不同——元数据是用户显式点击保存，正文是编辑器自动防抖保存。
 * 混在一个接口里会让「自动保存把用户没提交的标题改动覆盖掉」这类
 * 竞态变得难以避免。
 */
export const chapterUpdateSchema = z.object({
  id: z.number().int().positive('章节 ID 非法'),
  title: chapterFields.title,
  status: chapterStatusSchema,
  volumeId: z.number().int().positive().nullable(),
  targetWords: chapterFields.targetWords
})

export type ChapterUpdateInput = z.infer<typeof chapterUpdateSchema>

export const chapterSaveContentSchema = z.object({
  id: z.number().int().positive('章节 ID 非法'),
  contentHtml: chapterFields.contentHtml
})

export type ChapterSaveContentInput = z.infer<typeof chapterSaveContentSchema>

export const chapterIdSchema = z.object({
  id: z.number().int().positive('章节 ID 非法')
})

export type ChapterIdInput = z.infer<typeof chapterIdSchema>

export const chapterListQuerySchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  /**
   * 三态：
   *   不传   → 整本书的所有章节
   *   null   → 只列未归入分卷的章节
   *   数字   → 指定分卷下的章节
   */
  volumeId: z.union([z.number().int().positive(), z.null()]).optional()
})

export type ChapterListQueryInput = z.infer<typeof chapterListQuerySchema>

/** 归一化后的查询条件，主进程内部使用 */
export interface ChapterListQuery {
  bookId: number
  volumeId: number | null | undefined
}

export function normalizeChapterListQuery(input: ChapterListQueryInput): ChapterListQuery {
  return { bookId: input.bookId, volumeId: input.volumeId }
}

export const chapterReorderSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  /** 与 list 的 volumeId 同义：null 表示未分卷区间 */
  volumeId: z.number().int().positive().nullable(),
  orderedIds: z.array(z.number().int().positive()).max(CHAPTER_LIMITS.reorderBatch, '章节数量超出上限')
})

export type ChapterReorderInput = z.infer<typeof chapterReorderSchema>

/** 把章节移动到另一个分卷（并落到指定位置） */
export const chapterMoveSchema = z.object({
  id: z.number().int().positive('章节 ID 非法'),
  /** 目标分卷，null 表示移出分卷 */
  volumeId: z.number().int().positive().nullable(),
  /** 目标位置，超出范围时会被夹到合法区间 */
  targetIndex: z.number().int().min(0)
})

export type ChapterMoveInput = z.infer<typeof chapterMoveSchema>
