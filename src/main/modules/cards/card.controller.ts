import { IpcChannel } from '@shared/ipc-channels'
import {
  cardCreateSchema,
  cardIdSchema,
  cardListQuerySchema,
  cardUpdateSchema,
  normalizeCardListQuery
} from '@shared/modules/cards'
import { registerHandler } from '../../core/ipc-handler'
import type { CardService } from './card.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。不含业务判断，也不吞异常。 */
export function registerCardHandlers(service: CardService): void {
  registerHandler(IpcChannel.CardsList, {
    label: '查询卡片列表',
    // 与书籍列表同样的两步：先按 schema 收口，再把「范围降级、非法枚举退回默认、
    // 排序白名单」这类解读规则跑一遍。服务层因此只面对一种确定的口径，
    // 「scope 说要看某本书却没给 bookId」之类的组合不会漏到 SQL 里
    parse: (raw) => normalizeCardListQuery(cardListQuerySchema.parse(raw ?? {})),
    handle: (query) => service.list(query)
  })

  registerHandler(IpcChannel.CardsCreate, {
    label: '新建卡片',
    parse: (raw) => cardCreateSchema.parse(raw),
    handle: (input) => service.create(input)
  })

  registerHandler(IpcChannel.CardsUpdate, {
    label: '更新卡片',
    parse: (raw) => cardUpdateSchema.parse(raw),
    handle: (input) => service.update(input)
  })

  registerHandler(IpcChannel.CardsRemove, {
    label: '删除卡片',
    parse: (raw) => cardIdSchema.parse(raw),
    handle: (input) => service.remove(input.id)
  })

  registerHandler(IpcChannel.CardsDuplicate, {
    label: '复制卡片',
    parse: (raw) => cardIdSchema.parse(raw),
    handle: (input) => service.duplicate(input.id)
  })
}
