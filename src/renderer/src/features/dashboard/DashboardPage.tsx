import type { ReactNode } from 'react'
import { Button, Card, Col, Empty, Flex, Progress, Row, Skeleton, Statistic, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router'
import {
  EditOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  FireOutlined,
  ReadOutlined,
  RightOutlined
} from '@ant-design/icons'
import { BOOK_STATUS_LABELS } from '@shared/modules/books'
import type { BookProgressQuery, StatsTrendQuery } from '@shared/modules/stats'
import { ErrorAlert } from '../../components/ErrorAlert'
import { MODULE_ITEMS } from '../../components/nav'
import { PageHeader } from '../../components/PageHeader'
import {
  formatCompact,
  formatCount,
  formatHours,
  formatMinutes,
  formatRelativeTime,
  progressPercent
} from '../../lib/format'
import { TrendChart } from '../stats/charts'
import { useBookProgress, useOverview, useTrend } from '../stats/use-stats'

const { Text, Paragraph } = Typography

/**
 * 查询条件的常量放在模块级，而不是在组件里写字面量。
 *
 * 这两个对象会进入 React Query 的缓存键。每次渲染新建一个字面量虽然
 * 因为键是结构化哈希而不会出错，但模块级常量让「首页看的是哪一段数据」
 * 一眼可见，也便于和统计页的区间做对照。
 */
const PROGRESS_QUERY: BookProgressQuery = { limit: 6, rangeDays: null }
const TREND_QUERY: StatsTrendQuery = { days: 30, bookId: null }

/**
 * 首页 / 启动台。
 *
 * 布局意图（自上而下）：先回答「去哪儿」——四张功能模块卡片（**这就是导航**，
 * 顶部导航条已整条移除）；再回答「我现在有多少东西」——四个指标卡；
 * 之后是「我最近写得怎么样」——趋势图 + 今日卡片；
 * 最后是「我接着写哪一本」——在写书籍。
 *
 * 模块卡片排在**第一位**而不是像上一版那样垫在趋势图之后：它现在承担的是
 * 导航职责，不是「顺带一提的入口」。垫在下面意味着每次切模块都要先滚过
 * 一屏数据，而且会随数据条数变化位置，肌肉记忆建立不起来。
 *
 * 测试锚点说明（冒烟测试依赖，改动前请先看 smoke-test.ts）：
 *   module-entry       功能模块卡片，data-module-key 标明是哪个模块
 *   dashboard-metrics  容器，data-loading 表示数据是否还在路上
 *   metric-*           指标卡，data-value 是未格式化的原始数值
 *   progress-row       在写书籍的每一行
 * 数字一律通过 data-value 暴露而不是读显示文本：显示文本是「12.8 万」
 * 这类格式化结果，拿它做断言会把「格式化改了」误判成「数据算错了」。
 */
export function DashboardPage() {
  const navigate = useNavigate()

  const overview = useOverview()
  const progress = useBookProgress(PROGRESS_QUERY)
  const trend = useTrend(TREND_QUERY)

  const isLoading = overview.isPending || progress.isPending || trend.isPending
  const failedQuery = overview.error ?? progress.error ?? trend.error
  const progressItems = progress.data ?? []

  return (
    <Flex vertical gap={16} className="page">
      {/*
       * 首页的标题只是隐藏锚点（全应用的页标题都已不显示），
       * `data-testid="page-title"` 仍渲染着 —— 它是冒烟测试判断
       * 「当前在哪个页面」的锚点，不能删。
       */}
      <PageHeader title="首页" />

      {/* ---------------- 功能模块（应用的导航） ---------------- */}
      <div data-testid="module-grid">
        <Row gutter={[16, 16]} className="module-grid equal-height-row">
          {MODULE_ITEMS.map((module) => (
            <Col xs={24} sm={12} xl={6} key={module.key}>
              {/*
               * data-testid 与 data-module-key 直接挂在 antd Card 上（和书架上
               * 的 book-card 同一写法）：onClick 也在这张 Card 上，这样
               * `el.click()` 一点就命中真正的处理器。若把锚点放在外面包一层
               * div，点它的事件不会往下冒泡到 Card，断言会表现为「点了没反应」。
               */}
              <Card
                hoverable
                className="module-card"
                data-testid="module-entry"
                data-module-key={module.key}
                onClick={() => void navigate(module.path)}
              >
                <Flex align="center" gap={12}>
                  <span className="module-card__icon">{module.icon}</span>
                  <div className="module-card__text">
                    <Flex align="center" gap={6}>
                      <Text strong>{module.label}</Text>
                    </Flex>
                    <Text type="secondary" className="module-card__hint">
                      {module.hint}
                    </Text>
                  </div>
                  <RightOutlined className="module-card__arrow" />
                </Flex>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {failedQuery ? (
        <ErrorAlert
          error={failedQuery}
          title="总览数据加载失败"
          onRetry={() => {
            void overview.refetch()
            void progress.refetch()
            void trend.refetch()
          }}
        />
      ) : null}

      {/* ---------------- 四个总指标 ---------------- */}
      <div data-testid="dashboard-metrics" data-loading={isLoading ? 'true' : 'false'}>
        <Row gutter={[16, 16]} className="equal-height-row">
          <Col xs={12} lg={6}>
            <MetricCard
              testId="metric-book-count"
              label="书籍"
              value={overview.data?.bookCount ?? 0}
              display={formatCount(overview.data?.bookCount ?? 0)}
              icon={<ReadOutlined />}
              loading={isLoading}
              footer={
                overview.data
                  ? `连载中 ${overview.data.activeBookCount} 本 · 分卷 ${overview.data.volumeCount} 个`
                  : undefined
              }
            />
          </Col>

          <Col xs={12} lg={6}>
            <MetricCard
              testId="metric-chapter-count"
              label="章节"
              value={overview.data?.chapterCount ?? 0}
              display={formatCount(overview.data?.chapterCount ?? 0)}
              icon={<FileTextOutlined />}
              loading={isLoading}
              footer={
                overview.data ? `今日有改动 ${overview.data.todayChapterCount} 章` : undefined
              }
            />
          </Col>

          <Col xs={12} lg={6}>
            <MetricCard
              testId="metric-total-hanzi"
              label="全书汉字"
              value={overview.data?.totalHanzi ?? 0}
              display={formatCompact(overview.data?.totalHanzi ?? 0)}
              icon={<span className="metric-card__hanzi-icon">字</span>}
              loading={isLoading}
              footer={
                overview.data
                  ? // 平台口径与写作口径是两回事，并排摆出来免得用户觉得「字数不对」
                    `含标点 ${formatCompact(overview.data.totalChars)}（平台口径）`
                  : undefined
              }
            />
          </Col>

          <Col xs={12} lg={6}>
            <MetricCard
              testId="metric-duration"
              label="累计写作时长"
              value={overview.data?.totalDurationSeconds ?? 0}
              display={formatHours(overview.data?.totalDurationSeconds ?? 0)}
              icon={<FieldTimeOutlined />}
              loading={isLoading}
              footer={
                overview.data ? `连续写作 ${overview.data.streakDays} 天` : undefined
              }
            />
          </Col>
        </Row>
      </div>

      {/* ---------------- 趋势 + 今日 ---------------- */}
      {/* 卡片类名 .dashboard-trend / .dashboard-today 供等高样式与冒烟几何断言使用 */}
      <Row gutter={[16, 16]} className="equal-height-row">
        <Col xs={24} xl={15}>
          <Card
            title="近 30 天写作量"
            className="dashboard-trend"
            extra={
              <Text type="secondary" className="card__extra">
                合计 {formatCount(trend.data?.totalWordsWritten ?? 0)} 汉字 ·{' '}
                {formatMinutes(trend.data?.totalDurationSeconds ?? 0)}
              </Text>
            }
          >
            {trend.data && trend.data.days.length > 0 ? (
              <TrendChart
                data={trend.data.days}
                xField="date"
                yField="wordsWritten"
                height={224}
                label="写作量"
                valueFormatter={(value) => `${value} 字`}
              />
            ) : (
              <ChartPlaceholder loading={trend.isPending} text="这 30 天还没有写作记录" />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card title="今日" className="dashboard-today">
            <Flex vertical gap={14}>
              <Flex align="baseline" gap={10}>
                <Statistic
                  value={overview.data?.todayWordsWritten ?? 0}
                  loading={isLoading}
                  suffix={<span className="statistic__suffix">汉字</span>}
                />
                <Text type="secondary">
                  {/* 净增可能为负——校对删字是正常操作，不该被当成异常 */}
                  净增 {overview.data ? overview.data.todayWordsNet : 0}
                </Text>
              </Flex>

              <Flex vertical gap={6}>
                <Flex align="center" gap={6}>
                  <FireOutlined className="dashboard-today__flame" />
                  <Text>
                    连续写作 <Text strong>{overview.data?.streakDays ?? 0}</Text> 天
                  </Text>
                </Flex>
                <Text type="secondary">
                  今日已写 {formatMinutes(overview.data?.todayDurationSeconds ?? 0)} · 改动{' '}
                  {overview.data?.todayChapterCount ?? 0} 章
                </Text>
              </Flex>

              <TodayTargetBar
                written={overview.data?.todayWordsWritten ?? 0}
                target={overview.data?.ongoingTargetWords ?? 0}
                loading={isLoading}
              />
            </Flex>
          </Card>
        </Col>
      </Row>

      {/* ---------------- 在写书籍 ---------------- */}
      <Card
        title="在写书籍"
        extra={
          <Button type="link" size="small" onClick={() => void navigate('/books')}>
            全部书籍
          </Button>
        }
      >
        {progress.isPending ? (
          <Skeleton active paragraph={{ rows: 3 }} title={false} />
        ) : progressItems.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Flex vertical gap={8} align="center">
                <Text type="secondary">还没有书籍</Text>
                <Button type="primary" size="small" onClick={() => void navigate('/books')}>
                  新建第一本书
                </Button>
              </Flex>
            }
          />
        ) : (
          <Flex vertical gap={4} className="progress-list">
            {progressItems.map((item) => {
              const percent = progressPercent(item.hanziCount, item.targetWords)
              return (
                <Flex
                  key={item.bookId}
                  data-testid="progress-row"
                  className="progress-row"
                  align="center"
                  gap={12}
                >
                  <span
                    className="progress-row__accent"
                    style={{ background: item.accentColor }}
                    aria-hidden="true"
                  />
                  <div className="progress-row__main">
                    <Flex align="center" gap={8} wrap>
                      <Text strong className="progress-row__title">
                        {item.title}
                      </Text>
                      <Tag className="tag--flush">{BOOK_STATUS_LABELS[item.status]}</Tag>
                      <Text type="secondary" className="progress-row__meta">
                        {item.chapterCount} 章 · {formatCompact(item.hanziCount)}
                        {item.targetWords > 0 ? ` / ${formatCompact(item.targetWords)}` : ''}
                        {item.lastEditedAt ? ` · ${formatRelativeTime(item.lastEditedAt)}` : ''}
                      </Text>
                    </Flex>
                    {percent !== null ? (
                      <Progress
                        percent={percent}
                        size="small"
                        showInfo={false}
                        strokeColor={item.accentColor}
                      />
                    ) : null}
                  </div>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() =>
                      void navigate(
                        item.lastChapterId !== null
                          ? `/books/${item.bookId}/chapters/${item.lastChapterId}`
                          : `/books/${item.bookId}`
                      )
                    }
                  >
                    {item.lastChapterId !== null ? '继续写作' : '打开'}
                  </Button>
                </Flex>
              )
            })}
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
  /** 冒烟测试锚点，同时也作为 React key 之外的稳定标识 */
  testId: string
  label: string
  /** 原始数值，写进 data-value 供测试断言 */
  value: number
  /** 格式化后的展示文本 */
  display: string
  icon: ReactNode
  loading: boolean
  footer?: ReactNode
}

/**
 * 指标卡。
 *
 * data-testid 与 data-value 挂在外层纯 div 上，而不是传给 antd 的 Card：
 * 虽然 Card 通常会把多余的 props 透传到根元素，但那属于实现细节，
 * 组件库升级时可能不再透传 —— 一旦失效，冒烟测试会读到 null 而拿到 -1，
 * 报出来的却是「书籍数没有渲染出真实数据」，排查方向完全被带偏。
 */
function MetricCard({ testId, label, value, display, icon, loading, footer }: MetricCardProps) {
  return (
    <div data-testid={testId} data-value={String(value)} className="metric-card">
      <Card className="metric-card__card">
        <Flex vertical gap={4}>
          <Flex align="center" justify="space-between" gap={8}>
            <Text type="secondary" className="metric-card__label">
              {label}
            </Text>
            <span className="metric-card__icon">{icon}</span>
          </Flex>
          <Text className="metric-card__value">{loading ? '—' : display}</Text>
          {footer ? (
            <Text type="secondary" className="metric-card__footer">
              {footer}
            </Text>
          ) : null}
        </Flex>
      </Card>
    </div>
  )
}

/**
 * 今日进度条。
 *
 * 分母是「各连载中书的目标字数之和」而不是某一个目标：首页是全局视角，
 * 没有上下文能确定用户此刻在写哪一本。若某本书没设目标，它就不进分母，
 * 也不会让比例凭空变小。
 */
function TodayTargetBar({
  written,
  target,
  loading
}: {
  written: number
  target: number
  loading: boolean
}) {
  const percent = progressPercent(written, target)

  if (loading) return <Skeleton.Input active size="small" block />

  if (percent === null) {
    return (
      <Paragraph type="secondary" className="dashboard-today__note">
        给书籍设置目标字数后，这里会显示今日完成度。
      </Paragraph>
    )
  }

  return (
    <Flex vertical gap={4}>
      <Progress percent={percent} size="small" />
      <Text type="secondary" className="dashboard-today__note">
        今日 {formatCount(written)} / 连载目标合计 {formatCompact(target)}
      </Text>
    </Flex>
  )
}

function ChartPlaceholder({ loading, text }: { loading: boolean; text: string }) {
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} title={false} />
  return (
    <Flex align="center" justify="center" className="chart-placeholder" data-testid="chart-empty">
      <Text type="secondary">{text}</Text>
    </Flex>
  )
}
