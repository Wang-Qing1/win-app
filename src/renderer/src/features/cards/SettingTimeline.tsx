import { Flex, Typography } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons'
import {
  SETTING_TIME_POINT_KEY,
  timelineOrderOf,
  type Card
} from '@shared/modules/cards'
import { IconButton } from '../../components/IconButton'

const { Text } = Typography

/**
 * 设定卡的时间线视图。
 *
 * 与「列表」视图的差别不是排版，是**读法**：列表按最近改动排序，回答
 * 「我最近动过哪几张」；时间线按故事里的先后排序，回答「先发生什么、
 * 后发生什么」。设定卡堆到十几张之后，后者才是写作时真正要查的东西 ——
 * 而它在列表里完全看不出来（一串按修改时间排的卡片，先后顺序是随机的）。
 *
 * 先后由**作者自己排**：虚构世界的时点是自由文本（星历 2103 年、开战前
 * 三天），没有任何可靠的自动排序规则（按字典排会把「第十三年」排在
 * 「第三年」前面）。所以时点只负责显示，排序另用一个隐藏序号，由上下
 * 移动写入 —— 见共享层 SETTING_TIME_POINT_KEY / SETTING_ORDER_KEY 的说明。
 */

/**
 * 时间线的排列。
 *
 * 排过序的在前（按序号），没排过序的按建卡先后跟在后面。
 *
 * 没排过序的**不能**当成 0，否则新建的设定卡一出现就插到最前面，
 * 把作者刚排好的顺序挤乱 —— 「还没排过」与「排在第一位」必须分得开。
 */
export function sortForTimeline(cards: readonly Card[]): Card[] {
  return cards
    .map((card) => ({ card, order: timelineOrderOf(card) }))
    .sort((a, b) => {
      if (a.order !== null && b.order !== null) return a.order - b.order
      if (a.order !== null) return -1
      if (b.order !== null) return 1
      return a.card.createdAt.localeCompare(b.card.createdAt) || a.card.id - b.card.id
    })
    .map((entry) => entry.card)
}

interface SettingTimelineProps {
  cards: readonly Card[]
  selectedId: number | null
  onSelect: (cardId: number) => void
  /**
   * 提交**整组**新顺序，而不是「把某张卡上移一位」。
   *
   * 由调用方拿它去调 IPC：一次提交整组是幂等的，而「移动一位」的语义
   * 依赖服务端当下的顺序，两端不一致时就会错位。
   */
  onReorder: (orderedIds: number[]) => void
  /**
   * 能不能调序。
   *
   * 只有「当前正看着某一本书」时才能排：跨书的时间线在故事上不存在，
   * 服务层也会因此拒绝。按钮置灰并给出理由，而不是点了才报错 ——
   * 后者看起来像功能坏了。
   */
  reorderDisabled?: boolean
  reorderHint?: string
}

export function SettingTimeline({
  cards,
  selectedId,
  onSelect,
  onReorder,
  reorderDisabled = false,
  reorderHint
}: SettingTimelineProps) {
  const ordered = sortForTimeline(cards)

  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= ordered.length) return
    const ids = ordered.map((card) => card.id)
    // 相邻交换而不是「删掉再插入」：后者的索引换算在两端都可能差一位
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    onReorder(ids)
  }

  return (
    <div className="timeline" data-testid="setting-timeline" data-count={ordered.length}>
      {reorderHint !== undefined && reorderDisabled ? (
        <Text type="secondary" className="timeline__hint">
          {reorderHint}
        </Text>
      ) : null}

      {ordered.map((card, index) => {
        const timePoint = card.extra[SETTING_TIME_POINT_KEY] ?? ''
        return (
          <div
            key={card.id}
            className={`timeline__item${card.id === selectedId ? ' timeline__item--active' : ''}`}
            data-testid="timeline-item"
            data-card-id={card.id}
            data-order={index}
            data-time={timePoint}
          >
            <span className="timeline__marker" aria-hidden="true">
              <span className="timeline__dot" />
            </span>

            {/*
             * 整块内容是一个按钮：一行里点哪儿都该打开这张卡。
             * 上下移动是两个独立的小按钮，它们**不能**包在里面 ——
             * 嵌套按钮既不合 HTML 规范，点击也会被里层吃掉。
             */}
            <button
              type="button"
              className="timeline__body"
              data-testid="timeline-item-open"
              onClick={() => onSelect(card.id)}
            >
              <Text className="timeline__time" data-testid="timeline-item-time">
                {timePoint.length > 0 ? timePoint : '未标时点'}
              </Text>
              <Text strong className="timeline__title">
                {card.title}
              </Text>
              {card.subtitle.length > 0 ? (
                <Text type="secondary" className="timeline__subtitle">
                  {card.subtitle}
                </Text>
              ) : null}
            </button>

            <Flex className="timeline__actions" gap={2}>
              <IconButton
                label="在时间线上上移"
                icon={<ArrowUpOutlined />}
                disabled={reorderDisabled || index === 0}
                data-testid="timeline-move-up"
                onClick={() => move(index, -1)}
              />
              <IconButton
                label="在时间线下移"
                icon={<ArrowDownOutlined />}
                disabled={reorderDisabled || index === ordered.length - 1}
                data-testid="timeline-move-down"
                onClick={() => move(index, 1)}
              />
            </Flex>
          </div>
        )
      })}
    </div>
  )
}
