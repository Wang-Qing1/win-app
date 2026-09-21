import { IpcChannel } from '@shared/ipc-channels'
import {
  cardLinkCardSchema,
  cardLinkChapterSchema,
  cardLinkPairSchema
} from '@shared/modules/card-links'
import { registerHandler } from '../../core/ipc-handler'
import type { CardLinkService } from './card-link.service'

/**
 * 控制器层：解析请求 → 调用服务 → 返回结果。
 *
 * 每个通道都返回「操作之后的完整关联列表」而不是受影响的行数或单个对象：
 * 渲染进程拿着返回值直接替换本地状态即可，省掉一次往返，
 * 也省掉一处「点了按钮、列表却还是旧的」的时序问题。
 */
export function registerCardLinkHandlers(service: CardLinkService): void {
  registerHandler(IpcChannel.CardsListLinks, {
    label: '查询卡片关联的章节',
    parse: (raw) => cardLinkCardSchema.parse(raw),
    handle: (input) => service.listByCard(input.cardId)
  })

  registerHandler(IpcChannel.CardsListByChapter, {
    label: '查询章节关联的卡片',
    parse: (raw) => cardLinkChapterSchema.parse(raw),
    handle: (input) => service.listByChapter(input.chapterId)
  })

  registerHandler(IpcChannel.CardsLinkChapter, {
    label: '把卡片关联到章节',
    parse: (raw) => cardLinkPairSchema.parse(raw),
    handle: (input) => service.link(input.cardId, input.chapterId)
  })

  registerHandler(IpcChannel.CardsUnlinkChapter, {
    label: '解除卡片与章节的关联',
    parse: (raw) => cardLinkPairSchema.parse(raw),
    handle: (input) => service.unlink(input.cardId, input.chapterId)
  })
}
