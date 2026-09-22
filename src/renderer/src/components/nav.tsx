import type { ReactNode } from 'react'
import {
  BarChartOutlined,
  BookOutlined,
  DeleteOutlined,
  IdcardOutlined,
  PartitionOutlined
} from '@ant-design/icons'

/**
 * 功能模块清单 —— 应用导航的唯一来源。
 *
 * 信息架构（用户 2026-09-20 指定）：**首页即启动台**。
 *   - 应用启动落在首页，首页顶部那一排模块卡片就是导航；
 *   - 点卡片进入模块页，模块页顶栏左侧有「返回首页」图标回来；
 *   - 顶部不再常驻导航条 —— 它在 1280 宽的窗口里占掉整整一行，
 *     而模块只有五个、一天里并不会频繁来回切。
 *
 * 回收站（第三期第 5 件）是第五张卡。它本来更适合放在某个页面的角落
 * （它是个工具，不是一块工作区），但那样就得引入第二套导航机制
 * （顶栏图标 + 它自己去判断「我在哪」），而回收站确实是一个完整的页面。
 * 做成第五张卡的代价只是首页多一格 —— 五张仍放得下一行（实测每张
 * 116px 的内容区、等宽），换来的是「返回首页」按钮、当前模块高亮
 * 这些逻辑一行都不用改。
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
  /** 卡片上的一句话说明：模块名都很短，光看名字分不清边界 */
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
  },
  {
    key: 'trash',
    path: '/trash',
    label: '回收站',
    icon: <DeleteOutlined />,
    // 提示语刻意压到 15 字以内（与「卡片库」那条同量级）：五张卡片平分
    // 一行之后每张只有约 220px，提示语每多一行，整行卡片就一起长高
    hint: '删除的卡片与章节，可恢复或清除'
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
