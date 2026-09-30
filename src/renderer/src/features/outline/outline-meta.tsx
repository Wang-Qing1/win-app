import type { OutlineNodeType, OutlineStatus } from '@shared/modules/outline'

/**
 * 大纲的展示元数据。
 *
 * 标签文案来自共享层（`OUTLINE_NODE_TYPE_LABELS`），这里只放**呈现**相关的东西：
 * 颜色与状态徽标。分开是因为文案属于领域契约（后端日志里也要用），
 * 而颜色纯属界面选择，不该被后端依赖。
 *
 * 颜色使用 antd 的预设色名（而不是写死 hex）：预设色在浅色与深色主题下
 * 会自动取到各自合适的色值，写死 hex 在深色主题里对比度会不够。
 */

export const NODE_TYPE_COLORS: Record<OutlineNodeType, string> = {
  main: 'blue',
  sub: 'cyan',
  event: 'green',
  foreshadow: 'purple',
  twist: 'volcano',
  note: 'default'
}

/** 状态 → antd Badge 的 status 值。'dropped' 不用 error（红色太像故障），用 warning */
export const STATUS_BADGE: Record<OutlineStatus, 'default' | 'processing' | 'success' | 'warning'> = {
  planned: 'default',
  writing: 'processing',
  done: 'success',
  dropped: 'warning'
}
