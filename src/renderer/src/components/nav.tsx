import type { ReactNode } from 'react'
import {
  BarChartOutlined,
  BookOutlined,
  HomeOutlined,
  PartitionOutlined,
  IdcardOutlined
} from '@ant-design/icons'

/**
 * 顶部导航配置。
 *
 * 这里是导航的唯一来源：导航条渲染、面包屑、页面标题都读它。
 * 分散写会导致「导航改了名字、页面标题还是旧的」这类不一致。
 *
 * ready=false 的条目会以禁用样式显示并标注「开发中」，而不是直接隐藏。
 * 隐藏会让用户以为功能不存在；显示出来则能让人知道路线图，也便于验证
 * 信息架构是否符合预期。
 */
export interface NavItem {
  key: string
  /** 路由路径。'/' 为首页 */
  path: string
  label: string
  icon: ReactNode
  /** 悬停提示，说明这个模块是干什么的 */
  hint: string
  ready: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'dashboard',
    path: '/',
    label: '首页',
    icon: <HomeOutlined />,
    hint: '写作总览与快捷入口',
    ready: true
  },
  {
    key: 'books',
    path: '/books',
    label: '书籍管理',
    icon: <BookOutlined />,
    hint: '书籍、分卷与章节正文',
    ready: true
  },
  {
    key: 'outline',
    path: '/outline',
    label: '大纲管理',
    icon: <PartitionOutlined />,
    hint: '自由多层情节树，节点可落地成章节',
    ready: true
  },
  {
    key: 'cards',
    path: '/cards',
    label: '卡片库',
    icon: <IdcardOutlined />,
    hint: '人物、物品、灵感三类卡片，可归属到某本书',
    ready: true
  },
  {
    key: 'stats',
    path: '/stats',
    label: '时间与字数',
    icon: <BarChartOutlined />,
    hint: '字数趋势、写作时长与热力日历',
    ready: true
  }
] as const

/** 首页四张功能入口卡片读的就是这份清单，保证与导航条永远一致 */
export const DASHBOARD_MODULES = NAV_ITEMS.filter((item) => item.key !== 'dashboard')

/**
 * 由当前路径反查导航项。
 *
 * 详情页与编辑器这类深层路由要归属到它们的父模块上，
 * 否则用户进到章节编辑器后导航条会没有任何高亮项，看起来像迷路了。
 */
export function findActiveNavKey(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'dashboard'

  const matched = NAV_ITEMS.find((item) => item.path !== '/' && pathname.startsWith(item.path))
  return matched?.key ?? 'dashboard'
}
