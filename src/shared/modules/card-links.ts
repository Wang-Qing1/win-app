import { z } from 'zod'
import type { CardType } from './cards'

/**
 * 卡片 ↔ 章节的关联。
 *
 * 单独一个文件而不是塞进 cards.ts：这是两个聚合之间的**关系**，
 * 不属于任何一方的内部契约。放哪一边都会让那一方多出一个「其实是在描述
 * 对方」的概念；独立出来之后，卡片侧与章节侧各自引用它，谁也不依赖谁。
 *
 * 关联是**对称**的：一张设定卡能找到「用在哪几章」，一章也能找到
 * 「用到了哪几条设定」。两个方向共用同一份数据（card_chapter_links），
 * 因此不存在「一边改了另一边没跟上」的可能。
 *
 * 一条硬规则：**两边必须属于同一本书**。跨书的关联没有意义 ——
 * 从这条设定点过去跳到另一本书的某一章，读者只会以为点错了。
 * 这条规则由服务层执行（仓储只管 SQL），因为「同一本书」是一个
 * 业务判断，不是 SQL 能表达的约束。
 */

/** 一张卡片关联到的某一章（含定位用的书名与卷名） */
export interface CardChapterLink {
  cardId: number
  chapterId: number
  chapterTitle: string
  /** null 表示这一章还没分卷 */
  volumeTitle: string | null
  bookTitle: string
  createdAt: string
}

/** 某一章关联到的某张卡片（列表里够用即可，不重复带正文） */
export interface ChapterCardRef {
  cardId: number
  cardType: CardType
  title: string
  subtitle: string
}

/**
 * 一张卡片关联到的某个**大纲节点**（第三期）。
 *
 * 与「关联到章节」是两件事：章节是已经写出来的正文，节点是还没落地的
 * 构想。一条设定常常先挂在某个情节节点上（「这里要用到那条禁忌」），
 * 等那一章写出来之后再补上章节关联 —— 两者并存，不互相替代。
 *
 * 带上书名：大纲是分书的，只给节点标题分不清是哪一本。
 */
export interface CardOutlineLink {
  cardId: number
  nodeId: number
  nodeTitle: string
  nodeType: string
  bookTitle: string
  createdAt: string
}

/** 某个大纲节点关联到的某张卡片 */
export interface OutlineCardRef {
  cardId: number
  cardType: CardType
  title: string
  subtitle: string
}

/* ------------------------------------------------------------------ *
 * 卡片 ↔ 卡片的关系（第三期第 3 件）
 * ------------------------------------------------------------------ */

/**
 * 一张卡与另一张卡之间的关系。
 *
 * 与上面两类关联（章节 / 大纲节点）有个根本差别：**关系没有方向**。
 * 两人之间是「师徒」这件事，不因从哪一头看而改变。所以一对卡之间只存
 * 一条边，建表时用 `CHECK (card_id < related_id)` 把两种写法收成一种 ——
 * 否则「A 连 B」与「B 连 A」会存成两条边：关系图上同一个关系画两遍，
 * 界面上表现为「删掉一条还剩一条」。
 *
 * 关系名是**自由文本**而不是枚举：小说里的关系写不完（师徒、宿敌、
 * 指腹为婚、欠一条命），做成下拉只会让人选不出想要的那个，最后统统
 * 落到「其它」上 —— 那等于没有分类。
 *
 * 关系不只在人物之间发生：人物 ↔ 势力（设定卡）同样常见，
 * 所以这里没有「两边都必须是人物卡」的限制，只要求同书。
 */
export interface CardRelation {
  /** 被查询的那一张卡。列表里每一项都是「它 ↔ 对方」 */
  cardId: number
  /** 对方的卡 */
  relatedId: number
  /** 关系名，如「师徒」 */
  relation: string
  relatedTitle: string
  /** 对方的类型：列表上要标出来，否则「星海联邦」看不出是一张设定卡 */
  relatedType: CardType
  createdAt: string
}

/** 关系网里的一条边：两头的信息都带齐，列表与将来的图共用这一份 */
export interface CardRelationEdge {
  cardId: number
  cardTitle: string
  cardType: CardType
  relatedId: number
  relatedTitle: string
  relatedType: CardType
  relation: string
  createdAt: string
}

export const RELATION_LIMITS = {
  /** 关系名是一行标签，不是一句话 */
  label: 24
} as const

/**
 * 把一对待建立关系的卡收成「小的在前」的规范写法。
 *
 * 放在共享层而不是服务层：它是这张表的**存储约定**（写入必须按它排序），
 * 属于契约的一部分；放在服务层里的话，仓储就不知道「调用方有没有排好」，
 * 而 CHECK 约束只在写入那一刻才报错。
 */
export function sortRelationPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a]
}

const idField = z.number().int().positive('ID 非法')

export const cardLinkPairSchema = z.object({
  cardId: idField,
  chapterId: idField
})

export type CardLinkPairInput = z.infer<typeof cardLinkPairSchema>

export const cardLinkCardSchema = z.object({
  cardId: idField
})

export type CardLinkCardInput = z.infer<typeof cardLinkCardSchema>

export const cardLinkChapterSchema = z.object({
  chapterId: idField
})

export type CardLinkChapterInput = z.infer<typeof cardLinkChapterSchema>

export const cardLinkNodePairSchema = z.object({
  cardId: idField,
  nodeId: idField
})

export type CardLinkNodePairInput = z.infer<typeof cardLinkNodePairSchema>

export const cardLinkNodeSchema = z.object({
  nodeId: idField
})

export type CardLinkNodeInput = z.infer<typeof cardLinkNodeSchema>

/* ---- 卡片 ↔ 卡片 ---- */

export const cardRelationPairSchema = z.object({
  cardId: idField,
  relatedId: idField,
  relation: z
    .string()
    .trim()
    .min(1, '关系名不能为空')
    .max(RELATION_LIMITS.label, `关系名最多 ${RELATION_LIMITS.label} 个字符`)
})

export type CardRelationPairInput = z.infer<typeof cardRelationPairSchema>

export const cardRelationUnpairSchema = z.object({
  cardId: idField,
  relatedId: idField
})

export type CardRelationUnpairInput = z.infer<typeof cardRelationUnpairSchema>

export const cardRelationBookSchema = z.object({
  bookId: idField
})

export type CardRelationBookInput = z.infer<typeof cardRelationBookSchema>
