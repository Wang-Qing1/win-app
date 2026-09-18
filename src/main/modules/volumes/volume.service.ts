import type {
  Volume,
  VolumeCreateInput,
  VolumeListItem,
  VolumeReorderInput,
  VolumeUpdateInput
} from '@shared/modules/volumes'
import { VOLUME_LIMITS } from '@shared/modules/volumes'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { BookRepository } from '../books/book.repository'
import type { VolumeRepository } from './volume.repository'

export interface VolumeRemovalResult {
  id: number
  /** 因这次删除而退回「未分卷」的章节数 */
  detachedChapters: number
}

export class VolumeService {
  constructor(
    private readonly repository: VolumeRepository,
    private readonly bookRepository: BookRepository
  ) {}

  list(bookId: number): VolumeListItem[] {
    this.assertBookExists(bookId)
    return this.repository.listByBook(bookId)
  }

  getById(id: number): Volume {
    const volume = this.repository.findById(id)
    if (!volume) {
      throw AppError.notFound(`分卷不存在（ID: ${id}）`)
    }
    return volume
  }

  create(input: VolumeCreateInput): VolumeListItem {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)

      if (this.repository.findByTitle(input.bookId, input.title)) {
        throw AppError.conflict(`本书已有名为「${input.title}」的分卷`)
      }

      if (this.repository.countByBook(input.bookId) >= VOLUME_LIMITS.perBook) {
        throw AppError.validation(`单本书的分卷数量不能超过 ${VOLUME_LIMITS.perBook} 个`)
      }

      const created = this.repository.insert(
        input,
        this.repository.nextOrderIndex(input.bookId),
        new Date().toISOString()
      )
      logger.info('分卷已创建', { id: created.id, bookId: created.bookId })

      // 回读一次以带上聚合字段，保证返回类型与列表接口一致
      return this.toListItem(created)
    })
  }

  update(input: VolumeUpdateInput): VolumeListItem {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`分卷不存在（ID: ${input.id}）`)
      }

      if (this.repository.findByTitle(existing.bookId, input.title, input.id)) {
        throw AppError.conflict(`本书已有名为「${input.title}」的分卷`)
      }

      const updated = this.repository.update(input, new Date().toISOString())
      if (!updated) {
        throw AppError.internal(`分卷更新失败（ID: ${input.id}）`)
      }

      logger.info('分卷已更新', { id: updated.id })
      return this.toListItem(updated)
    })
  }

  remove(id: number): VolumeRemovalResult {
    return runInTransaction(() => {
      if (!this.repository.findById(id)) {
        throw AppError.notFound(`分卷不存在（ID: ${id}）`)
      }

      const detachedChapters = this.repository.countChapters(id)
      if (!this.repository.deleteById(id)) {
        throw AppError.internal(`分卷删除失败（ID: ${id}）`)
      }

      logger.info('分卷已删除', { id, detachedChapters })
      return { id, detachedChapters }
    })
  }

  reorder(input: VolumeReorderInput): { bookId: number } {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)

      const total = this.repository.countByBook(input.bookId)

      // 必须提交完整顺序：只提交一部分会让没提交的卷保留下标，
      // 于是出现重复的 order_index，排序结果取决于 SQLite 的返回顺序而变得随机。
      if (input.orderedIds.length !== total) {
        throw AppError.validation('分卷顺序提交不完整，请刷新页面后重试')
      }

      if (this.repository.countMatching(input.bookId, input.orderedIds) !== total) {
        throw AppError.validation('提交的分卷与本书不匹配，请刷新页面后重试')
      }

      const changed = this.repository.reorder(
        input.bookId,
        input.orderedIds,
        new Date().toISOString()
      )
      logger.info('分卷顺序已更新', { bookId: input.bookId, changed })

      return { bookId: input.bookId }
    })
  }

  private assertBookExists(bookId: number): void {
    if (!this.bookRepository.exists(bookId)) {
      throw AppError.notFound(`书籍不存在（ID: ${bookId}）`)
    }
  }

  private toListItem(volume: Volume): VolumeListItem {
    const match = this.repository.findListItemById(volume.id)
    if (!match) {
      throw AppError.internal(`分卷写入后无法回读（ID: ${volume.id}）`)
    }
    return match
  }
}
