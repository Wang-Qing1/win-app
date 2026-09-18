import type { SessionFinishInput, SessionListQuery, WritingSession } from '@shared/modules/sessions'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { BookRepository } from '../books/book.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'
import type { SessionRepository } from './session.repository'

/**
 * 写作会话服务。
 *
 * 会话由渲染进程在编辑器里采集（进入编辑 → 空闲 90 秒或离开），
 * 结算后通过一次 IPC 调用落库。服务层在这里做的是「让这条记录尽量能存下来」，
 * 而不是严格拒绝——写作时长是既成事实，不该因为用户刚好删掉了那本书就丢失。
 */
export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly bookRepository: BookRepository,
    private readonly chapterRepository: ChapterRepository
  ) {}

  finish(input: SessionFinishInput): WritingSession {
    return runInTransaction(() => {
      // 归属对象可能在会话进行期间被删除（用户写着写着把书删了）。
      // 这种情况下把外键置空而不是抛错：外键约束会直接拒绝插入，
      // 于是整段写作时长凭空消失，而这恰恰是统计模块最不该丢的数据。
      const bookId = input.bookId !== null && this.bookRepository.exists(input.bookId) ? input.bookId : null
      const chapterId =
        input.chapterId !== null && this.chapterRepository.exists(input.chapterId)
          ? input.chapterId
          : null

      if (bookId !== input.bookId || chapterId !== input.chapterId) {
        logger.warn('写作会话的归属对象已不存在，已置空后保存', {
          bookId: input.bookId,
          chapterId: input.chapterId
        })
      }

      const session = this.repository.insert({ ...input, bookId, chapterId })

      logger.debug('写作会话已结算', {
        id: session.id,
        durationSeconds: session.durationSeconds,
        wordsWritten: session.wordsWritten,
        wordsNet: session.wordsNet
      })

      return session
    })
  }

  list(query: SessionListQuery): WritingSession[] {
    return this.repository.list(query)
  }
}
