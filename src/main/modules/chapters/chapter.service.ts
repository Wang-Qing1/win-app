import type {
  Chapter,
  ChapterCreateInput,
  ChapterListItem,
  ChapterListQuery,
  ChapterMoveInput,
  ChapterReorderInput,
  ChapterSaveContentInput,
  ChapterSaveResult,
  ChapterUpdateInput
} from '@shared/modules/chapters'
import { CHAPTER_LIMITS } from '@shared/modules/chapters'
import { htmlToText, measureText } from '@shared/text'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { BookRepository } from '../books/book.repository'
import type { VolumeRepository } from '../volumes/volume.repository'
import type { ChapterRepository } from './chapter.repository'

export class ChapterService {
  constructor(
    private readonly repository: ChapterRepository,
    private readonly bookRepository: BookRepository,
    private readonly volumeRepository: VolumeRepository
  ) {}

  list(query: ChapterListQuery): ChapterListItem[] {
    this.assertBookExists(query.bookId)
    if (typeof query.volumeId === 'number') {
      this.assertVolumeInBook(query.volumeId, query.bookId)
    }
    return this.repository.list(query)
  }

  getById(id: number): Chapter {
    const chapter = this.repository.findById(id)
    if (!chapter) {
      throw AppError.notFound(`章节不存在（ID: ${id}）`)
    }
    return chapter
  }

  create(input: ChapterCreateInput): ChapterListItem {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)
      if (input.volumeId !== null) {
        this.assertVolumeInBook(input.volumeId, input.bookId)
      }

      if (this.repository.countByBook(input.bookId) >= CHAPTER_LIMITS.perBook) {
        throw AppError.validation(`单本书的章节数量不能超过 ${CHAPTER_LIMITS.perBook} 章`)
      }

      // 章节标题刻意不强制唯一：多篇「番外」、分上下篇用同名标题
      // 在真实创作里都是合理的，强制唯一只会逼作者加无意义的编号后缀。
      const now = new Date().toISOString()
      const created = this.repository.insert(
        input,
        this.repository.nextOrderIndex(input.bookId, input.volumeId),
        now
      )

      this.bookRepository.touch(input.bookId, now)
      logger.info('章节已创建', { id: created.id, bookId: created.bookId })
      return created
    })
  }

  /**
   * 更新元数据。若同时改变了所属分卷，等价于一次「移动」——
   * 但它应该落到目标容器的末尾，因为用户是在编辑弹窗里改归属，
   * 不是在列表里拖拽，没有落点信息。
   */
  update(input: ChapterUpdateInput): ChapterListItem {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${input.id}）`)
      }

      const targetVolumeId = input.volumeId
      if (targetVolumeId !== null) {
        this.assertVolumeInBook(targetVolumeId, existing.bookId)
      }

      const now = new Date().toISOString()
      const containerChanged = targetVolumeId !== existing.volumeId

      if (containerChanged) {
        const targetIds = this.repository
          .listIdsInContainer(existing.bookId, targetVolumeId)
          .filter((id) => id !== input.id)

        this.repository.applyMove(
          { id: input.id, volumeId: targetVolumeId, targetIndex: targetIds.length },
          // 源容器的重排序列必须在移动**之前**取，且要包含自己——
          // applyMove 内部会把它过滤掉，再合拢剩下的空位
          this.repository.listIdsInContainer(existing.bookId, existing.volumeId),
          [...targetIds, input.id],
          now
        )
      }

      const updated = this.repository.updateMeta(input, now)
      if (!updated) {
        throw AppError.internal(`章节更新失败（ID: ${input.id}）`)
      }

      this.bookRepository.touch(existing.bookId, now)
      logger.info('章节已更新', { id: updated.id, containerChanged })
      return updated
    })
  }

  /**
   * 保存正文。
   *
   * 这是全应用写入最频繁的接口（编辑器自动保存）。三个派生值由主进程
   * 从 HTML 现算，而不是让渲染进程把算好的字数一并送过来——派生数据
   * 只允许有一个产生它的地方，否则迟早出现「正文和字数对不上」的记录。
   */
  saveContent(input: ChapterSaveContentInput): ChapterSaveResult {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${input.id}）`)
      }

      // 只转一次文本：measureHtml 内部也要走一遍 htmlToText，
      // 两者都调用等于把同一份 HTML 解析两次
      const contentText = htmlToText(input.contentHtml)
      const metrics = measureText(contentText)
      const now = new Date().toISOString()

      const saved = this.repository.saveContent(
        input,
        {
          contentText,
          hanziCount: metrics.hanzi,
          charCount: metrics.characters
        },
        now
      )

      if (!saved) {
        throw AppError.internal(`章节正文保存失败（ID: ${input.id}）`)
      }

      // 碰一下书，让书架按「最近写作」排序而不是按创建时间
      this.bookRepository.touch(existing.bookId, now)

      logger.debug('章节正文已保存', {
        id: saved.id,
        hanzi: saved.hanziCount,
        chars: saved.charCount
      })
      return saved
    })
  }

  remove(id: number): { id: number } {
    return runInTransaction(() => {
      const existing = this.repository.findById(id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${id}）`)
      }

      if (!this.repository.deleteById(id)) {
        throw AppError.internal(`章节删除失败（ID: ${id}）`)
      }

      const now = new Date().toISOString()
      // 删掉中间一章后要合拢空位，否则 order_index 出现空洞，
      // 下次拖拽移动时基于顺序的计算会带上这些幽灵下标
      this.reindexContainer(existing.bookId, existing.volumeId, now)
      this.bookRepository.touch(existing.bookId, now)

      logger.info('章节已删除', { id, bookId: existing.bookId })
      return { id }
    })
  }

  reorder(input: ChapterReorderInput): { count: number } {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)
      if (input.volumeId !== null) {
        this.assertVolumeInBook(input.volumeId, input.bookId)
      }

      const total = this.repository.countInContainer(input.bookId, input.volumeId)

      // 与分卷重排同样的约束：必须提交完整顺序，否则未提交的条目保留旧下标，
      // 产生重复的 order_index，最终顺序取决于 SQLite 的返回顺序而变得不确定
      if (input.orderedIds.length !== total) {
        throw AppError.validation('章节顺序提交不完整，请刷新页面后重试')
      }

      const currentIds = new Set(this.repository.listIdsInContainer(input.bookId, input.volumeId))
      const submitted = new Set(input.orderedIds)
      const sameSet =
        currentIds.size === submitted.size && [...currentIds].every((id) => submitted.has(id))
      if (!sameSet) {
        throw AppError.validation('提交的章节与当前列表不匹配，请刷新页面后重试')
      }

      const changed = this.repository.reorder(input, new Date().toISOString())
      logger.info('章节顺序已更新', { bookId: input.bookId, changed })
      return { count: changed }
    })
  }

  /**
   * 把一章移动到另一个容器（或同容器内换位置）。
   *
   * 这是拖拽落点的实现：调用方只给「目标容器 + 目标下标」，
   * 两份新顺序都由服务层基于当前数据库状态算出来，不接受客户端提交顺序——
   * 否则并发拖拽时客户端手里的旧列表会覆盖掉别人的改动。
   */
  move(input: ChapterMoveInput): ChapterListItem {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${input.id}）`)
      }

      if (input.volumeId !== null) {
        this.assertVolumeInBook(input.volumeId, existing.bookId)
      }

      // 目标容器内除自己以外的顺序，然后把自己插到目标下标处
      const targetIds = this.repository
        .listIdsInContainer(existing.bookId, input.volumeId)
        .filter((id) => id !== input.id)

      const targetIndex = Math.max(0, Math.min(input.targetIndex, targetIds.length))
      const nextTargetIds = [
        ...targetIds.slice(0, targetIndex),
        input.id,
        ...targetIds.slice(targetIndex)
      ]

      /*
       * 源容器需要「合拢被抽走留下的空位」—— 但**仅当容器真的换了**。
       *
       * 同容器内换位时不能再压缩一次源：此时 nextTargetIds 已经包含全部兄弟
       * 节点并编号为 0..n-1，若再拿「去掉自己的旧列表」按 0..n-2 编一遍，
       * 就会把它前面那些节点的下标覆盖回去，出现两个相同的 order_index。
       * 结果取决于 SQLite 的返回顺序 —— 把末位节点往前移就会排错。
       * 传空数组表示「源容器没有需要压缩的东西」。
       */
      const sourceIds =
        input.volumeId === existing.volumeId
          ? []
          : this.repository.listIdsInContainer(existing.bookId, existing.volumeId)

      const now = new Date().toISOString()
      this.repository.applyMove(input, sourceIds, nextTargetIds, now)
      this.bookRepository.touch(existing.bookId, now)

      const updated = this.repository.findListItemById(input.id)
      if (!updated) {
        throw AppError.internal(`章节移动后无法回读（ID: ${input.id}）`)
      }

      logger.info('章节已移动', {
        id: updated.id,
        bookId: existing.bookId,
        targetIndex
      })
      return updated
    })
  }

  /* ------------------------------------------------------------------ */

  private reindexContainer(bookId: number, volumeId: number | null, now: string): void {
    const ids = this.repository.listIdsInContainer(bookId, volumeId)
    if (ids.length === 0) return
    this.repository.reorder({ bookId, volumeId, orderedIds: ids }, now)
  }

  private assertBookExists(bookId: number): void {
    if (!this.bookRepository.exists(bookId)) {
      throw AppError.notFound(`书籍不存在（ID: ${bookId}）`)
    }
  }

  private assertVolumeInBook(volumeId: number, bookId: number): void {
    const volume = this.volumeRepository.findById(volumeId)
    if (!volume) {
      throw AppError.notFound(`分卷不存在（ID: ${volumeId}）`)
    }
    // 跨书挂载是典型的越权写入：会让 A 书的章节出现在 B 书的目录里。
    // 校验归属而不是只校验存在，是这类 bug 的唯一防线。
    if (volume.bookId !== bookId) {
      throw AppError.validation('分卷不属于当前书籍，无法挂载章节')
    }
  }
}
