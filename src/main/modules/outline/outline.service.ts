import {
  OUTLINE_LIMITS,
  OUTLINE_NODE_TYPES,
  OUTLINE_STATUSES,
  type OutlineAttachChapterInput,
  type OutlineMaterializeInput,
  type OutlineMaterializeResult,
  type OutlineNode,
  type OutlineNodeCreateInput,
  type OutlineNodeMoveInput,
  type OutlineNodeType,
  type OutlineNodeUpdateInput,
  type OutlineStatus,
  type OutlineTreeNode,
  type OutlineTreeResult
} from '@shared/modules/outline'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { BookRepository } from '../books/book.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'
import type { ChapterService } from '../chapters/chapter.service'
import {
  toChapterStatus,
  toOutlineNode,
  type OutlineNodeRow,
  type OutlineRepository
} from './outline.repository'

export interface OutlineRemovalResult {
  id: number
  /** 连同子节点一起被删除的节点总数（含自身）。文案里要提示用户 */
  removedCount: number
}

/**
 * 树的索引。一次查询换两份映射，避免同一棵树被反复取回。
 *
 * `parentOf` 用于「往上走」的判断（环检测、算层数），
 * `childrenOf` 用于「往下走」的判断（算子树的自身高度）。
 */
interface OutlineIndex {
  parentOf: Map<number, number | null>
  childrenOf: Map<number, number[]>
}

export class OutlineService {
  constructor(
    private readonly repository: OutlineRepository,
    private readonly bookRepository: BookRepository,
    private readonly chapterRepository: ChapterRepository,
    /**
     * 「落地成章节」复用章节服务，而不是自己往 chapters 表插一行。
     * 章节创建的规则（标题处理、字数初始化、分卷归属校验、书籍 touch）
     * 都在那里，另写一份迟早会与它漂移。
     */
    private readonly chapterService: ChapterService
  ) {}

  /* ------------------------------------------------------------------ *
   * 读
   * ------------------------------------------------------------------ */

  tree(bookId: number): OutlineTreeResult {
    this.assertBookExists(bookId)

    const rows = this.repository.listByBook(bookId)
    const { nodes, depth } = this.buildTree(rows)

    const statusCounts = emptyStatusCounts()
    const typeCounts = emptyTypeCounts()
    let landedCount = 0

    for (const row of rows) {
      const node = toOutlineNode(row)
      statusCounts[node.status] += 1
      typeCounts[node.nodeType] += 1
      if (node.chapterId !== null) landedCount += 1
    }

    return {
      bookId,
      nodes,
      total: rows.length,
      depth,
      statusCounts,
      typeCounts,
      landedCount
    }
  }

  /* ------------------------------------------------------------------ *
   * 写
   * ------------------------------------------------------------------ */

  create(input: OutlineNodeCreateInput): OutlineNode {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)

      if (this.repository.countByBook(input.bookId) >= OUTLINE_LIMITS.perBook) {
        throw AppError.validation(`单本书的大纲节点不能超过 ${OUTLINE_LIMITS.perBook} 个`)
      }

      const index = this.loadIndex(input.bookId)

      if (input.parentId !== null && !index.parentOf.has(input.parentId)) {
        throw AppError.validation('父节点不存在或不属于当前书籍')
      }

      // 新建的节点自身没有子树，所以只需要看「父节点层数 + 1」
      const depth = input.parentId === null ? 1 : this.depthOf(input.parentId, index.parentOf) + 1
      if (depth > OUTLINE_LIMITS.depth) {
        throw AppError.validation(
          `大纲最多 ${OUTLINE_LIMITS.depth} 层，不能再往下了。请先把节点移到一个更浅的位置`
        )
      }

      const now = new Date().toISOString()
      const id = this.repository.insert(
        input,
        this.repository.nextOrderIndex(input.bookId, input.parentId),
        now
      )

      const created = this.repository.findById(id)
      if (!created) {
        throw AppError.internal(`新增大纲节点后无法回读记录（ID: ${id}）`)
      }

      logger.info('大纲节点已创建', { id, bookId: input.bookId, parentId: input.parentId, depth })
      return toOutlineNode(created)
    })
  }

  update(input: OutlineNodeUpdateInput): OutlineNode {
    return runInTransaction(() => {
      if (!this.repository.findById(input.id)) {
        throw AppError.notFound(`大纲节点不存在（ID: ${input.id}）`)
      }

      if (!this.repository.updateMeta(input, new Date().toISOString())) {
        throw AppError.internal(`大纲节点更新失败（ID: ${input.id}）`)
      }

      const updated = this.repository.findById(input.id)
      if (!updated) {
        throw AppError.internal(`大纲节点更新后无法回读（ID: ${input.id}）`)
      }

      logger.info('大纲节点已更新', { id: input.id })
      return toOutlineNode(updated)
    })
  }

  remove(id: number): OutlineRemovalResult {
    return runInTransaction(() => {
      if (!this.repository.findById(id)) {
        throw AppError.notFound(`大纲节点不存在（ID: ${id}）`)
      }

      // 子节点由外键级联删除。先数清楚是为了让调用方能提示
      // 「将同时删除 N 个子节点」—— 删一棵长了两层的支线不该毫无预警。
      const removedCount = 1 + this.repository.countDescendants(id)

      if (!this.repository.deleteById(id)) {
        throw AppError.internal(`大纲节点删除失败（ID: ${id}）`)
      }

      logger.info('大纲节点已删除', { id, removedCount })
      return { id, removedCount }
    })
  }

  /**
   * 移动节点（拖拽落点的实现）。
   *
   * 这里是**自由树最容易出错的地方**：节点的父指针可以指向任意节点，
   * 于是「把 A 拖到 A 的子孙之下」这种操作天然可表达，一旦放过去，
   * 树上就出现一个环 —— 从任何根节点都走不到它（节点凭空消失），
   * 而递归渲染这类结构会直接爆栈。所以环检测是硬约束，不是优化。
   *
   * 深度上限同理：不设限的话拖拽误操作能造出几百层嵌套。
   */
  move(input: OutlineNodeMoveInput): OutlineNode {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`大纲节点不存在（ID: ${input.id}）`)
      }

      const node = toOutlineNode(existing)
      const index = this.loadIndex(node.bookId)

      if (input.parentId !== null && !index.parentOf.has(input.parentId)) {
        throw AppError.validation('目标父节点不存在或不属于当前书籍')
      }

      this.assertNoCycle(node.id, input.parentId, index.parentOf)

      // 移动后的最大层数 = 目标父节点的层数 + 被移动子树自身的层数
      const subtreeHeight = this.subtreeHeight(node.id, index.childrenOf)
      const parentDepth = input.parentId === null ? 0 : this.depthOf(input.parentId, index.parentOf)
      const newDepth = parentDepth + subtreeHeight

      if (newDepth > OUTLINE_LIMITS.depth) {
        throw AppError.validation(
          `移动后最深会到 ${newDepth} 层，超过上限 ${OUTLINE_LIMITS.depth} 层。请先减少这段的嵌套`
        )
      }

      const now = new Date().toISOString()
      if (!this.repository.move(node.id, input.parentId, input.targetIndex, now)) {
        throw AppError.internal(`大纲节点移动失败（ID: ${node.id}）`)
      }

      const updated = this.repository.findById(node.id)
      if (!updated) {
        throw AppError.internal(`大纲节点移动后无法回读（ID: ${node.id}）`)
      }

      logger.info('大纲节点已移动', {
        id: node.id,
        bookId: node.bookId,
        parentId: input.parentId,
        targetIndex: input.targetIndex
      })
      return toOutlineNode(updated)
    })
  }

  attachChapter(input: OutlineAttachChapterInput): OutlineNode {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`大纲节点不存在（ID: ${input.id}）`)
      }

      const node = toOutlineNode(existing)

      if (input.chapterId !== null) {
        const chapter = this.chapterRepository.findListItemById(input.chapterId)
        if (!chapter) {
          throw AppError.notFound(`章节不存在（ID: ${input.chapterId}）`)
        }

        // 跨书关联和跨书挂载分卷是同一类越权写入：
        // 会让 A 书的章节出现在 B 书的大纲里
        if (chapter.bookId !== node.bookId) {
          throw AppError.validation('该章节不属于当前书籍，无法关联到大纲')
        }

        const occupied = this.repository.findByChapterId(input.chapterId, node.id)
        if (occupied) {
          throw AppError.conflict(`这一章已经关联到节点「${occupied.title}」，请先解除那边的关联`)
        }
      }

      if (!this.repository.attachChapter(input, new Date().toISOString())) {
        throw AppError.internal(`关联章节失败（节点 ID: ${input.id}）`)
      }

      const updated = this.repository.findById(input.id)
      if (!updated) {
        throw AppError.internal(`关联章节后无法回读节点（ID: ${input.id}）`)
      }

      logger.info('大纲节点关联章节已更新', { id: input.id, chapterId: input.chapterId })
      return toOutlineNode(updated)
    })
  }

  /**
   * 把节点落地成**新章节**。
   *
   * 这是「大纲 → 成稿」的关键一步：作者在树上想清楚了要写什么，
   * 一键就能带着标题进入正文编辑。落地后 `chapterId` 双向打通，
   * 树上会显示章节标题，点一下跳进编辑器。
   */
  materialize(input: OutlineMaterializeInput): OutlineMaterializeResult {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`大纲节点不存在（ID: ${input.id}）`)
      }

      const node = toOutlineNode(existing)

      if (node.chapterId !== null) {
        const current = this.chapterRepository.findListItemById(node.chapterId)
        throw AppError.conflict(
          `该节点已经落地到《${current?.title ?? `章节 ${node.chapterId}`}》。` +
            '若要重新落地，请先解除现有章节的关联。'
        )
      }

      const chapter = this.chapterService.create({
        bookId: node.bookId,
        volumeId: input.volumeId,
        title: node.title,
        targetWords: input.targetWords
      })

      if (
        !this.repository.attachChapter(
          { id: node.id, chapterId: chapter.id },
          new Date().toISOString()
        )
      ) {
        throw AppError.internal(`落地后关联章节失败（节点 ID: ${node.id}）`)
      }

      logger.info('大纲节点已落地成章节', {
        nodeId: node.id,
        chapterId: chapter.id,
        bookId: node.bookId
      })

      return { nodeId: node.id, chapterId: chapter.id, chapterTitle: chapter.title }
    })
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  private assertBookExists(bookId: number): void {
    if (!this.bookRepository.exists(bookId)) {
      throw AppError.notFound(`书籍不存在（ID: ${bookId}）`)
    }
  }

  private loadIndex(bookId: number): OutlineIndex {
    const parentOf = new Map<number, number | null>()
    const childrenOf = new Map<number, number[]>()

    for (const row of this.repository.listByBook(bookId)) {
      parentOf.set(row.id, row.parent_id)
      if (row.parent_id === null) continue

      const bucket = childrenOf.get(row.parent_id)
      if (bucket) bucket.push(row.id)
      else childrenOf.set(row.parent_id, [row.id])
    }

    return { parentOf, childrenOf }
  }

  /**
   * 节点层数（根层为 1）。
   *
   * 带 seen 集合：数据里若已经存在环（手工改库造成），
   * 顺着父指针往上走会转圈，这里必须能自己停下来。
   */
  private depthOf(id: number, parentOf: Map<number, number | null>): number {
    let depth = 1
    let cursor = parentOf.get(id) ?? null
    const seen = new Set<number>([id])

    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor)
      depth += 1
      cursor = parentOf.get(cursor) ?? null
    }

    return depth
  }

  /**
   * 环检测：把节点挂到 `newParentId` 之下，会不会形成环？
   *
   * 做法是从候选父节点**往上**走父指针，如果能走回自己，说明候选父节点
   * 就在自己的子树里。比「往下遍历自己的子树找候选父节点」便宜得多，
   * 复杂度只跟深度有关，而深度有上限。
   */
  private assertNoCycle(
    id: number,
    newParentId: number | null,
    parentOf: Map<number, number | null>
  ): void {
    if (newParentId === null) return

    let cursor: number | null = newParentId
    const seen = new Set<number>()

    while (cursor !== null) {
      if (cursor === id) {
        throw AppError.validation('不能把节点移动到它自己或它自己的子节点之下，那样会在树上形成环')
      }
      if (seen.has(cursor)) return
      seen.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
  }

  /**
   * 子树的自身层数（叶子为 1）。
   *
   * 用逐层展开而不是递归：递归实现遇到环会爆栈，
   * 而这里要处理的对象恰恰可能是坏数据。
   */
  private subtreeHeight(rootId: number, childrenOf: Map<number, number[]>): number {
    let height = 0
    let frontier: number[] = [rootId]
    const seen = new Set<number>()

    while (frontier.length > 0) {
      height += 1
      const next: number[] = []

      for (const current of frontier) {
        if (seen.has(current)) continue
        seen.add(current)
        const children = childrenOf.get(current)
        if (children) next.push(...children)
      }

      frontier = next
    }

    return height
  }

  /**
   * 平铺的行 → 树。
   *
   * 两个防御点，都针对「数据里有环」这种只可能来自手工改库的状态：
   *
   * 1. 遍历带 visited 集合，重复访问的节点不再展开 —— 否则递归会无限下去。
   * 2. 环上的节点从任何根都走不到，会整个从界面上消失（数据在却看不见，
   *    比顺序不对更难排查）。所以遍历结束后把没访问到的节点提升到根层，
   *    让用户至少能看到它并手动整理。
   */
  private buildTree(rows: OutlineNodeRow[]): { nodes: OutlineTreeNode[]; depth: number } {
    const nodes = new Map<number, OutlineTreeNode>()

    for (const row of rows) {
      nodes.set(row.id, {
        ...toOutlineNode(row),
        children: [],
        chapterTitle: row.chapter_title,
        chapterStatus: toChapterStatus(row.chapter_status),
        descendantCount: 0
      })
    }

    const roots: OutlineTreeNode[] = []

    for (const row of rows) {
      const node = nodes.get(row.id)
      if (!node) continue

      const parent = row.parent_id === null ? undefined : nodes.get(row.parent_id)
      if (parent === undefined) {
        // 根层节点，或父节点不在本书里（脏数据）—— 后者也当根层显示
        roots.push(node)
      } else {
        parent.children.push(node)
      }
    }

    const visited = new Set<number>()
    let depth = 0

    const walk = (node: OutlineTreeNode, level: number): number => {
      if (visited.has(node.id)) return 0
      visited.add(node.id)
      if (level > depth) depth = level

      let total = 0
      for (const child of node.children) {
        total += walk(child, level + 1) + 1
      }
      node.descendantCount = total
      return total
    }

    const ordered: OutlineTreeNode[] = []
    for (const root of roots) {
      if (visited.has(root.id)) continue
      ordered.push(root)
      walk(root, 1)
    }

    for (const row of rows) {
      if (visited.has(row.id)) continue
      const orphan = nodes.get(row.id)
      if (!orphan) continue
      logger.warn('大纲存在从根节点无法到达的节点，已提升到根层显示', {
        id: row.id,
        bookId: row.book_id,
        parentId: row.parent_id
      })
      ordered.push(orphan)
      walk(orphan, 1)
    }

    return { nodes: ordered, depth }
  }
}

function emptyTypeCounts(): Record<OutlineNodeType, number> {
  const counts = {} as Record<OutlineNodeType, number>
  for (const type of OUTLINE_NODE_TYPES) counts[type] = 0
  return counts
}

function emptyStatusCounts(): Record<OutlineStatus, number> {
  const counts = {} as Record<OutlineStatus, number>
  for (const status of OUTLINE_STATUSES) counts[status] = 0
  return counts
}
