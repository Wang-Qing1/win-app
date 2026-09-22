import {
  CARD_LIMITS,
  CARD_TYPE_LABELS,
  isCardType,
  normalizeExtra,
  normalizeTags,
  type Card,
  type CardCreateInput,
  type CardListQuery,
  type CardListResult,
  type CardRemovalResult,
  type CardTimelineOrderInput,
  type CardType,
  type CardUpdateInput
} from '@shared/modules/cards'
// 回收站的词法（kind / 条目形状 / 回执）收在共享层，卡片与章节两处
// 拼出来的条目才会是同一种形状，界面因此不需要按来源分支
import type { TrashEntry, TrashItemRef } from '@shared/modules/trash'
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

  /**
   * 删除卡片 —— 第三期第 5 件起是**软删除**，进回收站。
   *
   * 只打一个 deleted_at 时间戳，行还在库里，关联（章节 / 大纲节点 /
   * 人物关系）也全都原样留着 — 于是恢复的那一刻，这张卡在界面上的
   * 所有牵连都自动回来，不需要任何反向补偿逻辑。
   *
   * 前端那句提示语必须与这里一致：**「已移到回收站」而不是「已删除」**。
   * 文案说「删除」而数据只是被标记时，用户不会想到去回收站找。
   */
  remove(id: number): CardRemovalResult {
    return runInTransaction(() => {
      const existing = this.repository.findById(id)
      if (!existing) {
        throw AppError.notFound(`卡片不存在（ID: ${id}）`)
      }

      if (!this.repository.softDelete(id, new Date().toISOString())) {
        throw AppError.internal(`卡片删除失败（ID: ${id}）`)
      }

      logger.info('卡片已移入回收站', { id, cardType: existing.cardType })
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

  /**
   * 设定卡时间线重排。
   *
   * 三条硬规则，缺一条都会让时间线变成一个说谎的视图：
   *   1. **只能是设定卡。** 人物 / 物品卡没有时点，混进来会变成一排空白；
   *   2. **必须同一本书。** 跨书的时间线在故事上不存在；
   *   3. **同一组里类别必须一致**（给了 category 时）。「地点」与「时间线」
   *      混排看着像「这些事按先后发生」，其实一半是静态设定。
   *
   * 返回重排后的完整卡片：调用方直接拿它替换本地列表，不必再查一次。
   */
  setTimelineOrder(input: CardTimelineOrderInput): Card[] {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)

      // 重复 id 会让「第 N 位」这个语义自相矛盾：同一张卡既在第 2 位
      // 又在第 5 位，写进去的序号取决于循环顺序，界面上则表现为
      // 「有一行消失了」—— 那个坑排查起来非常费劲
      if (new Set(input.orderedIds).size !== input.orderedIds.length) {
        throw AppError.validation('排序里出现了同一张卡片，请刷新后重试')
      }

      const cards = input.orderedIds.map((id) => {
        const card = this.repository.findById(id)
        if (!card) {
          throw AppError.notFound(`卡片不存在（ID: ${id}）`)
        }
        if (card.cardType !== 'setting') {
          throw AppError.validation(`「${card.title}」不是设定卡，排不进时间线`)
        }
        // 用 IS 语义比较而不是 ===：两边都可能是 null（通用设定卡）
        if (card.bookId !== input.bookId) {
          throw AppError.validation(
            `「${card.title}」不属于这本书，不能跟这本书的设定排在同一条时间线上`
          )
        }
        if (input.category !== null && card.extra.category !== input.category) {
          throw AppError.validation(
            `「${card.title}」的类别是${card.extra.category || '（未分类）'}，` +
              `排不进「${input.category}」这一组`
          )
        }
        return card
      })

      this.repository.setTimelineOrder(cards.map((card, index) => ({ id: card.id, order: index })))

      return cards.map((card) => {
        const saved = this.repository.findById(card.id)
        if (!saved) {
          throw AppError.internal(`时间线重排后无法回读卡片（ID: ${card.id}）`)
        }
        return saved
      })
    })
  }

  /* ------------------------------------------------------------------ *
   * 回收站（第三期第 5 件）
   *
   * 这一节里的四个方法只被 TrashService 调用 —— 卡片模块自己不展示
   * 回收站，它只负责回答「哪些卡片在回收站里」「把某一张捞回来」
   * 「把某一张彻底抹掉」。把这些放在这里而不是让 TrashService 直接
   * 拿 CardRepository：卡片的读取口径（认不出的类型退回灵感、
   * bookId 为 null 是通用卡片）只在这一层发生过，绕开它就会在回收站
   * 里长出一套稍有不同的口径 —— 那是同一张卡在两处显示不同的开端。
   * ------------------------------------------------------------------ */

  /** 回收站里的卡片，最近删除的在前。见仓储的 listDeleted */
  listDeleted(limit: number): TrashEntry[] {
    return this.repository.listDeleted(limit).map((row) => ({
      id: row.id,
      title: row.title,
      // 卡片拿「一句话简介」放在副标题位置：它比类型名更能帮人认出是哪张
      subtitle: row.subtitle,
      bookId: row.bookId,
      bookTitle: row.bookTitle,
      deletedAt: row.deletedAt,
      // 认不出的类型退回「灵感」，与 toCard 同一口径 —— 免得同一张卡
      // 在卡片库与回收站里显示成不同的类型
      cardType: isCardType(row.cardType) ? row.cardType : 'inspiration',
      // 卡片不算汉字数：正文上限 5000 字符，「多少字」不是它的识别特征
      hanziCount: 0
    }))
  }

  countDeleted(): number {
    return this.repository.countDeleted()
  }

  /**
   * 把一张卡从回收站捞回来。
   *
   * **不校验重名**：回收站里那张卡的标题，是它进回收站之前确实用过的名字。
   * 在它还躺在回收站期间，作者完全可能新建了一张同名的卡（见仓储
   * findByTitle 只跟活卡片比标题）—— 此时「恢复」若以重名为由拒绝，
   * 用户就陷入了一个死结：不删掉新建的那张，就永远救不回旧的那张，
   * 而两张卡的内容未必相同。允许重名是这里唯一说得通的选择：
   * 数据库层面本来也没有唯一约束，重名只是业务规则，而这条规则
   * 应当让位于「把用户的东西还给他」。
   *
   * 恢复不动 updated_at 吗？——**要动**。
   * 与「删除」不同，恢复是用户主动把一个条目重新拉回工作视野的动作，
   * 而卡片列表默认按 updated_at 倒序：不动它的话，刚恢复的卡会
   * 沉在列表底部（用的是删除前的旧时间），看起来像「恢复了但没出现」。
   */
  restoreFromTrash(id: number): TrashItemRef {
    return runInTransaction(() => {
      const entry = this.repository.findDeletedById(id)
      if (!entry) {
        throw AppError.notFound(`回收站里没有这张卡片（ID: ${id}）`)
      }

      if (!this.repository.restoreById(id, new Date().toISOString())) {
        throw AppError.internal(`卡片恢复失败（ID: ${id}）`)
      }

      logger.info('卡片已从回收站恢复', { id, cardType: entry.cardType })
      return { kind: 'card' as const, id, title: entry.title }
    })
  }

  /** 彻底删除。关联（章节 / 大纲节点 / 人物关系）随外键 CASCADE 一并消失 */
  purgeFromTrash(id: number): TrashItemRef {
    return runInTransaction(() => {
      const entry = this.repository.findDeletedById(id)
      if (!entry) {
        throw AppError.notFound(`回收站里没有这张卡片（ID: ${id}）`)
      }

      if (!this.repository.purgeById(id)) {
        throw AppError.internal(`卡片彻底删除失败（ID: ${id}）`)
      }

      logger.info('卡片已彻底删除', { id, cardType: entry.cardType })
      return { kind: 'card' as const, id, title: entry.title }
    })
  }

  /** 清空回收站里的卡片。返回真正删掉的条数 */
  purgeAllFromTrash(): number {
    return runInTransaction(() => {
      const removed = this.repository.purgeAll()
      if (removed > 0) logger.info('回收站里的卡片已清空', { removed })
      return removed
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
