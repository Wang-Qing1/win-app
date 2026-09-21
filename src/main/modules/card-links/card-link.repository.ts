import { isCardType, type CardType } from '@shared/modules/cards'
import type { CardChapterLink, ChapterCardRef } from '@shared/modules/card-links'
import type { Db } from '../../db/types'

interface LinkRow {
  card_id: number
  chapter_id: number
  created_at: string
}

interface CardLinkRow extends LinkRow {
  chapter_title: string
  volume_title: string | null
  book_title: string
}

interface ChapterCardRow {
  card_id: number
  card_type: string
  title: string
  subtitle: string
}

/**
 * 卡片 ↔ 章节关联的仓储。
 *
 * 只做 SQL 与行↔对象映射。这里刻意**没有**「两边必须同书」的检查：
 * 那是一条业务规则，属于服务层；放在仓储里的话，将来若出现
 * 「复制整卷时批量建立关联」这类内部调用，就会被自己的检查挡住，
 * 而那时恰恰是允许批量写入的场景。业务规则只有一处实现 —— 服务层。
 */
export class CardLinkRepository {
  constructor(private readonly db: Db) {}

  /**
   * 建立关联。`INSERT OR IGNORE` 而不是先 SELECT 判重：
   * 复合主键已经保证同一对只出现一次，而「先查后插」之间存在竞态 ——
   * 快速连点两下就会撞出重复行。把判重交给数据库，两行代码换掉
   * 一个必然会在某天复现的偶发 bug。
   */
  insert(cardId: number, chapterId: number, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO card_chapter_links (card_id, chapter_id, created_at)
         VALUES (@cardId, @chapterId, @now)`
      )
      .run({ cardId, chapterId, now })
  }

  /** 解除关联。解除一条不存在的关联不算错误：结果都是「没有了」 */
  delete(cardId: number, chapterId: number): void {
    this.db
      .prepare('DELETE FROM card_chapter_links WHERE card_id = ? AND chapter_id = ?')
      .run(cardId, chapterId)
  }

  /**
   * 一张卡用在哪几章。
   *
   * 带上卷名与书名：关联列表是要被点着跳过去的，只给一个章节标题，
   * 在三本书里都有「第三章」时就分不清是哪一章。
   *
   * 排序按卷序、章序而不是关联时间：这是一份「这条设定在书里的分布」，
   * 按书的顺序读才有意义；按时间排只会得到一串随写作顺序乱跳的章节。
   * `COALESCE(v.order_index, -1)` 让未分卷的章节排在最前 ——
   * NULL 在 SQLite 里最小，直接排会让它们挤在一起却无法与卷序比较。
   */
  listByCard(cardId: number): CardChapterLink[] {
    const rows = this.db
      .prepare(
        `SELECT l.card_id AS card_id, l.chapter_id AS chapter_id, l.created_at AS created_at,
                c.title AS chapter_title,
                v.title AS volume_title,
                b.title AS book_title
           FROM card_chapter_links l
           JOIN chapters c ON c.id = l.chapter_id
           LEFT JOIN volumes v ON v.id = c.volume_id
           JOIN books b ON b.id = c.book_id
          WHERE l.card_id = ?
          ORDER BY COALESCE(v.order_index, -1), c.order_index, c.id`
      )
      .all(cardId) as CardLinkRow[]

    return rows.map((row) => ({
      cardId: row.card_id,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      volumeTitle: row.volume_title,
      bookTitle: row.book_title,
      createdAt: row.created_at
    }))
  }

  /** 某一章用到了哪几张卡。不带正文：这一侧只在列表里显示标题与类型 */
  listByChapter(chapterId: number): ChapterCardRef[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS card_id, c.card_type AS card_type, c.title AS title, c.subtitle AS subtitle
           FROM card_chapter_links l
           JOIN cards c ON c.id = l.card_id
          WHERE l.chapter_id = ?
          ORDER BY c.updated_at DESC, c.id DESC`
      )
      .all(chapterId) as ChapterCardRow[]

    const refs: ChapterCardRef[] = []
    for (const row of rows) {
      // 认不出的类型退回「灵感」：与卡片列表的读取路径同一口径，
      // 免得同一张卡在两处显示成不同的类型
      const cardType: CardType = isCardType(row.card_type) ? row.card_type : 'inspiration'
      refs.push({
        cardId: row.card_id,
        cardType,
        title: row.title,
        subtitle: row.subtitle
      })
    }
    return refs
  }
}
