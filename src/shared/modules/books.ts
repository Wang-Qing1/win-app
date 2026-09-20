import { z } from 'zod'

/**
 * 书籍模块的领域契约。
 *
 * 与联系人模块同样的约定：这里是主进程与渲染进程唯一的字段定义来源，
 * 主进程用它做 IPC 边界校验，渲染进程用同一份 schema 做表单校验。
 */

/* ------------------------------------------------------------------ *
 * 枚举
 *
 * 用 z.string().refine() 而不是 z.enum()：一是自定义中文错误信息，
 * 二是避开 Zod 各版本在「枚举 + 自定义 message」上的写法差异。
 * ------------------------------------------------------------------ */

export const BOOK_STATUSES = ['idea', 'serializing', 'paused', 'completed'] as const
export type BookStatus = (typeof BOOK_STATUSES)[number]

export const BOOK_STATUS_LABELS: Record<BookStatus, string> = {
  idea: '构思中',
  serializing: '连载中',
  paused: '已暂停',
  completed: '已完结'
}

export function isBookStatus(value: unknown): value is BookStatus {
  return typeof value === 'string' && (BOOK_STATUSES as readonly string[]).includes(value)
}

const bookStatusSchema = z.string().refine(isBookStatus, '书本状态不合法')

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

/** 书籍本体，字段与 books 表一一对应 */
export interface Book {
  id: number
  title: string
  penName: string
  genre: string
  status: BookStatus
  summary: string
  /** 目标字数，0 表示不设目标。这是整本书的量级 */
  targetWords: number
  /**
   * 每章最少字数，对全书每个章节都生效。
   *
   * 与 `targetWords` 是两把不同的尺子：整本目标动辄几十上百万，作者在写单章
   * 时用不上；而「每章至少 2000 字」是一条**全书统一的规则**，不该让作者
   * 逐章再填一遍（那正是编辑器里那一行冗余输入被砍掉的原因）。
   * 编辑器底栏的「计划：剩 N」按它计算。
   */
  chapterWords: number
  /** 卡片强调色，让书架有辨识度而不必真的存封面图 */
  accentColor: string
  createdAt: string
  updatedAt: string
}

/**
 * 列表项 = 书籍本体 + 聚合出来的进度信息。
 *
 * 刻意带上统计而不是让前端逐本再查一次：书架页面一屏可能有几十本，
 * 逐本查询就是标准的 N+1。这里由一条带 GROUP BY 的 SQL 一次算出来。
 */
export interface BookListItem extends Book {
  volumeCount: number
  chapterCount: number
  /** 全书汉字数（各章 hanzi_count 之和） */
  hanziCount: number
  lastEditedAt: string | null
}

export interface BookListResult {
  items: BookListItem[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

/**
 * 删除书籍的回执。
 *
 * 带上 title 与 removedChapters 是为了让提示能说清「你删掉了什么」——
 * 「已删除书籍」和「已删除《星海归途》及其 128 章」对用户的含义完全不同，
 * 后者才让人确信操作范围符合预期。
 */
export interface BookRemovalResult {
  id: number
  title: string
  removedChapters: number
}

/** 书籍级统计，用于书本详情页头部与首页概览 */
export interface BookStats {
  total: number
  byStatus: Record<BookStatus, number>
  chapterCount: number
  volumeCount: number
  hanziCount: number
  charCount: number
  totalTargetWords: number
}

/* ------------------------------------------------------------------ *
 * 排序：白名单在服务端，客户端值先归一化再映射为列名，绝不拼进 SQL
 * ------------------------------------------------------------------ */

export const BOOK_SORT_FIELDS = ['title', 'createdAt', 'updatedAt', 'hanziCount'] as const
export type BookSortField = (typeof BOOK_SORT_FIELDS)[number]

export const BOOK_SORT_ORDERS = ['asc', 'desc'] as const
export type BookSortOrder = (typeof BOOK_SORT_ORDERS)[number]

export function isBookSortField(value: unknown): value is BookSortField {
  return typeof value === 'string' && (BOOK_SORT_FIELDS as readonly string[]).includes(value)
}

export function isBookSortOrder(value: unknown): value is BookSortOrder {
  return typeof value === 'string' && (BOOK_SORT_ORDERS as readonly string[]).includes(value)
}

export function normalizeBookSortField(value: unknown): BookSortField {
  return isBookSortField(value) ? value : 'updatedAt'
}

export function normalizeBookSortOrder(value: unknown): BookSortOrder {
  return isBookSortOrder(value) ? value : 'desc'
}

/* ------------------------------------------------------------------ *
 * 字段定义
 * ------------------------------------------------------------------ */

export const BOOK_LIMITS = {
  title: 80,
  penName: 40,
  genre: 24,
  summary: 2000,
  targetWords: 100_000_000,
  chapterWords: 1_000_000
} as const

/** #RGB 或 #RRGGBB，只接受十六进制，避免把任意字符串写进样式 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const bookFields = {
  title: z
    .string()
    .trim()
    .min(1, '书名不能为空')
    .max(BOOK_LIMITS.title, `书名最多 ${BOOK_LIMITS.title} 个字符`),

  penName: z.string().trim().max(BOOK_LIMITS.penName, `笔名最多 ${BOOK_LIMITS.penName} 个字符`),

  genre: z.string().trim().max(BOOK_LIMITS.genre, `题材最多 ${BOOK_LIMITS.genre} 个字符`),

  status: bookStatusSchema,

  summary: z.string().trim().max(BOOK_LIMITS.summary, `简介最多 ${BOOK_LIMITS.summary} 个字符`),

  targetWords: z
    .number()
    .int('目标字数必须是整数')
    .min(0, '目标字数不能为负')
    .max(BOOK_LIMITS.targetWords, '目标字数超出合理范围'),

  chapterWords: z
    .number()
    .int('每章最少字数必须是整数')
    .min(0, '每章最少字数不能为负')
    .max(BOOK_LIMITS.chapterWords, '每章最少字数超出合理范围'),

  accentColor: z.string().trim().regex(HEX_COLOR_PATTERN, '强调色必须是 #RGB 或 #RRGGBB 格式')
}

/**
 * 每章最少字数的默认值。
 *
 * 取 2000 而不是 0：网文单章的常见区间是 2000–4000 字，这是作者提起笔
 * 就已经在心里定好的量。默认 0 意味着新建完每本书都要先去改一次设置，
 * 那和「规则只在建书时定一次」的初衷相反。
 */
export const DEFAULT_CHAPTER_WORDS = 2000

export const bookCreateSchema = z.object({
  title: bookFields.title,
  penName: bookFields.penName.default(''),
  genre: bookFields.genre.default(''),
  status: bookFields.status.default('idea'),
  summary: bookFields.summary.default(''),
  targetWords: bookFields.targetWords.default(0),
  chapterWords: bookFields.chapterWords.default(DEFAULT_CHAPTER_WORDS),
  accentColor: bookFields.accentColor.default('#0f6cbd')
})

export type BookCreateInput = z.infer<typeof bookCreateSchema>

/** 更新是整体替换：表单本来就是整体提交的，避免出现「部分字段 undefined 该不该覆盖」的歧义 */
export const bookUpdateSchema = z.object({
  id: z.number().int().positive('书籍 ID 非法'),
  title: bookFields.title,
  penName: bookFields.penName,
  genre: bookFields.genre,
  status: bookFields.status,
  summary: bookFields.summary,
  targetWords: bookFields.targetWords,
  chapterWords: bookFields.chapterWords,
  accentColor: bookFields.accentColor
})

export type BookUpdateInput = z.infer<typeof bookUpdateSchema>

export const bookIdSchema = z.object({
  id: z.number().int().positive('书籍 ID 非法')
})

export type BookIdInput = z.infer<typeof bookIdSchema>

export const bookListQuerySchema = z.object({
  keyword: z.string().trim().max(BOOK_LIMITS.title, '搜索关键词过长').default(''),
  /**
   * 状态筛选。空串与 null 都表示「不筛选」。
   *
   * 之所以两种都收：渲染端的规范类型 BookListQuery 用 null 表达这个语义，
   * 而 IPC 传的是它的原样序列化结果 —— 只写 z.string() 的话，书架页在
   * 默认（未选状态）情况下每次查询都会被边界校验拒掉。传 undefined 时
   * 的 default('') 更拦不住 null，default 只对 undefined 生效。
   */
  status: z.union([z.string().trim(), z.null()]).default(''),
  page: z.number().int().min(1, '页码非法').default(1),
  pageSize: z.number().int().min(1, '每页条数非法').max(200, '每页最多 200 条').default(60),
  sortBy: z.string().default('updatedAt'),
  sortOrder: z.string().default('desc')
})

export type BookListQueryInput = z.infer<typeof bookListQuerySchema>

export interface BookListQuery {
  keyword: string
  /** null 表示不过滤 */
  status: BookStatus | null
  page: number
  pageSize: number
  sortBy: BookSortField
  sortOrder: BookSortOrder
}

export function normalizeBookListQuery(input: BookListQueryInput): BookListQuery {
  return {
    keyword: input.keyword,
    // 非法状态值静默降级为「不筛选」而不是报错：URL 里带过来的旧值
    // 不该让整个书架页面打不开
    status: isBookStatus(input.status) ? input.status : null,
    page: input.page,
    pageSize: input.pageSize,
    sortBy: normalizeBookSortField(input.sortBy),
    sortOrder: normalizeBookSortOrder(input.sortOrder)
  }
}

export const DEFAULT_BOOK_QUERY: BookListQuery = {
  keyword: '',
  status: null,
  page: 1,
  pageSize: 60,
  sortBy: 'updatedAt',
  sortOrder: 'desc'
}

/** 新建书籍时可选的强调色，取自 Fluent 调色板，保证深浅主题下都够清晰 */
export const BOOK_ACCENT_PRESETS = [
  '#0f6cbd',
  '#0f7b0f',
  '#c76a00',
  '#8e562e',
  '#7f3f98',
  '#c42b1c',
  '#00707f',
  '#4a5568'
] as const
