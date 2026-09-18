import type { ReactNode } from 'react'
import {
  BulbOutlined,
  BranchesOutlined,
  FlagOutlined,
  FileTextOutlined,
  NodeIndexOutlined,
  RocketOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { OutlineNodeType, OutlineStatus } from '@shared/modules/outline'

/**
 * 大纲的展示元数据。
 *
 * 标签文案来自共享层（`OUTLINE_NODE_TYPE_LABELS`），这里只放**呈现**相关的东西：
 * 颜色、图标、强调程度。分开是因为文案属于领域契约（主进程日志里也要用），
 * 而颜色图标纯属界面选择，不该被主进程依赖。
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

export const NODE_TYPE_ICONS: Record<OutlineNodeType, ReactNode> = {
  main: <FlagOutlined />,
  sub: <BranchesOutlined />,
  event: <ThunderboltOutlined />,
  foreshadow: <BulbOutlined />,
  twist: <RocketOutlined />,
  note: <FileTextOutlined />
}

/** 状态 → antd Badge 的 status 值。'dropped' 不用 error（红色太像故障），用 warning */
export const STATUS_BADGE: Record<OutlineStatus, 'default' | 'processing' | 'success' | 'warning'> = {
  planned: 'default',
  writing: 'processing',
  done: 'success',
  dropped: 'warning'
}

/** 节点行左侧的树图标 */
export const OUTLINE_NODE_ICON = <NodeIndexOutlined />
