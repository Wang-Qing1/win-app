import { z } from 'zod'
import type { CardType } from './cards'

/**
 * 回收站 —— 卡片与章节的软删除。
 *
 * 单个契约描述**两种互不相干的实体**，这是刻意的：回收站是一个动作面，
 * 不是一种数据。若把「列回收站」「恢复」「彻底删除」分别塞进 cards.ts 与
 * chapters.ts，界面上那一个列表就要同时向两边要数据、再自己拼起来排序，
 * 而「按删除时间倒序」这件事在两边各写一半的结果是不稳定的。
 * 收在一处之后，排序、分页、空态、文案都只有一份实现。
 *
 * 为什么是两种而不是更多：
 *   - 书籍与分卷是容器，删除走 CASCADE，语义是「连同内容一起清掉」；
 *   - 大纲节点是树，删一个父节点连坐整棵子树。
 * 这两类要进回收站各自需要独立的语义（整本书怎么恢复？子树恢复到哪里？），
 * 硬塞进来只会让这一份契约变成一堆 `if (kind === ...)`。
 * 因此 v1 只覆盖「一删就没了、且用户最可能后悔」的那两类：卡片与章节。
 *
 * 三个动作的先后关系必须清楚：
 *   删除（原来的删除按钮）→ 进回收站，**列表里立刻消失，数据还在**；
 *   恢复 → 回到列表，位置重新指派（见下）；
 *   彻底删除 → 真的 DELETE，此后不可恢复。清空回收站是它的批量形式。
 */

export const TRASH_KINDS = ['card', 'chapter'] as const
export type TrashKind = (typeof TRASH_KINDS)[number]

export const TRASH_KIND_LABELS: Record<TrashKind, string> = {
  card: '卡片',
  chapter: '章节'
}

export function isTrashKind(value: unknown): value is TrashKind {
  return typeof value === 'string' && (TRASH_KINDS as readonly string[]).includes(value)
}

export const TRASH_LIMITS = {
  /**
   * 回收站页一次最多列出多少条。
   *
   * 不做真分页：回收站是「翻一翻、把误删的捞回来」的地方，条目数在
   * 几十的量级；而删除时间越久远的条目越没人看，截断不会挡住任何
   * 真实的操作。超过上限时界面会明说「仅显示最近 N 条，共 M 条」——
   * 静默截断会让用户以为「只剩下这些了」，那正好是回收站最不该有的歧义。
   */
  items: 500
} as const

/**
 * 回收站里的一条。
 *
 * 两种实体共用一个形状，多出来的字段用 null 占位而不是做联合类型：
 * 列表要混排、要按同一个字段排序、要渲染成同一种行，联合类型会让
 * 渲染代码里到处都是收窄判断 —— 而这里真正需要区分的只有「标题旁边
 * 那个小标签写什么」一处。
 */
export interface TrashItem {
  kind: TrashKind
  id: number
  title: string
  /**
   * 卡片：一句话简介；章节：所属分卷名（未分卷时为空串）。
   * 两者的共同点是「比标题更次要、但能帮人认出是哪一条」。
   */
  subtitle: string
  /** 卡片可能不归属任何书（通用卡片），章节一定有书 */
  bookId: number | null
  bookTitle: string | null
  /** 删除时刻。列表按它倒序 —— 用户找的是「刚才手滑删掉的那个」 */
  deletedAt: string
  /** 卡片：类型（人物 / 物品 / 灵感 / 设定）；章节恒为 null */
  cardType: CardType | null
  /**
   * 删除时的汉字数。章节用它，作者认章节靠字数；
   * 卡片恒为 0 —— 卡片正文上限 5000 字符，「多少字」不是它的识别特征。
   */
  hanziCount: number
}

export interface TrashListResult {
  /** 按删除时间倒序，最多 TRASH_LIMITS.items 条 */
  items: TrashItem[]
  /** **当前 kind 筛选下**的条目总数，可能大于 items.length（被上限截断） */
  total: number
  /**
   * 两种各自多少条，**忽略 kind 这一项筛选**。
   *
   * 与卡片列表的 typeCounts 同一个道理：它是导航用的数字，不是当前
   * 结果集的分解。把筛选也算进去的话，切到「章节」页签之后
   * 「卡片 0 条」会读成「卡片被删光了」，而不是「被筛掉了」。
   */
  kindCounts: Record<TrashKind, number>
}

/**
 * 单个实体的模块（卡片 / 章节）对外能给出的一条回收站记录。
 *
 * 少了 `kind`：那是「回收站」这一层才知道的概念，卡片服务不该知道
 * 自己这行将来会被摆在哪种列表里。装配由 TrashService 负责。
 */
export type TrashEntry = Omit<TrashItem, 'kind'>

/** 列回收站。kind 为 null 表示两种都列 */
export const trashListSchema = z.object({
  kind: z.union([z.string().trim(), z.null()]).default('')
})

export type TrashListRawInput = z.infer<typeof trashListSchema>

export interface TrashListInput {
  kind: TrashKind | null
}

/**
 * 非法 kind 静默降级为「全部」，与卡片列表对 cardType 的处理一致。
 * 这里是只读操作，降级只会让列表多几行，不会造成损害。
 */
export function normalizeTrashList(input: TrashListRawInput): TrashListInput {
  return { kind: isTrashKind(input.kind) ? input.kind : null }
}

/**
 * 指向回收站里的某一条。
 *
 * kind 用 refine 而**不是**降级：恢复与彻底删除都会真的写库，
 * 一个写错的 kind 若被悄悄解读成另一种，就会作用到错误的实体上
 * （拿章节 id 去删卡片，运气好是 NOT_FOUND，运气不好删掉一张同号的卡）。
 * 写操作一律在边界处拒掉非法值。
 */
export const trashItemSchema = z.object({
  kind: z.string().refine(isTrashKind, '回收站条目类型不合法'),
  id: z.number().int().positive('条目 ID 非法')
})

export type TrashItemInput = z.infer<typeof trashItemSchema>

/** 清空回收站。kind 为 null 表示两种都清 */
export const trashEmptySchema = z.object({
  kind: z.union([z.string().refine(isTrashKind, '回收站条目类型不合法'), z.null()]).default(null)
})

export type TrashEmptyInput = z.infer<typeof trashEmptySchema>

/**
 * 指向回收站里某一条的回执。恢复与彻底删除共用同一个形状：
 * 界面这两种提示都要写出「《某某》…」，「那一条是谁」是同一件事。
 */
export interface TrashItemRef {
  kind: TrashKind
  id: number
  title: string
}

export interface TrashEmptyResult {
  /** 真正删掉了多少条 */
  removed: number
  removedCards: number
  removedChapters: number
}
