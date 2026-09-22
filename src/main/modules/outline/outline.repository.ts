import {
  isOutlineNodeType,
  isOutlineStatus,
  type OutlineAttachChapterInput,
  type OutlineNode,
  type OutlineNodeCreateInput,
  type OutlineNodeUpdateInput
} from '@shared/modules/outline'
import { isChapterStatus, type ChapterStatus } from '@shared/modules/chapters'
import type { Db } from '../../db/types'
import { toNumber } from '../../db/sql-utils'

/**
 * 一行原始数据。
 *
 * 这里刻意**不做树形组装** —— 仓储只负责把整本书的节点平铺取回来，
 * 组装、深度计算、环检测全部交给服务层在内存里做。
 * 原因是这些判断都需要「看到全貌」：环检测要顺着 parent 指针往上走，
 * 深度校验要知道目标父节点的层数。逐节点单独查数据库会让这些判断
 * 变成 N 次往返，而且中途还可能读到别人改过的中间状态。
 *
 * 单本书的节点上限是 2000，一次全取的内存开销可以忽略。
 */
export interface OutlineNodeRow {
  id: number
  book_id: number
  parent_id: number | null
  chapter_id: number | null
  node_type: string
  title: string
  summary: string
  status: string
  order_index: number
  created_at: string
  updated_at: string
  /** LEFT JOIN 章节得到，未落地时为 null */
  chapter_title: string | null
  chapter_status: string | null
}

const SELECT_COLUMNS = `
  o.id, o.book_id, o.parent_id, o.chapter_id, o.node_type, o.title, o.summary,
  o.status, o.order_index, o.created_at, o.updated_at,
  c.title  AS chapter_title,
  c.status AS chapter_status
`

/**
 * 关联章节用 LEFT JOIN 而不是子查询：主查询本身就要取全表，
 * 子查询会对每一行再跑一次。JOIN 一次搞定，且能顺带拿到章节状态。
 *
 * `AND c.deleted_at IS NULL` 放在 **ON** 里而不是 WHERE 里，这是关键：
 * 写进 WHERE 会让「章节进了回收站」的节点整行被滤掉 —— 作者会看到
 * 大纲上凭空少了一个情节节点，而那个节点的层级、备注、其它信息都还在，
 * 只是它关联的章节被删了。放进 ON 之后，节点照常出现，只是它的
 * `chapterId` 读出来是 null（那一章确实已经不在工作视野里了）；
 * 作者从回收站把章节捞回来，这个关联就自动恢复 ——
 * 这正是软删除比起硬删除多出来的那一份能力。
 */
const FROM_CLAUSE = `
  FROM outline_nodes o
  LEFT JOIN chapters c ON c.id = o.chapter_id AND c.deleted_at IS NULL
`

/**
 * 行 → 领域对象。
 *
 * `node_type` / `status` 在数据库里是 TEXT，理论上允许任意字符串。
 * 这里做一次收敛：认不出来的值退回默认，而不是原样透传给前端 ——
 * 否则前端拿到未知枚举会渲染出空白标签，且类型系统还以为它是安全的。
 * 正常流程写不进非法值（边界校验挡着），这是针对手工改库或旧版本数据的兜底。
 */
export function toOutlineNode(row: OutlineNodeRow): OutlineNode {
  return {
    id: row.id,
    bookId: row.book_id,
    parentId: row.parent_id,
    chapterId: row.chapter_id,
    nodeType: isOutlineNodeType(row.node_type) ? row.node_type : 'event',
    title: row.title,
    summary: row.summary,
    status: isOutlineStatus(row.status) ? row.status : 'planned',
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * 章节状态在数据库里也是 TEXT，同样需要收敛成枚举再交给前端。
 * 未关联章节时为 null，这里原样保留。
 */
export function toChapterStatus(value: string | null): ChapterStatus | null {
  return isChapterStatus(value) ? value : null
}

export class OutlineRepository {  constructor(private readonly db: Db) {}

  /**
   * 取一本书的全部节点（平铺）。
   *
   * 按 order_index 全局排序即可：服务层会按 parent_id 分组，
   * 同一父节点下的相对顺序就保持住了，不需要为每个父节点单独排序。
   */
  listByBook(bookId: number): OutlineNodeRow[] {
    return this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
           ${FROM_CLAUSE}
          WHERE o.book_id = ?
          ORDER BY o.order_index ASC, o.id ASC`
      )
      .all(bookId) as OutlineNodeRow[]
  }

  findById(id: number): OutlineNodeRow | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE o.id = ?`)
      .get(id) as OutlineNodeRow | undefined
    return row ?? null
  }

  countByBook(bookId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM outline_nodes WHERE book_id = ?')
      .get(bookId) as { n: number }
    return toNumber(row.n)
  }

  /**
   * 找出已经关联了这个章节的其它节点。
   *
   * 用于阻止两个节点同时指向同一章：那样「这一章要写什么」就有两个答案，
   * 落地的含义被稀释，而作者本人往往意识不到自己挂重了。
   * 一条支线跨多章是正常的，但那是「一个节点 + 多个章节」，
   * 应该用嵌套节点或父子结构表达，而不是让两个节点争夺同一章。
   */
  findByChapterId(chapterId: number, excludeId: number): { id: number; title: string } | null {
    const row = this.db
      .prepare('SELECT id, title FROM outline_nodes WHERE chapter_id = ? AND id <> ? LIMIT 1')
      .get(chapterId, excludeId) as { id: number; title: string } | undefined
    return row ?? null
  }

  /** 某个父节点下的子节点 id，按当前顺序。用于移动时重编号 */
  listIdsByParent(bookId: number, parentId: number | null): number[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM outline_nodes
          WHERE book_id = ? AND parent_id IS ?
          ORDER BY order_index ASC, id ASC`
      )
      .all(bookId, parentId) as { id: number }[]
    return rows.map((row) => row.id)
  }

  /**
   * 追加到某个父节点末尾时的下标。
   *
   * `parent_id IS ?` 而不是 `= ?`：SQLite 的 `=` 遇到 NULL 结果是 NULL（视同假），
   * 用 `=` 查根层节点会永远查不到，表现为「新建的根节点下标永远是 0」。
   */
  nextOrderIndex(bookId: number, parentId: number | null): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(order_index) + 1, 0) AS n FROM outline_nodes
          WHERE book_id = ? AND parent_id IS ?`
      )
      .get(bookId, parentId) as { n: number }
    return toNumber(row.n)
  }

  /** 子孙节点总数（不含自身）。删除前用它提示会影响多少节点 */
  countDescendants(id: number): number {
    const row = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM outline_nodes WHERE parent_id = ?
           UNION ALL
           SELECT o.id FROM outline_nodes o JOIN subtree s ON o.parent_id = s.id
         )
         SELECT COUNT(*) AS n FROM subtree`
      )
      .get(id) as { n: number }
    return toNumber(row.n)
  }

  insert(input: OutlineNodeCreateInput, orderIndex: number, now: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO outline_nodes
           (book_id, parent_id, chapter_id, node_type, title, summary, status, order_index, created_at, updated_at)
         VALUES
           (@bookId, @parentId, NULL, @nodeType, @title, @summary, @status, @orderIndex, @createdAt, @updatedAt)`
      )
      .run({
        bookId: input.bookId,
        parentId: input.parentId,
        nodeType: input.nodeType,
        title: input.title,
        summary: input.summary,
        status: input.status,
        orderIndex,
        createdAt: now,
        updatedAt: now
      })

    return Number(result.lastInsertRowid)
  }

  updateMeta(input: OutlineNodeUpdateInput, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outline_nodes
            SET node_type = @nodeType, title = @title, summary = @summary,
                status = @status, updated_at = @updatedAt
          WHERE id = @id`
      )
      .run({
        id: input.id,
        nodeType: input.nodeType,
        title: input.title,
        summary: input.summary,
        status: input.status,
        updatedAt: now
      })

    return result.changes > 0
  }

  /**
   * 移动节点并重编号。
   *
   * 顺序**完全由数据库的当前状态算出**，不接受调用方提交的兄弟列表 ——
   * 客户端手里的树可能是旧的，并发拖拽时提交上来的顺序会覆盖别人的改动。
   * 调用方只表达「放到谁的下面、第几个」。
   *
   * 这个方法刻意把「源父节点要不要压缩」也自己判断，而不是让服务层传两个
   * 列表进来：那个判断很容易写错（章节移动就先踩过一次 —— 同容器换位时
   * 多压缩了一遍源容器，把目标容器刚编好的下标覆盖回去，产生了重复的
   * order_index）。放在这里只有一处实现，调用方没有机会传错。
   */
  move(id: number, parentId: number | null, targetIndex: number, now: string): boolean {
    const current = this.db
      .prepare('SELECT book_id, parent_id FROM outline_nodes WHERE id = ?')
      .get(id) as { book_id: number; parent_id: number | null } | undefined

    if (!current) return false

    // 目标父节点下除自己以外的顺序，再把自己插到落点
    const targetSiblings = this.listIdsByParent(current.book_id, parentId).filter(
      (siblingId) => siblingId !== id
    )
    const index = Math.max(0, Math.min(targetIndex, targetSiblings.length))
    const nextTarget = [
      ...targetSiblings.slice(0, index),
      id,
      ...targetSiblings.slice(index)
    ]

    this.db
      .prepare('UPDATE outline_nodes SET parent_id = @parentId, updated_at = @updatedAt WHERE id = @id')
      .run({ id, parentId, updatedAt: now })

    const statement = this.db.prepare('UPDATE outline_nodes SET order_index = @orderIndex WHERE id = @id')

    // 上面这一遍已经把目标父节点下的全部兄弟（含自己）编号好了
    nextTarget.forEach((siblingId, position) => {
      statement.run({ orderIndex: position, id: siblingId })
    })

    // 只有换了父节点才需要压缩源：同父节点内换位时，源与目标是同一批节点，
    // 再编一遍只会把上一步的结果覆盖掉
    if (current.parent_id !== parentId) {
      this.listIdsByParent(current.book_id, current.parent_id)
        .filter((siblingId) => siblingId !== id)
        .forEach((siblingId, position) => {
          statement.run({ orderIndex: position, id: siblingId })
        })
    }

    return true
  }

  attachChapter(input: OutlineAttachChapterInput, now: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE outline_nodes SET chapter_id = @chapterId, updated_at = @updatedAt WHERE id = @id'
      )
      .run({ id: input.id, chapterId: input.chapterId, updatedAt: now })

    return result.changes > 0
  }

  deleteById(id: number): boolean {
    // 子节点由 parent_id 的 ON DELETE CASCADE 一并删除；
    // chapters.chapter_id 则是 ON DELETE SET NULL，删章节不会带走大纲节点。
    const result = this.db.prepare('DELETE FROM outline_nodes WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * 校验一批 id 是否都属于同一本书。
   *
   * 移动的目标父节点必须与节点同书，否则会把 A 书的大纲挂到 B 书的树里，
   * 而 B 书的树查询永远查不到它 —— 数据还在，界面里却消失了。
   */
  countMatching(bookId: number, ids: readonly number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM outline_nodes WHERE book_id = ? AND id IN (${placeholders})`)
      .get(bookId, ...ids) as { n: number }
    return toNumber(row.n)
  }
}
