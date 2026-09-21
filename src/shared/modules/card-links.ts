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
