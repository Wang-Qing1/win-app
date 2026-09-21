import { useMemo, useState } from 'react'
import { Flex, Modal, Tag, Typography } from 'antd'
import type { CardType } from '@shared/modules/cards'
import { CARD_TYPE_LABELS, DEFAULT_CARD_QUERY } from '@shared/modules/cards'
import {
  OUTLINE_NODE_TYPE_LABELS,
  OUTLINE_STATUS_LABELS,
  type OutlineNodeType,
  type OutlineStatus,
  type OutlineTreeNode
} from '@shared/modules/outline'
import type { Card } from '@shared/modules/cards'
import { CARD_TYPE_COLORS } from '../cards/card-meta'
import { useCardList } from '../cards/use-cards'
import { useOutlineTree } from '../outline/use-outline'

const { Text, Paragraph } = Typography

interface CardLookupPanelProps {
  bookId: number
  cardType: CardType
}

/**
 * 「角色 / 设定」的查阅面板：只列这一本书的某一类卡片，点一行弹窗看全文。
 *
 * 为什么是**内嵌 + 弹窗**而不是跳去卡片库：
 * 这里的使用场景是「写到一半查一下那条设定怎么写的」—— 高频、短时、
 * 查完立刻回到原来的光标。跳走再回来（哪怕有回程票）都要重新找位置，
 * 而跳走唯一的好处是「能批量整理」，那种场景留给面板上的「打开完整页面」。
 *
 * 列表只读，弹窗也只读，编辑一律去卡片库：两处都能改同一份数据的话，
 * 早晚会出现「改了这边、那边还显示旧的」，而排查时看不出是哪一处的问题。
 */
export function CardLookupPanel({ bookId, cardType }: CardLookupPanelProps) {
  const [openId, setOpenId] = useState<number | null>(null)

  const list = useCardList(
    useMemo(
      () => ({
        ...DEFAULT_CARD_QUERY,
        bookScope: 'book' as const,
        bookId,
        cardType,
        pageSize: 200
      }),
      [bookId, cardType]
    )
  )

  const items = list.data?.items ?? []
  const current = items.find((item) => item.id === openId) ?? null

  return (
    <div className="lookup" data-testid="lookup-cards">
      {items.length === 0 ? (
        <Text type="secondary" className="lookup__empty">
          {list.isLoading ? '正在读取…' : '这本书还没有这一类卡片。'}
        </Text>
      ) : (
        <Flex vertical gap={2} className="lookup__list" data-testid="lookup-cards-list">
          {items.map((card) => (
            <button
              key={card.id}
              type="button"
              className="lookup__row"
              data-testid="lookup-card-row"
              data-card-id={card.id}
              onClick={() => setOpenId(card.id)}
            >
              <Text className="lookup__title" ellipsis={{ tooltip: card.title }}>
                {card.title}
              </Text>
              {/*
               * 设定卡把类别带上：四类世界观条目在列表里长得一样，
               * 没有类别就只能靠标题猜它是地点还是规则。
               */}
              {cardType === 'setting' && card.extra.category ? (
                <Tag className="lookup__tag">{card.extra.category}</Tag>
              ) : null}
              {card.subtitle ? (
                <Text type="secondary" className="lookup__meta" ellipsis>
                  {card.subtitle}
                </Text>
              ) : null}
            </button>
          ))}
        </Flex>
      )}

      <CardDetailModal card={current} onClose={() => setOpenId(null)} />
    </div>
  )
}

function CardDetailModal({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const extraEntries = card
    ? Object.entries(card.extra).filter(([, value]) => value.trim().length > 0)
    : []

  return (
    <Modal
      open={card !== null}
      title={card?.title ?? ''}
      onCancel={onClose}
      footer={null}
      width={560}
      data-testid="lookup-card-modal"
    >
      {card === null ? null : (
        <Flex vertical gap={10}>
          <Flex gap={6} align="center" wrap>
            <Tag color={CARD_TYPE_COLORS[card.cardType]}>{CARD_TYPE_LABELS[card.cardType]}</Tag>
            {card.extra.category ? <Tag>{card.extra.category}</Tag> : null}
            {card.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Flex>

          {card.subtitle ? (
            <Text type="secondary">{card.subtitle}</Text>
          ) : null}

          {extraEntries.map(([key, value]) => (
            <Text key={key} className="lookup__extra">
              {value}
            </Text>
          ))}

          {card.content.trim().length > 0 ? (
            <Paragraph className="lookup__content">{card.content}</Paragraph>
          ) : (
            <Text type="secondary">这张卡还没有正文。</Text>
          )}
        </Flex>
      )}
    </Modal>
  )
}

interface OutlineLookupPanelProps {
  bookId: number
}

/** 「大纲」的查阅面板：本书的情节节点，点一行弹窗看摘要 */
export function OutlineLookupPanel({ bookId }: OutlineLookupPanelProps) {
  const [openId, setOpenId] = useState<number | null>(null)
  const tree = useOutlineTree(bookId)

  /** 树摊平但保留层级：缩进是这里唯一的层级线索，列平了就分不清主线与支线 */
  const rows = useMemo(() => {
    const out: Array<{ node: OutlineTreeNode; depth: number }> = []
    const walk = (nodes: OutlineTreeNode[], depth: number): void => {
      for (const node of nodes) {
        out.push({ node, depth })
        walk(node.children, depth + 1)
      }
    }
    if (tree.data) walk(tree.data.nodes, 0)
    return out
  }, [tree.data])

  const current = rows.find((row) => row.node.id === openId)?.node ?? null

  return (
    <div className="lookup" data-testid="lookup-outline">
      {rows.length === 0 ? (
        <Text type="secondary" className="lookup__empty">
          {tree.isLoading ? '正在读取…' : '这本书还没有大纲节点。'}
        </Text>
      ) : (
        <Flex vertical gap={2} className="lookup__list" data-testid="lookup-outline-list">
          {rows.map(({ node, depth }) => (
            <button
              key={node.id}
              type="button"
              className="lookup__row"
              data-testid="lookup-node-row"
              data-node-id={node.id}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => setOpenId(node.id)}
            >
              <Text className="lookup__title" ellipsis={{ tooltip: node.title }}>
                {node.title}
              </Text>
              <Text type="secondary" className="lookup__meta">
                {OUTLINE_NODE_TYPE_LABELS[node.nodeType as OutlineNodeType] ?? node.nodeType}
                {' · '}
                {OUTLINE_STATUS_LABELS[node.status as OutlineStatus] ?? node.status}
              </Text>
            </button>
          ))}
        </Flex>
      )}

      <OutlineDetailModal node={current} onClose={() => setOpenId(null)} />
    </div>
  )
}

function OutlineDetailModal({
  node,
  onClose
}: {
  node: OutlineTreeNode | null
  onClose: () => void
}) {
  return (
    <Modal
      open={node !== null}
      title={node?.title ?? ''}
      onCancel={onClose}
      footer={null}
      width={560}
      data-testid="lookup-node-modal"
    >
      {node === null ? null : (
        <Flex vertical gap={10}>
          <Flex gap={6} align="center" wrap>
            <Tag>{OUTLINE_NODE_TYPE_LABELS[node.nodeType as OutlineNodeType] ?? node.nodeType}</Tag>
            <Tag>{OUTLINE_STATUS_LABELS[node.status as OutlineStatus] ?? node.status}</Tag>
            {node.chapterTitle ? <Tag>已落地：{node.chapterTitle}</Tag> : null}
          </Flex>

          {node.summary.trim().length > 0 ? (
            <Paragraph className="lookup__content">{node.summary}</Paragraph>
          ) : (
            <Text type="secondary">这个节点还没有写摘要。</Text>
          )}
        </Flex>
      )}
    </Modal>
  )
}
