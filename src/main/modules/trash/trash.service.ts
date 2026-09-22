import {
  TRASH_LIMITS,
  type TrashEmptyInput,
  type TrashEmptyResult,
  type TrashItem,
  type TrashItemInput,
  type TrashItemRef,
  type TrashKind,
  type TrashListInput,
  type TrashListResult
} from '@shared/modules/trash'
import { logger } from '../../core/logger'
import type { CardService } from '../cards/card.service'
import type { ChapterService } from '../chapters/chapter.service'

/**
 * 回收站服务 —— 一台**纯粹的编排器**，自己一行 SQL 也没有。
 *
 * 之所以能这么薄，是因为「哪些卡片在回收站里」「恢复一章要落到哪个位置」
 * 这类问题各自只有卡片服务与章节服务知道答案（卡片有「认不出的类型退回
 * 灵感」的口径，章节有「容器与顺序」的概念）。让 TrashService 直接拿
 * 两个仓储去查，等于把这两套口径复制一份到第三个地方 —— 从此
 * 「同一张卡在卡片库与回收站里显示成不同类型」这类问题就有了生长的土壤。
 *
 * 它负责的只有三种**跨实体**的判断，这三种恰好谁都不该管：
 *   1. 把两张表的条目按删除时间混排成一个列表（时间轴是唯一的视角）；
 *   2. 按 kind 分派恢复 / 彻底删除（同一个动作作用在两种东西上）；
 *   3. 清空时分别统计两边的条数，合成一个回执。
 *
 * 依赖方向是单向的：trash → cards / chapters。两个模块完全不认识
 * 「回收站」这个概念，它们只知道「有一列 deleted_at」。将来再加一种
 * 可回收的实体（比如大纲节点），只需要它自己长出 listDeleted /
 * restoreFromTrash 这几个方法，然后在这里多一行 —— 不需要改任何现有模块。
 */
export class TrashService {
  constructor(
    private readonly cardService: CardService,
    private readonly chapterService: ChapterService
  ) {}

  /* ------------------------------------------------------------------ *
   * 读
   * ------------------------------------------------------------------ */

  /**
   * 混排的回收站列表。
   *
   * `kindCounts` 刻意**不受 kind 筛选影响**（两种都数、都取）：
   * 界面上它是页签旁的数字，切到「章节」时若卡片那格变成 0，
   * 读起来像「卡片被删光了」。这与卡片库 countByType 的处理一致。
   *
   * 取数上限用同一个 TRASH_LIMITS.items 逐边截断再合并，因此
   * 「卡片 500 条 + 章节 500 条」时合并后的 1000 条会被再截一次 ——
   * 截断是双向的，但 `total` 永远是真实总数，界面据此提示「仅显示最近 N 条」。
   */
  list(input: TrashListInput): TrashListResult {
    const kindCounts: Record<TrashKind, number> = {
      card: this.cardService.countDeleted(),
      chapter: this.chapterService.countDeleted()
    }

    const items: TrashItem[] = []

    if (input.kind === null || input.kind === 'card') {
      for (const entry of this.cardService.listDeleted(TRASH_LIMITS.items)) {
        items.push({ kind: 'card', ...entry })
      }
    }

    if (input.kind === null || input.kind === 'chapter') {
      for (const entry of this.chapterService.listDeleted(TRASH_LIMITS.items)) {
        items.push({ kind: 'chapter', ...entry })
      }
    }

    /*
     * 按删除时间倒序。
     *
     * 二级键必须存在：两张表的 id 是各自独立的自增序列，而删除时间
     * 只精确到毫秒 —— 在同一个毫秒里删掉一张卡与一章（冒烟测试里
     * 就是连着调两次），仅按时间排会让顺序取决于 SQLite 的返回顺序，
     * 那个顺序是没有保证的，断言因此会时红时绿。
     * 用 (kind, id) 兜底：它没有任何业务含义，但**确定**。
     */
    items.sort((left, right) => {
      if (left.deletedAt !== right.deletedAt) return left.deletedAt < right.deletedAt ? 1 : -1
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
      return right.id - left.id
    })

    const total =
      input.kind === null ? kindCounts.card + kindCounts.chapter : kindCounts[input.kind]

    return { items: items.slice(0, TRASH_LIMITS.items), total, kindCounts }
  }

  /* ------------------------------------------------------------------ *
   * 写
   * ------------------------------------------------------------------ */

  /**
   * 把一条捞回来。
   *
   * 分派只做一次，就在这一层 —— 两个实体的恢复语义完全不同
   * （卡片只是清掉标记，章节还要决定落回哪个容器的哪个位置），
   * 所以这里只负责「找对人」，不试图把两者统一成一种写法。
   */
  restore(input: TrashItemInput): TrashItemRef {
    return input.kind === 'card'
      ? this.cardService.restoreFromTrash(input.id)
      : this.chapterService.restoreFromTrash(input.id)
  }

  /** 彻底删除一条。不可恢复 —— 界面上的确认框必须说清楚这一点 */
  purge(input: TrashItemInput): TrashItemRef {
    return input.kind === 'card'
      ? this.cardService.purgeFromTrash(input.id)
      : this.chapterService.purgeFromTrash(input.id)
  }

  /**
   * 清空回收站。
   *
   * 两条 DELETE 放在同一次调用里，但**不在同一个事务里**：两个模块
   * 各自的方法内部已经各起了一个事务，而这里再套一层并不会让它们
   * 变成原子的（better-sqlite3 的事务不可重入嵌套）。真要原子，
   * 得把事务提到这一层、让两个模块各暴露一个「无事务」的变体 ——
   * 代价是每个模块多一个只为回收站存在的入口。
   *
   * 这个取舍是划算的：清空失败时最坏的结果是「卡片删掉了、章节还在」，
   * 而用户看到的是页面刷新后还剩几条 —— 再点一次即完成。
   * 它不是账务操作，不存在「扣了钱没到账」那种必须原子性的语义。
   */
  empty(input: TrashEmptyInput): TrashEmptyResult {
    const removedCards =
      input.kind === null || input.kind === 'card' ? this.cardService.purgeAllFromTrash() : 0
    const removedChapters =
      input.kind === null || input.kind === 'chapter'
        ? this.chapterService.purgeAllFromTrash()
        : 0

    const removed = removedCards + removedChapters
    if (removed > 0) {
      logger.info('回收站已清空', { removedCards, removedChapters })
    }

    return { removed, removedCards, removedChapters }
  }
}
