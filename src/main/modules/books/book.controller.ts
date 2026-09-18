import { IpcChannel } from '@shared/ipc-channels'
import {
  bookCreateSchema,
  bookIdSchema,
  bookListQuerySchema,
  bookUpdateSchema,
  normalizeBookListQuery
} from '@shared/modules/books'
import { registerHandler } from '../../core/ipc-handler'
import type { BookService } from './book.service'

/**
 * 控制器层：只做「解析请求 → 调用服务 → 返回结果」。
 * 不含任何业务判断，也不吞异常 —— 异常交给 IPC 边界统一翻译。
 *
 * 「书本不存在」不在这里判断，而是交给服务层：控制器无法知道
 * 当前是查询还是写入语境，只有服务层清楚哪种情况下该抛 NOT_FOUND。
 */
export function registerBookHandlers(service: BookService): void {
  registerHandler(IpcChannel.BooksList, {
    label: '查询书籍列表',
    parse: (raw) => normalizeBookListQuery(bookListQuerySchema.parse(raw ?? {})),
    handle: (query) => service.list(query)
  })

  registerHandler(IpcChannel.BooksGet, {
    label: '查询书籍详情',
    parse: (raw) => bookIdSchema.parse(raw),
    handle: (input) => service.getById(input.id)
  })

  registerHandler(IpcChannel.BooksCreate, {
    label: '新增书籍',
    parse: (raw) => bookCreateSchema.parse(raw),
    handle: (input) => service.create(input)
  })

  registerHandler(IpcChannel.BooksUpdate, {
    label: '更新书籍',
    parse: (raw) => bookUpdateSchema.parse(raw),
    handle: (input) => service.update(input)
  })

  registerHandler(IpcChannel.BooksRemove, {
    label: '删除书籍',
    parse: (raw) => bookIdSchema.parse(raw),
    handle: (input) => service.remove(input.id)
  })

  registerHandler(IpcChannel.BooksStats, {
    label: '查询书籍统计',
    handle: () => service.stats()
  })
}
