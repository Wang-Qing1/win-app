import { useMemo, useState, type ReactNode } from 'react'
import { Card, Col, Flex, Progress, Row, Segmented, Skeleton, Tag, Typography } from 'antd'
import { ClockCircleOutlined, EditOutlined, FireOutlined, RiseOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router'
import { BOOK_STATUS_LABELS } from '@shared/modules/books'
import {
  STATS_RANGES,
  STATS_RANGE_LABELS,
  type BookProgressItem,
  type BookProgressQuery,
  type StatsRange,
  type StatsTrendQuery
} from '@shared/modules/stats'
import { ErrorAlert } from '../../components/ErrorAlert'
import { IconButton } from '../../components/IconButton'
import { PageHeader } from '../../components/PageHeader'
import { formatCompact, formatCount, formatMinutes, progressPercent } from '../../lib/format'
import { HeatmapCalendar } from './HeatmapCalendar'
import { TrendChart, WritingDurationChart } from './charts'
import { useBookProgress, useHeatmap, useOverview, useTrend } from './use-stats'

const { Text } = Typography

/** 热力图固定看一年：写作习惯是长周期的，30 天的格子看不出「周末不写」这类规律 */
const HEATMAP_DAYS = 365

/**
 * 统计页。
 *
 * 三个问题，从上到下依次回答：
 *   1. 这段时间我写了多少？（区间指标 + 写作量曲线 + 时长柱状）
 *   2. 我保持住了吗？（热力日历 + 连续天数）
 *   3. 哪本书在推进、哪本停了？（分书对比）
 *
 * 所有数字都来自主进程的同一次聚合，前端不做二次计算 ——
 * 唯一例外是「日均」，它由区间写作量除以活跃天数得到，而这个除法
 * 如果放在前端，就必须保证分母与后端口径一致，成本高于收益。
 * 因此日均也由后端算好（averageWordsPerActiveDay）。
 */
export function StatsPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<StatsRange>(30)

  const overview = useOverview()
  const trend = useTrend(useMemo<StatsTrendQuery>(() => ({ days: range, bookId: null }), [range]))
  const heatmap = useHeatmap(HEATMAP_DAYS)
  const books = useBookProgress(
    useMemo<BookProgressQuery>(() => ({ limit: 12, rangeDays: range }), [range])
  )

  const failed = overview.error ?? trend.error ?? heatmap.error ?? books.error
  const loading = trend.isPending && trend.data === undefined

  const days = trend.data?.days ?? []

  return (
    <Flex vertical gap={16} className="page">
      <PageHeader
        title="时间与字数"
        extra={
          <Segmented
            value={range}
            options={STATS_RANGES.map((item) => ({ value: item, label: STATS_RANGE_LABELS[item] }))}
            onChange={(value) => setRange(value as StatsRange)}
          />
        }
      />

      {failed ? (
        <ErrorAlert
          error={failed}
          title="统计数据加载失败"
          onRetry={() => {
            void overview.refetch()
            void trend.refetch()
            void heatmap.refetch()
            void books.refetch()
          }}
        />
      ) : null}

      {/* ---------------- 区间指标 ---------------- */}
      <Row gutter={[16, 16]} data-testid="stats-metrics" data-card-row="区间指标">
        <Col xs={12} lg={6}>
          <MetricCard
            label={`${STATS_RANGE_LABELS[range]}写作量`}
            value={formatCompact(trend.data?.totalWordsWritten ?? 0)}
            icon={<RiseOutlined />}
            footer={
              trend.data
                ? `净增 ${formatCompact(trend.data.totalWordsNet)}${
                    trend.data.totalWordsNet < 0 ? '（删改多于新增）' : ''
                  }`
                : undefined
            }
            loading={loading}
          />
        </Col>
        <Col xs={12} lg={6}>
          <MetricCard
            label="区间写作时长"
            value={formatMinutes(trend.data?.totalDurationSeconds ?? 0)}
            icon={<ClockCircleOutlined />}
            footer={
              overview.data
                ? `累计 ${formatMinutes(overview.data.totalDurationSeconds)}`
                : undefined
            }
            loading={loading}
          />
        </Col>
        <Col xs={12} lg={6}>
          <MetricCard
            label="日均写作量"
            value={formatCompact(trend.data?.averageWordsPerActiveDay ?? 0)}
            icon={<ThunderboltOutlined />}
            footer={
              trend.data
                ? `${trend.data.activeDays} / ${trend.data.days.length} 天有写作`
                : undefined
            }
            loading={loading}
          />
        </Col>
        <Col xs={12} lg={6}>
          <MetricCard
            label="连续写作"
            value={`${overview.data?.streakDays ?? 0} 天`}
            icon={<FireOutlined />}
            footer={overview.data ? `全书 ${formatCompact(overview.data.totalHanzi)} 汉字` : undefined}
            loading={overview.isPending}
          />
        </Col>
      </Row>

      {/* ---------------- 趋势 ---------------- */}
      {/* 两张图并排，所以两张卡都要吃满列高（内部图表高度都是 240，但标题与小字行数不同） */}
      <Row gutter={[16, 16]} data-card-row="趋势图">
        <Col xs={24} xl={14}>
          <Card className="card-fill" title="写作量趋势" extra={<Text type="secondary" className="card__extra">按会话的「净写进去的字」统计</Text>}>
            {days.length > 0 ? (
              <TrendChart
                data={days}
                xField="date"
                yField="wordsWritten"
                height={240}
                label="写作量"
                valueFormatter={(value) => `${value} 字`}
              />
            ) : (
              <Placeholder loading={loading} text="这个区间还没有写作记录" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card className="card-fill" title="每日写作时长">
            {days.length > 0 ? (
              <WritingDurationChart data={days} height={240} />
            ) : (
              <Placeholder loading={loading} text="暂无数据" />
            )}
          </Card>
        </Col>
      </Row>

      {/* ---------------- 热力日历 ---------------- */}
      <Card
        title="写作热力日历"
        extra={<Text type="secondary" className="card__extra">近一年</Text>}
      >
        {heatmap.data ? (
          <HeatmapCalendar result={heatmap.data} />
        ) : (
          <Skeleton active paragraph={{ rows: 4 }} title={false} />
        )}
      </Card>

      {/* ---------------- 分书对比 ---------------- */}
      <Card
        title="分书进度"
        extra={
          <Text type="secondary" className="card__extra">
            按最近写作排序，带区间写作量
          </Text>
        }
      >
        {(books.data ?? []).length === 0 ? (
          <Placeholder loading={books.isPending} text="还没有书籍" />
        ) : (
          <Flex vertical gap={10} data-testid="stats-book-list">
            {(books.data ?? []).map((item) => (
              <BookProgressRow
                key={item.bookId}
                item={item}
                rangeLabel={STATS_RANGE_LABELS[range]}
                onOpen={() =>
                  void navigate(
                    item.lastChapterId !== null
                      ? `/books/${item.bookId}/chapters/${item.lastChapterId}`
                      : `/books/${item.bookId}`
                  )
                }
              />
            ))}
          </Flex>
        )}
      </Card>
    </Flex>
  )
}

/* ------------------------------------------------------------------ *
 * 局部组件
 * ------------------------------------------------------------------ */

interface MetricCardProps {
  label: string
  value: string
  icon: ReactNode
  footer?: string
  loading: boolean
}

function MetricCard({ label, value, icon, footer, loading }: MetricCardProps) {
  return (
    // card-fill：四张指标卡并排，必须等高（见 styles.css「并排卡片等高」）。
    // 注意这里是**本页自己的一份 MetricCard**（没有外壳 div），首页那份外面
    // 套了一层挂着 data-testid 的透明壳 —— 两处都要 card-fill，
    // 冒烟量的时候会穿过透明壳看里面那张真卡片。
    <Card className="metric-card__card card-fill">
      <Flex vertical gap={4}>
        <Flex align="center" justify="space-between" gap={8}>
          <Text type="secondary" className="metric-card__label">
            {label}
          </Text>
          <span className="metric-card__icon">{icon}</span>
        </Flex>
        <Text className="metric-card__value">{loading ? '—' : value}</Text>
        {footer ? (
          <Text type="secondary" className="metric-card__footer">
            {footer}
          </Text>
        ) : null}
      </Flex>
    </Card>
  )
}

function BookProgressRow({
  item,
  rangeLabel,
  onOpen
}: {
  item: BookProgressItem
  rangeLabel: string
  onOpen: () => void
}) {
  const percent = progressPercent(item.hanziCount, item.targetWords)

  return (
    <Flex align="center" gap={12} className="progress-row">
      <span className="progress-row__accent" style={{ background: item.accentColor }} aria-hidden="true" />
      <div className="progress-row__main">
        <Flex align="center" gap={8} wrap>
          <Text strong>{item.title}</Text>
          <Tag className="tag--flush">{BOOK_STATUS_LABELS[item.status]}</Tag>
          <Text type="secondary" className="progress-row__meta">
            {item.chapterCount} 章 · {formatCount(item.hanziCount)} 汉字
          </Text>
        </Flex>
        <Flex align="center" gap={12} wrap className="stats-range">
          <Text type="secondary">
            {rangeLabel}写作量 <Text strong>{formatCount(item.rangeWordsWritten)}</Text>
          </Text>
          <Text type="secondary">
            时长 <Text strong>{formatMinutes(item.rangeDurationSeconds)}</Text>
          </Text>
        </Flex>
        {percent !== null ? (
          <Progress percent={percent} size="small" showInfo={false} strokeColor={item.accentColor} />
        ) : null}
      </div>
      {/* 与首页「在写书籍」同一套行尾圆钮，两处不能长成两种样子 */}
      <IconButton
        label={item.lastChapterId !== null ? '继续写作' : '打开这本书'}
        icon={<EditOutlined />}
        onClick={onOpen}
      />
    </Flex>
  )
}

function Placeholder({ loading, text }: { loading: boolean; text: string }) {
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} title={false} />
  return (
    <Flex align="center" justify="center" className="chart-placeholder">
      <Text type="secondary">{text}</Text>
    </Flex>
  )
}
