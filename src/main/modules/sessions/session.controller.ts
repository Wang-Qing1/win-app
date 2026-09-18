import { IpcChannel } from '@shared/ipc-channels'
import {
  normalizeSessionListQuery,
  sessionFinishSchema,
  sessionListQuerySchema
} from '@shared/modules/sessions'
import { registerHandler } from '../../core/ipc-handler'
import type { SessionService } from './session.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。 */
export function registerSessionHandlers(service: SessionService): void {
  registerHandler(IpcChannel.SessionsFinish, {
    label: '结算写作会话',
    parse: (raw) => sessionFinishSchema.parse(raw),
    handle: (input) => service.finish(input)
  })

  registerHandler(IpcChannel.SessionsList, {
    label: '查询写作会话',
    parse: (raw) => normalizeSessionListQuery(sessionListQuerySchema.parse(raw ?? {})),
    handle: (query) => service.list(query)
  })
}
