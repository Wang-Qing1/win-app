import { IpcChannel } from '@shared/ipc-channels'
import {
  normalizeTrashList,
  trashEmptySchema,
  trashItemSchema,
  trashListSchema
} from '@shared/modules/trash'
import { registerHandler } from '../../core/ipc-handler'
import type { TrashService } from './trash.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。不含业务判断，也不吞异常。 */
export function registerTrashHandlers(service: TrashService): void {
  registerHandler(IpcChannel.TrashList, {
    label: '查看回收站',
    // 与卡片列表同样的两步：先按 schema 收口，再把「非法枚举降级为不筛选」
    // 这条解读规则跑一遍。只读操作降级只会多列几行，不会造成损害
    parse: (raw) => normalizeTrashList(trashListSchema.parse(raw ?? {})),
    handle: (input) => service.list(input)
  })

  registerHandler(IpcChannel.TrashRestore, {
    label: '从回收站恢复',
    // 恢复与彻底删除走**严格**校验：kind 写错时若被悄悄解读成另一种，
    // 动作就会落到错误的实体上（拿章节 id 去删卡片 —— 运气好是
    // NOT_FOUND，运气不好删掉一张同号的卡）。写操作一律在边界拒绝非法值
    parse: (raw) => trashItemSchema.parse(raw),
    handle: (input) => service.restore(input)
  })

  registerHandler(IpcChannel.TrashPurge, {
    label: '彻底删除回收站条目',
    parse: (raw) => trashItemSchema.parse(raw),
    handle: (input) => service.purge(input)
  })

  registerHandler(IpcChannel.TrashEmpty, {
    label: '清空回收站',
    parse: (raw) => trashEmptySchema.parse(raw ?? {}),
    handle: (input) => service.empty(input)
  })
}
