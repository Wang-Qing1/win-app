import {
  sortRelationPair,
  type CardChapterLink,
  type CardOutlineLink,
  type CardRelation,
  type CardRelationEdge,
  type ChapterCardRef,
  type OutlineCardRef
} from '@shared/modules/card-links'
import { runInTransaction } from '../../db/connection'
import { logger } from '../../core/logger'
import { AppError } from '../../core/errors'
import type { CardRepository } from '../cards/card.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'
import type { OutlineRepository } from '../outline/outline.repository'
import type { CardLinkRepository } from './card-link.repository'

/**
 * 卡片 ↔ 章节关联的服务层。
 *
 * 这里只守一条规则，但它是这个功能成立的前提：**两边必须属于同一本书**。
 * 跨书的关联点过去会跳到另一本书的某一章，读者只会以为点错了；
 * 而这种关联一旦建立，界面上没有任何东西能提示「它们其实没关系」。
 *
 * 通用卡片（bookId 为 null）不能关联 —— 它不属于任何书，
 * 自然也就没有「这本书的某一章」可言。
 */
export class CardLinkService {
  constructor(
    private readonly links: CardLinkRepository,
    private readonly cardRepository: CardRepository,
    private readonly chapterRepository: ChapterRepository,
    private readonly outlineRepository: OutlineRepository
  ) {}

  /** 这张卡用在哪几章 */
  listByCard(cardId: number): CardChapterLink[] {
    this.assertCardExists(cardId)
    return this.links.listByCard(cardId)
  }

  /** 这一章用到了哪几张卡 */
  listByChapter(chapterId: number): ChapterCardRef[] {
    this.assertChapterExists(chapterId)
    return this.links.listByChapter(chapterId)
  }

  /**
   * 建立关联，返回这张卡关联后的完整列表。
   *
   * 返回列表而不是「刚建的那一条」：调用方拿到即可替换本地状态，
   * 不必再发一次查询；也顺带让「关联成功后列表没刷新」这类时序问题
   * 根本没有发生的机会。
   *
   * 幂等：重复关联同一对不报错、也不产生第二行（仓储用 INSERT OR IGNORE）。
   * 界面上的「快速连点」因此是安全的。
   */
  link(cardId: number, chapterId: number): CardChapterLink[] {
    return runInTransaction(() => {
      const card = this.assertCardExists(cardId)
      const chapter = this.assertChapterExists(chapterId)
      this.assertSameBook(card.bookId, chapter.bookId, card.title, chapter.title)

      this.links.insert(cardId, chapterId, new Date().toISOString())
      logger.info('卡片已关联章节', { cardId, chapterId })

      return this.links.listByCard(cardId)
    })
  }

  unlink(cardId: number, chapterId: number): CardChapterLink[] {
    return runInTransaction(() => {
      this.assertCardExists(cardId)
      this.assertChapterExists(chapterId)

      this.links.delete(cardId, chapterId)
      logger.info('卡片已解除章节关联', { cardId, chapterId })

      return this.links.listByCard(cardId)
    })
  }

  /* ------------------------------------------------------------------ *
   * 大纲节点侧（第三期）
   *
   * 同一条「两边同书」规则在这里同样成立，而且更容易踩到：
   * 大纲节点永远属于某一本书，卡片却可能是通用的。
   * ------------------------------------------------------------------ */

  /** 这张卡挂在哪些节点上 */
  listNodesByCard(cardId: number): CardOutlineLink[] {
    this.assertCardExists(cardId)
    return this.links.listNodesByCard(cardId)
  }

  /** 这个节点用到了哪几张卡 */
  listByNode(nodeId: number): OutlineCardRef[] {
    this.assertNodeExists(nodeId)
    return this.links.listByNode(nodeId)
  }

  linkNode(cardId: number, nodeId: number): CardOutlineLink[] {
    return runInTransaction(() => {
      const card = this.assertCardExists(cardId)
      const node = this.assertNodeExists(nodeId)
      this.assertSameBook(card.bookId, node.book_id, card.title, node.title)

      this.links.insertNode(cardId, nodeId, new Date().toISOString())
      logger.info('卡片已关联大纲节点', { cardId, nodeId })

      return this.links.listNodesByCard(cardId)
    })
  }

  unlinkNode(cardId: number, nodeId: number): CardOutlineLink[] {
    return runInTransaction(() => {
      this.assertCardExists(cardId)
      this.assertNodeExists(nodeId)

      this.links.deleteNode(cardId, nodeId)
      logger.info('卡片已解除大纲节点关联', { cardId, nodeId })

      return this.links.listNodesByCard(cardId)
    })
  }

  /* ------------------------------------------------------------------ *
   * 卡片 ↔ 卡片（第三期第 3 件）
   *
   * 关系与上面两类关联共享「两边必须同属一本书」这条规则，但另有两条
   * 它自己才有的：不能和自己建立关系，以及两边都得真的存在。
   * ------------------------------------------------------------------ */

  /** 这张卡与哪些卡有关系（一条边的两头都能看到它） */
  listRelations(cardId: number): CardRelation[] {
    this.assertCardExists(cardId)
    return this.links.listRelations(cardId)
  }

  /** 这本书里所有的关系边，给关系网用 */
  listRelationsByBook(bookId: number): CardRelationEdge[] {
    return this.links.listRelationsByBook(bookId)
  }

  /**
   * 建立 / 改写一条关系，返回这张卡关系后的完整列表。
   *
   * 幂等：同一对卡重复建立不产生第二条边，只把关系名改成最新的
   * （仓储走 UPSERT）。于是「改关系名」与「建关系」是同一个操作，
   * 界面上不必先删再建。
   *
   * 返回的列表是**被查询那一张卡**的视角：调用方（面板）直接拿它
   * 替换本地状态即可。另一头看不到这次改动，由前端再失效一次 ——
   * 一条边两头的列表内容相同但视角不同，没法用同一份返回值顶替。
   */
  relate(cardId: number, relatedId: number, relation: string): CardRelation[] {
    return runInTransaction(() => {
      const card = this.assertCardExists(cardId)
      const other = this.assertCardExists(relatedId)

      if (cardId === relatedId) {
        throw AppError.validation(`不能给「${card.title}」和自己建立关系`)
      }
      this.assertSameRelationBook(card.bookId, other.bookId, card.title, other.title)

      // 表上有 CHECK (card_id < related_id)：一条边只有一种写法，
      // 于是「A 连 B」与「B 连 A」不会存成两条
      const [left, right] = sortRelationPair(cardId, relatedId)
      this.links.upsertRelation(left, right, relation, new Date().toISOString())
      logger.info('卡片关系已建立', { cardId, relatedId, relation })

      return this.links.listRelations(cardId)
    })
  }

  /** 解除一条关系，返回这张卡解除后的完整列表 */
  unrelate(cardId: number, relatedId: number): CardRelation[] {
    return runInTransaction(() => {
      this.assertCardExists(cardId)
      this.assertCardExists(relatedId)

      const [left, right] = sortRelationPair(cardId, relatedId)
      this.links.deleteRelation(left, right)
      logger.info('卡片关系已解除', { cardId, relatedId })

      return this.links.listRelations(cardId)
    })
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  private assertCardExists(cardId: number) {
    const card = this.cardRepository.findById(cardId)
    if (!card) throw AppError.notFound(`卡片不存在（ID: ${cardId}）`)
    return card
  }

  private assertChapterExists(chapterId: number) {
    const chapter = this.chapterRepository.findById(chapterId)
    if (!chapter) throw AppError.notFound(`章节不存在（ID: ${chapterId}）`)
    return chapter
  }

  private assertNodeExists(nodeId: number) {
    const node = this.outlineRepository.findById(nodeId)
    if (!node) throw AppError.notFound(`大纲节点不存在（ID: ${nodeId}）`)
    return node
  }

  /**
   * 同书校验。
   *
   * 报错文案里带上两边各自的名字与归属：只说「不能跨书关联」的话，
   * 用户不知道是哪一边选错了 —— 而这里最常见的错因恰恰是
   * 「卡片建在了另一本书下」，得让用户能自己看出来。
   */
  private assertSameBook(
    cardBookId: number | null,
    chapterBookId: number,
    cardTitle: string,
    chapterTitle: string
  ): void {
    if (cardBookId === null) {
      throw AppError.conflict(
        `「${cardTitle}」是通用卡片，不属于任何书，没法关联到《${chapterTitle}》。` +
          '先把它指定到一本书下。'
      )
    }

    if (cardBookId !== chapterBookId) {
      throw AppError.conflict(
        `「${cardTitle}」不属于《${chapterTitle}》所在的这本书，跨书关联没有意义。`
      )
    }
  }

  /**
   * 关系两端的同书校验。
   *
   * 不复用 `assertSameBook`：那一版的文案是按「卡片 ↔ 章节」写的
   * （「先把它指定到一本书下」对一张卡没有意义），而关系的两边都是卡片，
   * 常见错因是「另一张卡建在了别的书里」—— 文案得指向那一边。
   */
  private assertSameRelationBook(
    leftBookId: number | null,
    rightBookId: number | null,
    leftTitle: string,
    rightTitle: string
  ): void {
    if (leftBookId === null || rightBookId === null) {
      throw AppError.conflict(
        `「${leftBookId === null ? leftTitle : rightTitle}」是通用卡片，` +
          '不属于任何书，建立关系前先把它指定到一本书下。'
      )
    }

    if (leftBookId !== rightBookId) {
      throw AppError.conflict(
        `「${leftTitle}」与「${rightTitle}」不属于同一本书，跨书的关系在关系网里没有落点。`
      )
    }
  }
}
