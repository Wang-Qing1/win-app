import type {
  Book,
  BookCreateInput,
  BookListQuery,
  BookListResult,
  BookRemovalResult,
  BookStats,
  BookUpdateInput
} from '@shared/modules/books'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { Db } from '../../db/types'
import { toNumber } from '../../db/sql-utils'
import type { BookRepository } from './book.repository'

/**
 * 服务层：承载业务规则与事务边界。
 *
 * 刻意不依赖任何 Electron / IPC 类型 —— 因此可以直接用真实数据库做集成测试，
 * 也可以在将来挂到别的传输层（HTTP、CLI）上而不用改一行代码。
 */
export class BookService {
  constructor(
    private readonly repository: BookRepository,
    private readonly db: Db
  ) {}

  list(query: BookListQuery): BookListResult {
    return this.repository.list(query)
  }

  getById(id: number): Book {
    const book = this.repository.findById(id)
    if (!book) {
      throw AppError.notFound(`书籍不存在（ID: ${id}）`)
    }
    return book
  }

  create(input: BookCreateInput): Book {
    return runInTransaction(() => {
      if (this.repository.findByTitle(input.title)) {
        throw AppError.conflict(`已存在同名书籍「${input.title}」，请换一个书名`)
      }

      const created = this.repository.insert(input, new Date().toISOString())
      logger.info('书籍已创建', { id: created.id })
      return created
    })
  }

  update(input: BookUpdateInput): Book {
    return runInTransaction(() => {
      if (!this.repository.exists(input.id)) {
        throw AppError.notFound(`书籍不存在（ID: ${input.id}）`)
      }

      if (this.repository.findByTitle(input.title, input.id)) {
        throw AppError.conflict(`已存在同名书籍「${input.title}」，请换一个书名`)
      }

      const updated = this.repository.update(input, new Date().toISOString())
      if (!updated) {
        throw AppError.internal(`书籍更新失败（ID: ${input.id}）`)
      }

      logger.info('书籍已更新', { id: updated.id })
      return updated
    })
  }

  remove(id: number): BookRemovalResult {
    return runInTransaction(() => {
      const existing = this.repository.findById(id)
      if (!existing) {
        throw AppError.notFound(`书籍不存在（ID: ${id}）`)
      }

      // 先数一遍将要连带删除的章节数，删完就查不到了。
      // 这个数字会出现在确认提示里 —— 「删掉一本书」和「删掉一本书的 128 章」
      // 是完全不同量级的操作，用户有权在动手前看到。
      const chapterRow = this.db
        .prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?')
        .get(id) as { n: number }
      const removedChapters = toNumber(chapterRow.n)

      if (!this.repository.deleteById(id)) {
        throw AppError.internal(`书籍删除失败（ID: ${id}）`)
      }

      // 不记录书名：日志里只留 id，避免把用户的创作内容写进日志文件
      logger.info('书籍已删除', { id, removedChapters })
      return { id, title: existing.title, removedChapters }
    })
  }

  stats(): BookStats {
    return this.repository.stats()
  }
}
