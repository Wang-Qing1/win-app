import {
  CARD_LIMITS,
  CARD_TYPE_LABELS,
  normalizeExtra,
  normalizeTags,
  type Card,
  type CardCreateInput,
  type CardListQuery,
  type CardListResult,
  type CardRemovalResult,
  type CardType,
  type CardUpdateInput
} from '@shared/modules/cards'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { BookRepository } from '../books/book.repository'
import type { CardRepository, CardWriteData } from './card.repository'

/**
 * 卡片服务。
 *
 * 统一的表结构带来一个必须由服务层兜住的隐患：**账号卡片的 extra 是自由 JSON，
 * 数据库不会替我们拒绝任何键**。所以每次写入都要经过 normalizeExtra，
 * 把 extra 投影到「目标类型声明的字段集」上 —— 见 prepareWrite 的说明。
 */
export class CardService {
  constructor(
    private readonly repository: CardRepository,
    private readonly bookRepository: BookRepository
  ) {}

  /* ------------------------------------------------------------------ *
   * 读
   * ------------------------------------------------------------------ */

  /**
   * 卡片列表。
   *
   * 几个数字来自几条 SQL（本页数据 + 总数 + 各维度计数），它们共用同一份
   * WHERE 条件（见仓储的 buildFilter），因此不会出现「共 3 张、却列出 4 行」
   * 这种自相矛盾 —— 那比数字算错更难排查，因为看起来像是界面出了问题。
   */
  list(query: CardListQuery): CardListResult {
    const paged = this.repository.listPaged(query)

    return {
      ...paged,
      typeCounts: this.repository.countByType(query),
      settingCounts: this.repository.countBySettingCategory(query),
      globalCount: this.repository.countGlobal(query)
    }
  }

  /* ------------------------------------------------------------------ *
   * 写
   * ------------------------------------------------------------------ */

  create(input: CardCreateInput): Card {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)
      this.assertTitleFree(input.bookId, input.cardType, input.title)

      const id = this.repository.insert(
        this.prepareWrite(input),
        new Date().toISOString()
      )

      const created = this.repository.findById(id)
      if (!created) {
        throw AppError.internal(`新增卡片后无法回读记录（ID: ${id}）`)
      }

      logger.info('卡片已创建', { id, cardType: created.cardType, bookId: created.bookId })
      return created
    })
  }

  /**
   * 更新卡片。
   *
   * 允许改类型（比如「本来想记成灵感，写下来发现是个设定」），
   * 此时 extra 会被投影到新类型的字段集上：旧类型的键全部丢弃、
   * 新类型的键补齐为空串。不这么做的话，一张物品卡里会永远留着一份
   * 谁也不会显示的「身份定位」，直到某天导出时才暴露出来。
   */
  update(input: CardUpdateInput): Card {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`卡片不存在（ID: ${input.id}）`)
      }

      this.assertBookExists(input.bookId)
      this.assertTitleFree(input.bookId, input.cardType, input.title, input.id)

      const changed = this.repository.update(
        { ...this.prepareWrite(input), id: input.id },
        new Date().toISOString()
      )
      if (!changed) {
        throw AppError.internal(`卡片更新失败（ID: ${input.id}）`)
      }

      const updated = this.repository.findById(input.id)
      if (!updated) {
        throw AppError.internal(`卡片更新后无法回读（ID: ${input.id}）`)
      }

      logger.info('卡片已更新', {
        id: input.id,
        cardType: updated.cardType,
        typeChanged: existing.cardType !== updated.cardType
      })
      return updated
    })
  }

  remove(id: number): CardRemovalResult {
    return runInTransaction(() => {
      const existing = this.repository.findById(id)
      if (!existing) {
        throw AppError.notFound(`卡片不存在（ID: ${id}）`)
      }

      if (!this.repository.deleteById(id)) {
        throw AppError.internal(`卡片删除失败（ID: ${id}）`)
      }

      logger.info('卡片已删除', { id, cardType: existing.cardType })
      return { id, title: existing.title }
    })
  }

  /**
   * 复制一张卡片。
   *
   * 人物卡常需要「同一个模板改几笔」——比如同一阵营的三个配角，
   * 身份与阵营字段完全一样，只有关系不同。逐字段重填的代价远高于复制一份。
   *
   * 标题自动加「副本」后缀并**避开重名**：直接复用原标题会被上面的
   * 唯一性规则拒掉，那样复制功能在第一步就不可用。
   */
  duplicate(id: number): Card {
    return runInTransaction(() => {
      const source = this.repository.findById(id)
      if (!source) {
        throw AppError.notFound(`卡片不存在（ID: ${id}）`)
      }

      this.assertBookExists(source.bookId)

      const title = this.nextCopyTitle(source.bookId, source.cardType, source.title)
      const id2 = this.repository.insert(
        {
          bookId: source.bookId,
          cardType: source.cardType,
          title,
          subtitle: source.subtitle,
          content: source.content,
          tags: source.tags,
          // source.extra 已经过 normalizeExtra（读取路径上做过），
          // 这里再走一次是为了不依赖「读路径一定清洗过」这个假设
          extra: normalizeExtra(source.cardType, source.extra)
        },
        new Date().toISOString()
      )

      const created = this.repository.findById(id2)
      if (!created) {
        throw AppError.internal(`复制卡片后无法回读记录（ID: ${id2}）`)
      }

      logger.info('卡片已复制', { sourceId: id, id: id2, title })
      return created
    })
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  /**
   * 由入参准备出待写入的一行。
   *
   * 两个规范化都收在这里：
   *   - tags：去空白、丢空串、去重（前端解析标签用同一份规则，见共享层）
   *   - extra：**按目标类型投影**，这是统一建模下最关键的一步。
   *     入参里可能带着不属于当前类型的键（改类型时前端表单还没来得及清理），
   *     不经投影就会被 JSON.stringify 原样写进库。
   */
  private prepareWrite(input: CardCreateInput | CardUpdateInput): CardWriteData {
    return {
      bookId: input.bookId,
      cardType: input.cardType,
      title: input.title,
      subtitle: input.subtitle,
      content: input.content,
      tags: normalizeTags(input.tags),
      extra: normalizeExtra(input.cardType, input.extra)
    }
  }

  private assertBookExists(bookId: number | null): void {
    // null 是合法的「通用卡片」，不校验
    if (bookId === null) return

    if (!this.bookRepository.exists(bookId)) {
      throw AppError.notFound(`书籍不存在（ID: ${bookId}）`)
    }
  }

  private assertTitleFree(
    bookId: number | null,
    cardType: CardType,
    title: string,
    excludeId?: number
  ): void {
    const occupied = this.repository.findByTitle(bookId, cardType, title, excludeId)
    if (occupied) {
      const where = bookId === null ? '通用卡片' : '这本书'
      throw AppError.conflict(
        `${where}里已经有一张叫「${occupied.title}」的${CARD_TYPE_LABELS[cardType]}卡了，` +
          '换个名字，或者先改那一张'
      )
    }
  }

  /**
   * 生成不撞名的副本标题。
   *
   * 截断是必需的：卡片标题上限 80 字符，若原标题已经顶到上限，
   * 加后缀就会超限。副本本身能存下去（服务层不重复校验长度），
   * 但**下一次从界面保存这张副本时会被边界校验拒掉** —— 用户会看到
   * 一张「点保存就报错」的卡片，而错因和标题长度毫无关系。
   */
  private nextCopyTitle(bookId: number | null, cardType: CardType, sourceTitle: string): string {
    const taken = new Set(
      this.repository.listTitles(bookId, cardType).map((title) => title.toLowerCase())
    )

    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      const suffix = ordinal === 1 ? ' 副本' : ` 副本 ${ordinal}`
      const head = sourceTitle
        .slice(0, Math.max(1, CARD_LIMITS.title - suffix.length))
        .trim()
      const candidate = `${head}${suffix}`
      if (!taken.has(candidate.toLowerCase())) return candidate
    }

    throw AppError.conflict('这张卡的副本太多了，先整理一下再复制吧')
  }
}
