import { IpcChannel } from '@shared/ipc-channels'
import {
  volumeCreateSchema,
  volumeIdSchema,
  volumeListQuerySchema,
  volumeReorderSchema,
  volumeUpdateSchema
} from '@shared/modules/volumes'
import { registerHandler } from '../../core/ipc-handler'
import type { VolumeService } from './volume.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。不含业务判断，也不吞异常。 */
export function registerVolumeHandlers(service: VolumeService): void {
  registerHandler(IpcChannel.VolumesList, {
    label: '查询分卷列表',
    parse: (raw) => volumeListQuerySchema.parse(raw),
    handle: (input) => service.list(input.bookId)
  })

  registerHandler(IpcChannel.VolumesCreate, {
    label: '新增分卷',
    parse: (raw) => volumeCreateSchema.parse(raw),
    handle: (input) => service.create(input)
  })

  registerHandler(IpcChannel.VolumesUpdate, {
    label: '更新分卷',
    parse: (raw) => volumeUpdateSchema.parse(raw),
    handle: (input) => service.update(input)
  })

  registerHandler(IpcChannel.VolumesRemove, {
    label: '删除分卷',
    parse: (raw) => volumeIdSchema.parse(raw),
    handle: (input) => service.remove(input.id)
  })

  registerHandler(IpcChannel.VolumesReorder, {
    label: '调整分卷顺序',
    parse: (raw) => volumeReorderSchema.parse(raw),
    handle: (input) => service.reorder(input)
  })
}
