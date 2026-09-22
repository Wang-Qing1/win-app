import { IpcChannel } from '@shared/ipc-channels'
import {
  cardLinkCardSchema,
  cardLinkChapterSchema,
  cardLinkNodePairSchema,
  cardLinkNodeSchema,
  cardLinkPairSchema,
  cardRelationBookSchema,
  cardRelationPairSchema,
  cardRelationUnpairSchema
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

  /* ---- 大纲节点侧（第三期） ---- */

  registerHandler(IpcChannel.CardsListNodeLinks, {
    label: '查询卡片关联的大纲节点',
    parse: (raw) => cardLinkCardSchema.parse(raw),
    handle: (input) => service.listNodesByCard(input.cardId)
  })

  registerHandler(IpcChannel.CardsListByNode, {
    label: '查询大纲节点关联的卡片',
    parse: (raw) => cardLinkNodeSchema.parse(raw),
    handle: (input) => service.listByNode(input.nodeId)
  })

  registerHandler(IpcChannel.CardsLinkNode, {
    label: '把卡片关联到大纲节点',
    parse: (raw) => cardLinkNodePairSchema.parse(raw),
    handle: (input) => service.linkNode(input.cardId, input.nodeId)
  })

  registerHandler(IpcChannel.CardsUnlinkNode, {
    label: '解除卡片与大纲节点的关联',
    parse: (raw) => cardLinkNodePairSchema.parse(raw),
    handle: (input) => service.unlinkNode(input.cardId, input.nodeId)
  })

  /* ---- 卡片 ↔ 卡片（第三期第 3 件） ----
   *
   * 关系这一组里，写入的两个通道同样返回「操作之后的完整列表」；
   * `listRelations` 返回的是**被查询那一头**的视角，另一头由前端另失效一次。
   */

  registerHandler(IpcChannel.CardsListRelations, {
    label: '查询这张卡与其它卡的关系',
    parse: (raw) => cardLinkCardSchema.parse(raw),
    handle: (input) => service.listRelations(input.cardId)
  })

  registerHandler(IpcChannel.CardsListBookRelations, {
    label: '查询一本书里的全部关系',
    parse: (raw) => cardRelationBookSchema.parse(raw),
    handle: (input) => service.listRelationsByBook(input.bookId)
  })

  registerHandler(IpcChannel.CardsRelate, {
    label: '建立两张卡之间的关系',
    parse: (raw) => cardRelationPairSchema.parse(raw),
    handle: (input) => service.relate(input.cardId, input.relatedId, input.relation)
  })

  registerHandler(IpcChannel.CardsUnrelate, {
    label: '解除两张卡之间的关系',
    parse: (raw) => cardRelationUnpairSchema.parse(raw),
    handle: (input) => service.unrelate(input.cardId, input.relatedId)
  })
}
