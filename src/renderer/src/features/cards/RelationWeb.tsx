import { Empty, Flex, Modal, Typography } from 'antd'
import { useNavigate } from 'react-router'
import { CARD_TYPE_LABELS } from '@shared/modules/cards'
import { ErrorAlert } from '../../components/ErrorAlert'
import { useBookRelations } from './use-card-links'

const { Text } = Typography

interface RelationWebProps {
  open: boolean
  bookId: number
  bookTitle: string
  onClose: () => void
}

/**
 * 一本书的关系网 —— 关系图的文字版。
 *
 * 为什么先做文字版：**真正要回答的问题是一条一条的关系，不是一张画**。
 * 「谁跟谁有关系、是什么关系」在几十张卡的量级下，一列边比一张图更快读完；
 * 图要解决的问题（「谁是这个故事的中心」）得等布局、缩放、拖拽都做扎实了
 * 才成立，而那时它读的还是这一份数据。
 *
 * 每条边的两头都能点：关系网最常见的下一步就是从「师徒」跳到那个人身上。
 */
export function RelationWeb({ open, bookId, bookTitle, onClose }: RelationWebProps) {
  const navigate = useNavigate()
  const relations = useBookRelations(open ? bookId : null)

  const edges = relations.data ?? []

  /** 点某一头：先关掉浮层再跳，否则浮层会盖在卡片面板上 */
  const jump = (cardId: number): void => {
    onClose()
    navigate(`/cards?cardId=${cardId}`)
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} title={`《${bookTitle}》的关系网`} width={640}>
      <div data-testid="relation-web" data-count={edges.length}>
        {relations.isError ? (
          <ErrorAlert error={relations.error} onRetry={() => void relations.refetch()} />
        ) : relations.isLoading ? (
          <Text type="secondary">正在读取这本书的关系……</Text>
        ) : edges.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Flex vertical gap={6} align="center">
                <Text>这本书里还没有关系</Text>
                <Text type="secondary">
                  打开一张人物卡，在「关系」那一块选另一张卡、填上关系名即可。
                </Text>
              </Flex>
            }
          />
        ) : (
          <Flex vertical gap={6} className="relation-web__list">
            {edges.map((edge) => (
              <div
                key={`${edge.cardId}-${edge.relatedId}`}
                className="relation-web__edge"
                data-testid="relation-edge"
                data-card-id={edge.cardId}
                data-related-id={edge.relatedId}
                data-relation={edge.relation}
              >
                <button
                  type="button"
                  className="relation-web__name"
                  data-testid="relation-edge-open"
                  onClick={() => jump(edge.cardId)}
                >
                  {edge.cardTitle}
                </button>
                <Text className="relation-web__label">{edge.relation}</Text>
                <button
                  type="button"
                  className="relation-web__name"
                  data-testid="relation-edge-open-other"
                  onClick={() => jump(edge.relatedId)}
                >
                  {edge.relatedTitle}
                </button>
                <Text type="secondary" className="relation-web__type">
                  {CARD_TYPE_LABELS[edge.cardType]} · {CARD_TYPE_LABELS[edge.relatedType]}
                </Text>
              </div>
            ))}
          </Flex>
        )}
      </div>
    </Modal>
  )
}
