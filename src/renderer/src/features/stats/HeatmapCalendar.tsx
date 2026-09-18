import { useMemo } from 'react'
import { Flex, Tooltip, Typography } from 'antd'
import type { HeatmapCell, HeatmapResult } from '@shared/modules/stats'
import { useThemeMode } from '../../theme/ThemeProvider'

const { Text } = Typography

/**
 * 每级强度对应的颜色。
 *
 * 浅色主题下从灰到深蓝递进，深色主题下从深灰到亮蓝 —— 不能简单地
 * 把浅色那套色值搬过来：在深色底上「更深」反而意味着更不明显，
 * 于是热力图会呈现成「写得越多越看不见」的诡异效果。
 */
const LEVEL_COLORS: Record<'light' | 'dark', readonly string[]> = {
  light: ['#ebebeb', '#b5d4f4', '#85b7eb', '#378add', '#0f6cbd'],
  dark: ['#2f2f2f', '#14324d', '#1b527f', '#2a7cc4', '#479ef5']
}

const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', '日']

/** 周一为一周的第一天。JS 的 getDay() 里周日是 0，需要换算 */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  // 用本地时间构造，避免 new Date('2026-09-17') 按 UTC 解析造成差一天
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

interface HeatmapCalendarProps {
  result: HeatmapResult
}

/**
 * 写作热力日历。
 *
 * 刻意没有用图表库的 Heatmap 组件：那个是「两个维度 + 数值」的矩阵热力图，
 * 而日历需要的是「按真实星期排列的日期网格」，行列含义完全不同。
 * 用 CSS Grid 的 column 流自己排，反而更短、更可控。
 */
export function HeatmapCalendar({ result }: HeatmapCalendarProps) {
  const { mode } = useThemeMode()
  const colors = LEVEL_COLORS[mode]

  const { slots, monthLabels } = useMemo(() => {
    const cells = result.cells
    if (cells.length === 0) return { slots: [] as Array<HeatmapCell | null>, monthLabels: [] as Array<string | null> }

    // 按周分列：第一列前面补空位，让每天的格子落在正确的星期行上
    const columns: Array<Array<HeatmapCell | null>> = []
    let current: Array<HeatmapCell | null> = new Array<HeatmapCell | null>(7).fill(null)
    let slot = mondayIndex(parseDateKey(cells[0].date))

    for (const cell of cells) {
      current[slot] = cell
      slot += 1
      if (slot === 7) {
        columns.push(current)
        current = new Array<HeatmapCell | null>(7).fill(null)
        slot = 0
      }
    }
    if (slot > 0) columns.push(current)

    // 月份标签：只在「这个月第一次出现」的那一列上打标，
    // 否则每个月都会标好几次，看起来像刻度乱码
    const labels: Array<string | null> = []
    let lastMonth = -1
    for (const column of columns) {
      const first = column.find((cell): cell is HeatmapCell => cell !== null)
      if (!first) {
        labels.push(null)
        continue
      }
      const month = parseDateKey(first.date).getMonth()
      if (month !== lastMonth) {
        labels.push(`${month + 1} 月`)
        lastMonth = month
      } else {
        labels.push(null)
      }
    }

    return { slots: columns.flat(), monthLabels: labels }
  }, [result.cells])

  return (
    <Flex vertical gap={10} data-testid="heatmap">
      <Flex className="heatmap__months" gap={2}>
        <span className="heatmap__weekday-spacer" />
        {monthLabels.map((label, index) => (
          <span key={`month-${index}`} className="heatmap__month">
            {label}
          </span>
        ))}
      </Flex>

      <Flex className="heatmap__body" gap={6}>
        <div className="heatmap__weekdays">
          {WEEKDAY_LABELS.map((label, index) => (
            <span key={`weekday-${index}`} className="heatmap__weekday">
              {label}
            </span>
          ))}
        </div>

        <div className="heatmap__scroll">
          <div className="heatmap__grid" data-testid="heatmap-grid">
            {slots.map((cell, index) =>
              cell === null ? (
                <span key={`empty-${index}`} className="heatmap__cell heatmap__cell--empty" />
              ) : (
                <Tooltip
                  key={cell.date}
                  title={
                    cell.wordsWritten > 0
                      ? `${cell.date} · 写作量 ${cell.wordsWritten} 字`
                      : `${cell.date} · 没有写作记录`
                  }
                >
                  <span
                    className="heatmap__cell"
                    data-level={cell.level}
                    style={{ background: colors[cell.level] ?? colors[0] }}
                  />
                </Tooltip>
              )
            )}
          </div>
        </div>
      </Flex>

      <Flex align="center" justify="space-between" gap={12} wrap>
        <Text type="secondary" className="heatmap__summary">
          {result.activeDays} 天有写作 · 合计 {result.totalWordsWritten.toLocaleString('zh-CN')} 字
        </Text>
        <Flex align="center" gap={6}>
          <Text type="secondary" className="heatmap__legend-label">
            少
          </Text>
          {colors.map((color, index) => (
            <span
              key={`legend-${index}`}
              className="heatmap__cell heatmap__cell--legend"
              style={{ background: color }}
            />
          ))}
          <Text type="secondary" className="heatmap__legend-label">
            多
          </Text>
        </Flex>
      </Flex>
    </Flex>
  )
}
