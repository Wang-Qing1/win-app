import type { ReactNode } from 'react'
import { BulbOutlined, TeamOutlined, GiftOutlined } from '@ant-design/icons'
import type { CardType } from '@shared/modules/cards'

/**
 * 卡片的展示元数据。
 *
 * 标签文案来自共享层（`CARD_TYPE_LABELS`），这里只放**呈现**相关的东西：
 * 颜色与图标。分开是因为文案属于领域契约（主进程的报错信息里也要用），
 * 而颜色图标纯属界面选择，不该被主进程依赖。
 *
 * 颜色用 antd 的预设色名而不是写死 hex：预设色在浅色与深色主题下会各自
 * 取到合适的色值，写死 hex 在深色主题里对比度往往不够。
 */
export const CARD_TYPE_COLORS: Record<CardType, string> = {
  character: 'geekblue',
  item: 'gold',
  inspiration: 'magenta'
}

export const CARD_TYPE_ICONS: Record<CardType, ReactNode> = {
  character: <TeamOutlined />,
  item: <GiftOutlined />,
  inspiration: <BulbOutlined />
}
