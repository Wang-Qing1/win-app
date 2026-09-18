import { useMemo } from 'react'
import { theme } from 'antd'
import { Area, Column } from '@ant-design/plots'
import type { DailyWordsPoint } from '@shared/modules/stats'
import { ChartBoundary } from '../../components/ChartBoundary'

/**
 * 写作趋势图。
 *
 * 颜色取自 antd 的设计令牌而不是写死色值：这样深浅主题切换时图表会跟着变。
 * 图表库自己那套主题读不到我们 ConfigProvider 里的 Fluent 配色，
 * 若用它的默认蓝，图表和旁边的按钮就会是两种不同的蓝，一眼能看出拼凑感。
 */
interface TrendChartProps<T> {
  data: T[]
  xField: string
  yField: string
  height?: number
  /** 数值格式化，用于坐标轴与 tooltip */
  valueFormatter?: (value: number) => string
  /** 曲线上方是否填充，折线图传 false */
  filled?: boolean
  label: string
}

function TrendChartBase<T extends object>({
  data,
  xField,
  yField,
  height = 210,
  valueFormatter,
  filled = true,
  label
}: TrendChartProps<T>) {
  const { token } = theme.useToken()

  const config = useMemo(
    () => ({
      data,
      xField,
      yField,
      height,
      autoFit: true,
      // 关掉入场动画：桌面应用每次切页面都重放一遍动画很啰嗦，
      // 而且首屏动画期间图表是空的，会让人以为没数据
      animate: false,
      shapeField: filled ? 'smooth' : undefined,
      line: { style: { stroke: token.colorPrimary, lineWidth: 2 } },
      style: filled
        ? { fill: token.colorPrimaryBg, fillOpacity: 0.9 }
        : { fill: 'transparent' },
      axis: {
        x: {
          // 日期标签横排，旋转过的文字在窄窗口里会挤到看不清
          labelAutoRotate: false,
          labelFormatter: (value: string) => shortDate(value)
        },
        y: {
          labelFormatter: (value: number) => (valueFormatter ? valueFormatter(value) : String(value))
        }
      },
      tooltip: {
        // 点数据的形状由调用方决定（趋势点、分卷点……），字段名是运行时才知道的
        // 字符串，所以这里只能按索引签名取值，不硬塞一个约束给调用方
        title: (item: T) => String((item as Record<string, unknown>)[xField] ?? ''),
        items: [
          {
            channel: 'y',
            name: label,
            valueFormatter: (value: number) =>
              valueFormatter ? valueFormatter(value) : String(value)
          }
        ]
      }
    }),
    [data, xField, yField, height, valueFormatter, filled, label, token.colorPrimary, token.colorPrimaryBg]
  )

  return <ChartBoundary label={label}>{<Area {...config} />}</ChartBoundary>
}

/** 写作时长的柱状图。用柱而不是线：时长是「每天的累计量」，柱状更容易逐天比较 */
function DurationChartBase({ data, height = 210 }: { data: DailyWordsPoint[]; height?: number }) {
  const { token } = theme.useToken()

  const config = useMemo(
    () => ({
      data,
      xField: 'date',
      yField: 'durationSeconds',
      height,
      autoFit: true,
      animate: false,
      style: { fill: token.colorPrimary, radiusTopLeft: 3, radiusTopRight: 3 },
      axis: {
        x: { labelAutoRotate: false, labelFormatter: (value: string) => shortDate(value) },
        y: {
          labelFormatter: (value: number) => `${Math.round(value / 60)} 分`
        }
      },
      tooltip: {
        title: (item: DailyWordsPoint) => item.date,
        items: [
          {
            channel: 'y',
            name: '写作时长',
            valueFormatter: (value: number) => `${Math.round(value / 60)} 分钟`
          }
        ]
      }
    }),
    [data, height, token.colorPrimary]
  )

  return <ChartBoundary label="写作时长">{<Column {...config} />}</ChartBoundary>
}

/** '2026-09-17' → '9/17'。坐标轴上完整日期太长，会把刻度挤成两行 */
function shortDate(value: string): string {
  const parts = value.split('-')
  if (parts.length !== 3) return value
  return `${Number(parts[1])}/${Number(parts[2])}`
}

export const TrendChart = TrendChartBase
export const WritingDurationChart = DurationChartBase
