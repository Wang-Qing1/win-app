import { useMemo, useState } from 'react'
import { Button, Flex, Input, Select, Typography } from 'antd'
import { DisconnectOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router'
import { CARD_TYPE_LABELS, DEFAULT_CARD_QUERY } from '@shared/modules/cards'
import { RELATION_LIMITS } from '@shared/modules/card-links'
import { IconButton } from '../../components/IconButton'
import { useToast } from '../../components/Toast'
import { useCardList } from './use-cards'
import { useCardRelations, useRelateCards, useUnrelateCards } from './use-card-links'

const { Text } = Typography

interface CardRelationsProps {
  cardId: number
  /** null = 通用卡片：不属于任何书，也就没有「同书的另一张卡」可供关联 */
  bookId: number | null
}

/**
 * 这张卡与哪些卡有关系。
 *
 * 关系与「用在哪几章」是两件事：后者连的是**已经写出来的正文**，
 * 前者连的是**另一条资料**——两个人之间是师徒，这件事不依赖哪一章。
 * 结构化的意义全在反查与跳转上：在「林澈」这张卡上看见「师徒 · 沈菱」，
 * 点一下就到沈菱；而沈菱那一侧不用再记一遍，同一条边两头都看得到。
 *
 * 新增要填**关系名**，所以这一步不能像章节那样「选中即建立」——
 * 多一个输入框换来的正是纯文本字段做不到的事：关系名与对方是分开的两栏，
 * 于是「按关系名找人」与「点进去看人」都能做。
 */
export function CardRelations({ cardId, bookId }: CardRelationsProps) {
  const toast = useToast()
  const navigate = useNavigate()

  const relations = useCardRelations(cardId)
  const relate = useRelateCards()
  const unrelate = useUnrelateCards()

  const [targetId, setTargetId] = useState<number | null>(null)
  const [label, setLabel] = useState('')

  /*
   * 候选卡：这本书里的其它卡。
   *
   * 取 200 张而不是一页 60 张：关系的选择范围是整个角色表，
   * 翻页去选一个人是荒谬的；而一本书的卡片量级就在几十张。
   */
  const candidateQuery = useMemo(
    () => ({ ...DEFAULT_CARD_QUERY, bookScope: 'book' as const, bookId, pageSize: 200 }),
    [bookId]
  )
  const cardList = useCardList(candidateQuery)

  const rows = relations.data ?? []
  const relatedIds = useMemo(() => new Set(rows.map((item) => item.relatedId)), [rows])

  const options = useMemo(
    () =>
      (cardList.data?.items ?? [])
        .filter((card) => card.id !== cardId && !relatedIds.has(card.id))
        .map((card) => ({
          value: card.id,
          // 带上类型：同书里出现同名的人物卡与设定卡时，光看标题分不清
          label: `${card.title}（${CARD_TYPE_LABELS[card.cardType]}）`
        })),
    [cardList.data, cardId, relatedIds]
  )

  const trimmed = label.trim()
  const canAdd = bookId !== null && targetId !== null && trimmed.length > 0

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      toast.notifyError(error instanceof Error ? error.message : '操作失败')
    }
  }

  const add = (): void => {
    if (targetId === null) return
    void run(async () => {
      await relate.mutateAsync({ cardId, relatedId: targetId, relation: trimmed })
      setTargetId(null)
      setLabel('')
      toast.notifySuccess('已建立关系')
    })
  }

  return (
    <Flex vertical gap={8} className="card-links" data-testid="card-relations">
      <Flex justify="space-between" align="center" gap={8}>
        <Text strong className="card-links__title">
          关系
        </Text>
        {relations.data === undefined ? null : (
          <Text
            type="secondary"
            className="card-links__count"
            data-testid="card-relations-count"
            data-value={rows.length}
          >
            {rows.length} 条
          </Text>
        )}
      </Flex>

      {bookId === null ? (
        <Text type="secondary" className="card-links__hint">
          通用卡片不属于任何书，先把它指定到一本书下，才能和那本书里的其它卡片建立关系。
        </Text>
      ) : (
        <>
          {rows.length > 0 ? (
            <Flex vertical gap={6} className="card-links__list" data-testid="card-relations-list">
              {rows.map((item) => (
                <Flex
                  key={item.relatedId}
                  align="center"
                  gap={8}
                  className="card-links__row"
                  data-testid="relation-row"
                  data-related-id={item.relatedId}
                  data-relation={item.relation}
                >
                  <Text className="card-relations__label">{item.relation}</Text>
                  {/*
                   * 对方卡做成按钮：关系列表最常见的下一步就是「跳过去看看
                   * 那个人是谁」。卡名后面带类型，跳错了能立刻发现。
                   */}
                  <button
                    type="button"
                    className="card-links__jump"
                    data-testid="relation-open"
                    onClick={() => navigate(`/cards?cardId=${item.relatedId}`)}
                  >
                    {item.relatedTitle}
                  </button>
                  <Text type="secondary" className="card-links__meta">
                    {CARD_TYPE_LABELS[item.relatedType]}
                  </Text>
                  <IconButton
                    label={`解除与「${item.relatedTitle}」的关系`}
                    icon={<DisconnectOutlined />}
                    data-testid="relation-unlink"
                    loading={unrelate.isPending}
                    onClick={() =>
                      run(async () => {
                        await unrelate.mutateAsync({ cardId, relatedId: item.relatedId })
                        toast.notifySuccess('已解除关系')
                      })
                    }
                  />
                </Flex>
              ))}
            </Flex>
          ) : (
            <Text type="secondary" className="card-links__hint">
              还没有关系。关系记的是「这张卡与另一张卡之间是什么」——
              两个人之间往往比「与主角的关系」这种一句话写得更清楚。
            </Text>
          )}

          <Flex gap={8} align="center" wrap>
            <Select
              data-testid="relation-select"
              className="card-relations__select"
              value={targetId}
              placeholder={options.length === 0 ? '这本书的卡片都已关联' : '选择另一张卡'}
              disabled={options.length === 0}
              loading={cardList.isLoading || relate.isPending}
              options={options}
              onChange={(value: number | null) => setTargetId(value)}
            />
            <Input
              data-testid="relation-label-input"
              className="card-relations__input"
              value={label}
              maxLength={RELATION_LIMITS.label}
              placeholder="关系名，如：师徒 / 宿敌"
              onChange={(event) => setLabel(event.target.value)}
              onPressEnter={add}
            />
            <Button
              data-testid="relation-add"
              type="primary"
              disabled={!canAdd}
              loading={relate.isPending}
              onClick={add}
            >
              建立关系
            </Button>
          </Flex>
        </>
      )}
    </Flex>
  )
}
