import type { CardChapterLink, ChapterCardRef } from '@shared/modules/card-links'
import { runInTransaction } from '../../db/connection'
import { logger } from '../../core/logger'
import { AppError } from '../../core/errors'
import type { CardRepository } from '../cards/card.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'
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
    private readonly chapterRepository: ChapterRepository
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
}
