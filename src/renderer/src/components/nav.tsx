import type { ReactNode } from 'react'
import {
  BarChartOutlined,
  BookOutlined,
  IdcardOutlined,
  PartitionOutlined
} from '@ant-design/icons'

/**
 * 功能模块清单 —— 应用导航的唯一来源。
 *
 * 信息架构（用户 2026-09-20 指定）：**首页即启动台**。
 *   - 应用启动落在首页，首页顶部四张模块卡片就是导航；
 *   - 点卡片进入模块页，模块页顶栏左侧有「返回首页」图标回来；
 *   - 顶部不再常驻导航条 —— 它在 1280 宽的窗口里占掉整整一行，
 *     而模块一共只有四个、一天里并不会频繁来回切。
 *
 * 为什么仍然集中在这里、而不是散写在首页里：
 *   顶栏要用它反查「现在在哪个模块」，好让悬浮的返回按钮写清楚退到哪
 *   （`findActiveModule`）；改名字时只有一处要改。
 */
export interface ModuleItem {
  key: string
  /** 路由路径 */
  path: string
  label: string
  icon: ReactNode
  /** 卡片上的一句话说明：四个模块的名字都只有四个字，光看名字分不清边界 */
  hint: string
}

export const MODULE_ITEMS: readonly ModuleItem[] = [
  {
    key: 'books',
    path: '/books',
    label: '书籍管理',
    icon: <BookOutlined />,
    hint: '书籍、分卷与章节正文'
  },
  {
    key: 'outline',
    path: '/outline',
    label: '大纲管理',
    icon: <PartitionOutlined />,
    hint: '自由多层情节树，节点可落地成章节'
  },
  {
    key: 'cards',
    path: '/cards',
    label: '卡片库',
    icon: <IdcardOutlined />,
    hint: '人物、物品、灵感三类卡片，可归属到某本书'
  },
  {
    key: 'stats',
    path: '/stats',
    label: '时间与字数',
    icon: <BarChartOutlined />,
    hint: '字数趋势、写作时长与热力日历'
  }
] as const

/** 首页路径。顶栏靠它决定要不要显示「返回首页」图标 */
export const HOME_PATH = '/'

/**
 * 由当前路径反查所属模块。
 *
 * 详情页（`/books/3/chapters/12`）也要归属到它的父模块上：否则顶栏在
 * 编辑章节时会认为自己「不在任何模块里」，返回按钮的语义就说不清了。
 */
export function findActiveModule(pathname: string): ModuleItem | null {
  if (pathname === HOME_PATH || pathname === '') return null
  return MODULE_ITEMS.find((item) => pathname.startsWith(item.path)) ?? null
}
