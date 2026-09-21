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
import { useChapterCards, useLinkCardChapter, useUnlinkCardChapter } from './use-card-links'

const { Text } = Typography

interface ChapterCardRefsProps {
  chapterId: number
  /** 只列出这本书的卡片：跨书的关联没有意义，服务层也会拒 */
  bookId: number
}

/**
 * 「这一章用到了哪几条设定」—— 卡片 ↔ 章节关联的另一个方向。
 *
 * 与卡片侧那块共用同一份数据，因此不存在「一边改了另一边没跟上」。
 * 写这一章时它回答的是「我答应过读者要用上的那条设定，到底用上了没有」。
 */
export function ChapterCardRefs({ chapterId, bookId }: ChapterCardRefsProps) {
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const refs = useChapterCards(chapterId)
  const cards = useCardList(
    useMemo(
      () => ({ ...DEFAULT_CARD_QUERY, bookScope: 'book' as const, bookId }),
      [bookId]
    )
  )
  const linkChapter = useLinkCardChapter()
  const unlinkChapter = useUnlinkCardChapter()

  const linkedIds = useMemo(
    () => new Set((refs.data ?? []).map((item) => item.cardId)),
    [refs.data]
  )

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
    <Flex vertical gap={8} className="chapter-refs" data-testid="chapter-refs">
      {refs.data !== undefined && refs.data.length > 0 ? (
        <Flex vertical gap={6} className="chapter-refs__list" data-testid="chapter-refs-list">
          {refs.data.map((item) => (
            <Flex
              key={item.cardId}
              align="center"
              gap={8}
              className="chapter-refs__row"
              data-testid="chapter-ref-row"
              data-card-id={item.cardId}
            >
              {/* 卡片名做成按钮：最常见的下一步是「跳过去把细节改掉」 */}
              <button
                type="button"
                className="chapter-refs__jump"
                data-testid="chapter-ref-jump"
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
                label={`解除「${item.title}」与这一章的关联`}
                icon={<DisconnectOutlined />}
                data-testid="chapter-ref-unlink"
                loading={unlinkChapter.isPending}
                onClick={() =>
                  run(async () => {
                    await unlinkChapter.mutateAsync({ cardId: item.cardId, chapterId })
                    toast.notifySuccess('已解除关联')
                  })
                }
              />
            </Flex>
          ))}
        </Flex>
      ) : (
        <Text type="secondary" className="chapter-refs__hint">
          这一章还没有关联的卡片。
        </Text>
      )}

      <Select
        data-testid="chapter-ref-add-select"
        className="chapter-refs__select"
        value={null}
        placeholder={options.length === 0 ? '这本书的卡片都已关联' : '选择一张卡片，关联到这一章'}
        disabled={options.length === 0}
        loading={cards.isLoading || linkChapter.isPending}
        options={options}
        onChange={(cardId: number) =>
          run(async () => {
            await linkChapter.mutateAsync({ cardId, chapterId })
            toast.notifySuccess('已关联到这一章')
          })
        }
      />
    </Flex>
  )
}
