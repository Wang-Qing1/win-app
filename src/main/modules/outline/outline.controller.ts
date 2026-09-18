import { IpcChannel } from '@shared/ipc-channels'
import {
  outlineAttachChapterSchema,
  outlineMaterializeSchema,
  outlineNodeCreateSchema,
  outlineNodeIdSchema,
  outlineNodeMoveSchema,
  outlineNodeUpdateSchema,
  outlineTreeQuerySchema
} from '@shared/modules/outline'
import { registerHandler } from '../../core/ipc-handler'
import type { OutlineService } from './outline.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。不含业务判断，也不吞异常。 */
export function registerOutlineHandlers(service: OutlineService): void {
  registerHandler(IpcChannel.OutlineTree, {
    label: '查询大纲树',
    parse: (raw) => outlineTreeQuerySchema.parse(raw),
    handle: (input) => service.tree(input.bookId)
  })

  registerHandler(IpcChannel.OutlineCreate, {
    label: '新增大纲节点',
    parse: (raw) => outlineNodeCreateSchema.parse(raw),
    handle: (input) => service.create(input)
  })

  registerHandler(IpcChannel.OutlineUpdate, {
    label: '更新大纲节点',
    parse: (raw) => outlineNodeUpdateSchema.parse(raw),
    handle: (input) => service.update(input)
  })

  registerHandler(IpcChannel.OutlineRemove, {
    label: '删除大纲节点',
    parse: (raw) => outlineNodeIdSchema.parse(raw),
    handle: (input) => service.remove(input.id)
  })

  registerHandler(IpcChannel.OutlineMove, {
    label: '移动大纲节点',
    parse: (raw) => outlineNodeMoveSchema.parse(raw),
    handle: (input) => service.move(input)
  })

  registerHandler(IpcChannel.OutlineAttachChapter, {
    label: '关联大纲节点与章节',
    parse: (raw) => outlineAttachChapterSchema.parse(raw),
    handle: (input) => service.attachChapter(input)
  })

  registerHandler(IpcChannel.OutlineMaterialize, {
    label: '大纲节点落地成章节',
    parse: (raw) => outlineMaterializeSchema.parse(raw),
    handle: (input) => service.materialize(input)
  })
}
