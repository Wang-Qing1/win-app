import type { ReactNode } from 'react'
import { Flex, Typography } from 'antd'

const { Title } = Typography

interface PageHeaderProps {
  /** 页面标识。**不显示在画面上**，只给读屏与冒烟测试当锚点 */
  title: string
  /** 右侧操作区，通常是主按钮 */
  extra?: ReactNode
}

/**
 * 页面标题区。
 *
 * **不显示标题**（用户 2026-09-20：「页标题移除，不要展示」）。上一版做成
 * 可见标题，理由是「顶部导航条移除后，标题是屏幕上唯一说明『你在哪』的东西」，
 * 用户直接否掉了这个取舍 —— 标题占一行、而模块身份由内容本身就说清了
 * （书架上是书、卡片库是卡、大纲是树、统计是图表），不需要一行字告诉你
 * 这是哪一页。
 *
 * 曾经有过一个例外：书籍详情页显示书名，因为那里「书名是内容，不是导航标签」。
 * 后来那一页整个取消了（用户 2026-09-20：「打开书籍后直接就是正文编辑界面」），
 * 书名改由编辑器顶栏显示 —— 那是同一页的另一条横带，不需要一个页标题例外。
 * **于是「页标题一律不显示」现在没有例外。** 规则变简单之后，`showTitle`
 * 这个开关也跟着删掉了：留着一个只有 false 一种取值的分支，下一个人只会
 * 猜它什么时候该是 true。
 *
 * 隐藏状态下保留 `data-testid="page-title"` 但**视觉隐藏**：
 *   - 冒烟测试靠它判断「当前在哪个路由」（断言的是文案对不对，不是看不看得见）
 *   - 读屏软件仍然能读到页面名，无障碍不能跟着视觉一起砍掉
 *
 * `extra`（各页的按钮 / 筛选器）不受影响，照常显示：它们是操作，不是标题。
 * 没有 `extra` 时**连外层都不渲染** —— `.sr-only` 是绝对定位的，能安全地
 * 单独作为一个 flex 子项存在（脱离布局流，不会被父级的 `gap` 算出一个
 * 空行的高度）。若还套一层空 Flex，父级 `gap: 16` 会在页顶留出 16px 死空间。
 */
export function PageHeader({ title, extra }: PageHeaderProps) {
  const heading = (
    <Title level={4} className="sr-only" data-testid="page-title">
      {title}
    </Title>
  )

  if (!extra) return heading

  return (
    /*
     * `flex-end` 而不是 `space-between`：标题是绝对定位的 `.sr-only`，
     * 不算 flex item，所以这里实际只有一个子项。`space-between` 在只有
     * 一个子项时会退化成 `flex-start` —— 各页的按钮会整体左移，看着像
     * 排版坏了。按钮本来就在右边，所以用 `flex-end`。
     */
    <Flex align="center" justify="flex-end" gap={12} className="page-header">
      {heading}
      <Flex align="center" justify="flex-end" gap={8} wrap className="page-header__extra">
        {extra}
      </Flex>
    </Flex>
  )
}
