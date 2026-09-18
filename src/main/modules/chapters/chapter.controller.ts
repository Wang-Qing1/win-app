import { IpcChannel } from '@shared/ipc-channels'
import {
  chapterCreateSchema,
  chapterIdSchema,
  chapterListQuerySchema,
  chapterMoveSchema,
  chapterReorderSchema,
  chapterSaveContentSchema,
  chapterUpdateSchema,
  normalizeChapterListQuery
} from '@shared/modules/chapters'
import { registerHandler } from '../../core/ipc-handler'
import type { ChapterService } from './chapter.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。不含业务判断，也不吞异常。 */
export function registerChapterHandlers(service: ChapterService): void {
  registerHandler(IpcChannel.ChaptersList, {
    label: '查询章节列表',
    parse: (raw) => normalizeChapterListQuery(chapterListQuerySchema.parse(raw)),
    handle: (query) => service.list(query)
  })

  registerHandler(IpcChannel.ChaptersGet, {
    label: '查询章节详情',
    parse: (raw) => chapterIdSchema.parse(raw),
    handle: (input) => service.getById(input.id)
  })

  registerHandler(IpcChannel.ChaptersCreate, {
    label: '新增章节',
    parse: (raw) => chapterCreateSchema.parse(raw),
    handle: (input) => service.create(input)
  })

  registerHandler(IpcChannel.ChaptersUpdate, {
    label: '更新章节',
    parse: (raw) => chapterUpdateSchema.parse(raw),
    handle: (input) => service.update(input)
  })

  registerHandler(IpcChannel.ChaptersSaveContent, {
    label: '保存章节正文',
    parse: (raw) => chapterSaveContentSchema.parse(raw),
    handle: (input) => service.saveContent(input)
  })

  registerHandler(IpcChannel.ChaptersRemove, {
    label: '删除章节',
    parse: (raw) => chapterIdSchema.parse(raw),
    handle: (input) => service.remove(input.id)
  })

  registerHandler(IpcChannel.ChaptersReorder, {
    label: '调整章节顺序',
    parse: (raw) => chapterReorderSchema.parse(raw),
    handle: (input) => service.reorder(input)
  })

  registerHandler(IpcChannel.ChaptersMove, {
    label: '移动章节',
    parse: (raw) => chapterMoveSchema.parse(raw),
    handle: (input) => service.move(input)
  })
}
