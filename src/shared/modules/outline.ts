import { z } from 'zod'
import { CHAPTER_LIMITS, type ChapterStatus } from './chapters'

/**
 * 大纲模块的领域契约。
 *
 * 结构是**自由多层情节树**：节点可以任意嵌套（主线 → 支线 → 事件 → …），
 * 与「卷 / 章」的物理结构彼此独立 —— 大纲是**写作前的构思**，
 * 卷章是**成稿的容器**，两者不是一回事：一条支线可能横跨三章，
 * 一个卷里也可能同时跑着主线和两条支线。
 *
 * 两种结构靠一个可选的关联打通：节点可以「落地」成真实章节
 * （`chapterId` 指向它），落地的节点在树上会显示章节标题，
 * 点一下就能跳进编辑器。
 */

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

/**
 * 节点在情节里承担的角色。
 *
 * 数据库列的默认值是 'plot'，但**所有写入都会显式带上 nodeType**，
 * 因此那个默认值只是手工插数据时的兜底，不会出现在正常流程里。
 */
export const OUTLINE_NODE_TYPES = ['main', 'sub', 'event', 'foreshadow', 'twist', 'note'] as const
export type OutlineNodeType = (typeof OUTLINE_NODE_TYPES)[number]

export const OUTLINE_NODE_TYPE_LABELS: Record<OutlineNodeType, string> = {
  main: '主线',
  sub: '支线',
  event: '事件',
  foreshadow: '伏笔',
  twist: '转折',
  note: '备注'
}

export function isOutlineNodeType(value: unknown): value is OutlineNodeType {
  return typeof value === 'string' && (OUTLINE_NODE_TYPES as readonly string[]).includes(value)
}

/** 写作进度，由作者自己推进；与关联章节的状态是两件事，互不覆盖 */
export const OUTLINE_STATUSES = ['planned', 'writing', 'done', 'dropped'] as const
export type OutlineStatus = (typeof OUTLINE_STATUSES)[number]

export const OUTLINE_STATUS_LABELS: Record<OutlineStatus, string> = {
  planned: '构想',
  writing: '写作中',
  done: '已完成',
  dropped: '已废弃'
}

export function isOutlineStatus(value: unknown): value is OutlineStatus {
  return typeof value === 'string' && (OUTLINE_STATUSES as readonly string[]).includes(value)
}

const nodeTypeSchema = z.string().refine(isOutlineNodeType, '大纲节点类型不合法')
const outlineStatusSchema = z.string().refine(isOutlineStatus, '大纲状态不合法')

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

export interface OutlineNode {
  id: number
  bookId: number
  /** null 表示位于树的根层 */
  parentId: number | null
  /** 落地到的章节；null 表示还只是个构想 */
  chapterId: number | null
  nodeType: OutlineNodeType
  title: string
  summary: string
  status: OutlineStatus
  orderIndex: number
  createdAt: string
  updatedAt: string
}

/**
 * 树节点。
 *
 * `children` 由服务层用一次查询的结果在内存里组装，
 * **不是**逐层递归查数据库 —— 那样一个三层大纲就要发几十次查询。
 *
 * 关联章节的标题与状态随树一起返回：树上要显示「已落地 →《第一章 》」，
 * 否则前端得为每个节点再查一次章节，而章节列表又是按整本书取的，
 * 为了几十个节点把全书章节拉一遍不划算。
 */
export interface OutlineTreeNode extends OutlineNode {
  children: OutlineTreeNode[]
  chapterTitle: string | null
  chapterStatus: ChapterStatus | null
  /** 子孙节点总数（不含自身）。删除前用它提示「将同时删除 N 个子节点」 */
  descendantCount: number
}

export interface OutlineTreeResult {
  bookId: number
  nodes: OutlineTreeNode[]
  /** 节点总数（含所有层级） */
  total: number
  /** 实际达到的最大层级，根层为 1；空树为 0 */
  depth: number
  statusCounts: Record<OutlineStatus, number>
  typeCounts: Record<OutlineNodeType, number>
  /** 已落地成章节的节点数 */
  landedCount: number
}

/* ------------------------------------------------------------------ *
 * 字段与上限
 * ------------------------------------------------------------------ */

export const OUTLINE_LIMITS = {
  title: 120,
  summary: 2000,
  /** 单本书的节点总数上限。防止误操作（比如脚本循环调用）把界面拖垮 */
  perBook: 2000,
  /**
   * 树的层级上限（根层为 1）。
   *
   * 自由树不设上限的话，拖拽误操作能造出几百层嵌套 —— 树组件会因为
   * 每层的缩进把内容挤成一条竖线，而且拖拽换算下标的递归深度也随之失控。
   * 12 层对小说大纲远远够用（主线 → 卷段 → 章 → 场景 → 细节 通常不超过 6 层）。
   */
  depth: 12
} as const

const outlineFields = {
  title: z
    .string()
    .trim()
    .min(1, '节点标题不能为空')
    .max(OUTLINE_LIMITS.title, `节点标题最多 ${OUTLINE_LIMITS.title} 个字符`),
  summary: z
    .string()
    .trim()
    .max(OUTLINE_LIMITS.summary, `节点梗概最多 ${OUTLINE_LIMITS.summary} 个字符`)
}

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

export const outlineTreeQuerySchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法')
})

export type OutlineTreeQueryInput = z.infer<typeof outlineTreeQuerySchema>

export const outlineNodeCreateSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  /**
   * 父节点。显式 `.nullable()` 而不是只写 `.default(null)`：
   * `default` 只对 `undefined` 生效，拦不住 `null`（`books:list` 就栽在这上面）。
   * 根层节点传的就是 `null`。
   */
  parentId: z.number().int().positive().nullable().default(null),
  nodeType: nodeTypeSchema.default('event'),
  title: outlineFields.title,
  summary: outlineFields.summary.default(''),
  status: outlineStatusSchema.default('planned')
})

export type OutlineNodeCreateInput = z.infer<typeof outlineNodeCreateSchema>

export const outlineNodeUpdateSchema = z.object({
  id: z.number().int().positive('节点 ID 非法'),
  nodeType: nodeTypeSchema,
  title: outlineFields.title,
  summary: outlineFields.summary,
  status: outlineStatusSchema
})

export type OutlineNodeUpdateInput = z.infer<typeof outlineNodeUpdateSchema>

export const outlineNodeIdSchema = z.object({
  id: z.number().int().positive('节点 ID 非法')
})

export type OutlineNodeIdInput = z.infer<typeof outlineNodeIdSchema>

/**
 * 移动节点（拖拽落点的实现）。
 *
 * 与章节移动同样的思路：调用方只给「目标父节点 + 落点下标」，
 * 两个父节点下的新顺序都由服务层基于**当前数据库状态**算出来，
 * 不接受客户端提交顺序 —— 否则并发拖拽时，客户端手里的旧树会覆盖别人的改动。
 *
 * 目标下标越界会被夹到合法区间，不报错：拖到空白处落点常常算得偏大，
 * 为此弹一个错误框没有意义。
 */
export const outlineNodeMoveSchema = z.object({
  id: z.number().int().positive('节点 ID 非法'),
  parentId: z.number().int().positive().nullable(),
  targetIndex: z.number().int().min(0)
})

export type OutlineNodeMoveInput = z.infer<typeof outlineNodeMoveSchema>

/**
 * 关联 / 解除关联章节。
 *
 * `chapterId` 为 `null` 表示解除：节点保留，只是不再指向任何章节。
 * 这是「构想」与「成稿」之间唯一的那条连线，两侧都可以自由断开。
 */
export const outlineAttachChapterSchema = z.object({
  id: z.number().int().positive('节点 ID 非法'),
  chapterId: z.number().int().positive().nullable()
})

export type OutlineAttachChapterInput = z.infer<typeof outlineAttachChapterSchema>

/** 把节点落地成**新章节**（创建章节 + 建立关联），一步到位 */
export const outlineMaterializeSchema = z.object({
  id: z.number().int().positive('节点 ID 非法'),
  /** 新章节放进哪个分卷，null 表示未分卷 */
  volumeId: z.number().int().positive().nullable().default(null),
  targetWords: z
    .number()
    .int('目标字数必须是整数')
    .min(0, '目标字数不能为负')
    .max(CHAPTER_LIMITS.targetWords, '目标字数超出合理范围')
    .default(0)
})

export type OutlineMaterializeInput = z.infer<typeof outlineMaterializeSchema>

/** 落地操作的回执：带上新章节 id，前端据此跳进编辑器 */
export interface OutlineMaterializeResult {
  nodeId: number
  chapterId: number
  chapterTitle: string
}
