import { useMemo } from 'react'
import { Flex, Select, Tag, Typography } from 'antd'
import { DisconnectOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router'
import { CARD_TYPE_LABELS, DEFAULT_CARD_QUERY } from '@shared/modules/cards'
import { IconButton } from '../../components/IconButton'
import { withOrigin } from '../../components/OriginReturn'
import { useToast } from '../../components/Toast'
import { CARD_TYPE_COLORS } from './card-meta'
import { useCardList } from './use-cards'
import { useLinkCardNode, useOutlineNodeCards, useUnlinkCardNode } from './use-card-links'

const { Text } = Typography

interface OutlineNodeCardRefsProps {
  nodeId: number | null
  /** 只列出这本书的卡片：跨书的关联没有意义，服务层也会拒 */
  bookId: number
}

/**
 * 「这个情节节点准备用到哪几条设定」—— 卡片 ↔ 大纲节点关联的另一个方向。
 *
 * 与章节侧那块是同一套机制、不同的回答：章节侧回答「用上了没有」，
 * 这里回答「打算用哪几条」。写作顺序上它通常先发生 ——
 * 情节还在构想阶段，设定就已经挂在节点上了。
 *
 * nodeId 允许为 null（还没选中节点）：此时不查询也不报错，
 * 省得调用方每个分支都写一遍判空。
 */
export function OutlineNodeCardRefs({ nodeId, bookId }: OutlineNodeCardRefsProps) {
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const refs = useOutlineNodeCards(nodeId)
  const cards = useCardList(
    useMemo(() => ({ ...DEFAULT_CARD_QUERY, bookScope: 'book' as const, bookId }), [bookId])
  )
  const linkNode = useLinkCardNode()
  const unlinkNode = useUnlinkCardNode()

  const linkedIds = useMemo(() => new Set((refs.data ?? []).map((item) => item.cardId)), [refs.data])

  const options = useMemo(
    () =>
      (cards.data?.items ?? [])
        .filter((card) => !linkedIds.has(card.id))
        .map((card) => ({
          value: card.id,
          label: `${card.title}（${CARD_TYPE_LABELS[card.cardType]}）`
        })),
    [cards.data, linkedIds]
  )

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      toast.notifyError(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <Flex vertical gap={8} className="chapter-refs" data-testid="outline-node-refs">
      {refs.data !== undefined && refs.data.length > 0 ? (
        <Flex vertical gap={6} className="chapter-refs__list" data-testid="outline-node-refs-list">
          {refs.data.map((item) => (
            <Flex
              key={item.cardId}
              align="center"
              gap={8}
              className="chapter-refs__row"
              data-testid="outline-node-ref-row"
              data-card-id={item.cardId}
            >
              <button
                type="button"
                className="chapter-refs__jump"
                data-testid="outline-node-ref-jump"
                onClick={() =>
                  navigate(withOrigin(`/cards?cardId=${item.cardId}`, location.pathname))
                }
              >
                {item.title}
              </button>
              <Tag color={CARD_TYPE_COLORS[item.cardType]} className="chapter-refs__tag">
                {CARD_TYPE_LABELS[item.cardType]}
              </Tag>
              <IconButton
                label={`解除「${item.title}」与这个节点的关联`}
                icon={<DisconnectOutlined />}
                data-testid="outline-node-ref-unlink"
                loading={unlinkNode.isPending}
                onClick={() =>
                  run(async () => {
                    if (nodeId === null) return
                    await unlinkNode.mutateAsync({ cardId: item.cardId, nodeId })
                    toast.notifySuccess('已解除关联')
                  })
                }
              />
            </Flex>
          ))}
        </Flex>
      ) : (
        <Text type="secondary" className="chapter-refs__hint">
          这个节点还没有关联的卡片。
        </Text>
      )}

      <Select
        data-testid="outline-node-ref-add-select"
        className="chapter-refs__select"
        value={null}
        placeholder={options.length === 0 ? '这本书的卡片都已关联' : '选择一张卡片，挂到这个节点'}
        disabled={options.length === 0 || nodeId === null}
        loading={cards.isLoading || linkNode.isPending}
        options={options}
        onChange={(cardId: number) =>
          run(async () => {
            if (nodeId === null) return
            await linkNode.mutateAsync({ cardId, nodeId })
            toast.notifySuccess('已挂到这个节点')
          })
        }
      />
    </Flex>
  )
}
