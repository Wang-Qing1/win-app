import type { ReactNode } from 'react'
import { Flex, Typography } from 'antd'

const { Title } = Typography

interface PageHeaderProps {
  /** 页面标识。作为标题读出但不在画面上占位，见下方说明 */
  title: string
  /** 右侧操作区，通常是主按钮 */
  extra?: ReactNode
}

/**
 * 页面标题区。
 *
 * 这里不再显示可见的大标题与描述：顶部导航条已经常驻显示「当前在哪个模块」，
 * 页面内部再写一遍同一个名字是纯重复，而下面紧接着就是内容本身，
 * 用户不需要靠标题确认来对地方。省下来的纵向空间给了内容。
 *
 * 但标题没有从 DOM 里删掉，而是转成仅供辅助技术与冒烟测试读取的形式：
 *   - 屏幕阅读器跳转同级区首在路上依赖「每个页面有一个标题」，删干净会让
 *     读屏用户在路由切换后听不到任何上下文 —— 这是 `.sr-only` 而不是 `display:none`
 *     的原因（后者连辅助技术也读不到）。
 *   - `data-testid="page-title"` 是冒烟测试判断「当前在哪个页面」的锚点，
 *     抽成组件正是为了保证它不会在某个页面漏写。
 */
export function PageHeader({ title, extra }: PageHeaderProps) {
  return (
    <>
      <Title level={3} className="sr-only" data-testid="page-title">
        {title}
      </Title>
      {extra ? (
        <Flex align="center" justify="flex-end" gap={8} wrap>
          {extra}
        </Flex>
      ) : null}
    </>
  )
}
