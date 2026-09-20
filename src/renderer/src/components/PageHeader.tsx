import type { ReactNode } from 'react'
import { Flex, Typography } from 'antd'

const { Title } = Typography

interface PageHeaderProps {
  /** 页面标识。默认**不显示在画面上**，只给读屏与冒烟测试当锚点 */
  title: string
  /**
   * 把标题显示到画面上。
   *
   * 只有**标题本身是内容**的页面才开：当前只有书籍详情页 —— 那里的标题是
   * 书名，不是一个「第几页」的导航标签。详见下方说明。
   */
  showTitle?: boolean
  /** 右侧操作区，通常是主按钮 */
  extra?: ReactNode
}

/**
 * 页面标题区。
 *
 * **默认不显示**（用户 2026-09-20：「页标题移除，不要展示」）。上一版做成
 * 可见标题，理由是「顶部导航条移除后，标题是屏幕上唯一说明『你在哪』的东西」，
 * 用户直接否掉了这个取舍 —— 标题占一行、而模块身份由内容本身就说清了
 * （书架上是书、卡片库是卡、大纲是树、统计是图表），不需要一行字告诉你
 * 这是哪一页。
 *
 * 所以默认状态下保留 `data-testid="page-title"` 的元素但**视觉隐藏**：
 *   - 冒烟测试靠它判断「当前在哪个路由」（断言的是文案对不对，不是看不看得见）
 *   - 读屏软件仍然能读到页面名，无障碍不能跟着视觉一起砍掉
 *
 * `showTitle` 是这条规则唯一的例外（用户 2026-09-20 追加：「书籍详情页需要
 * 显示书籍名称，原标题的位置应该显示书籍名称」）。判断依据不是「哪一页更特殊」，
 * 而是**这个字符串是不是内容**：
 *   - 「书籍管理 / 卡片库 / 大纲管理 / 统计」是**导航标签** —— 内容已经说明了自己，
 *     标签是冗余的，所以隐掉；
 *   - 书籍详情页的标题是**书名** —— 它是这本书的身份，页面里没有别处写着它
 *     （分卷、章节、字数都只是它的属性）。隐掉它等于把「我在哪本书里」这条
 *     信息从画面上删掉了，用户只能退回书架去认。
 *
 * 例外只开给「内容型标题」，不因为「某一页内容少」而开：内容少的页面靠卡片
 * 与表格同样能认出自己，加回标题只会让同一套界面出现两种规矩。
 *
 * `extra`（各页的按钮 / 筛选器）不受影响，照常显示：它们是操作，不是标题。
 * 没有 `extra` 时**连外层都不渲染** —— `.sr-only` 是绝对定位的，能安全地
 * 单独作为一个 flex 子项存在（脱离布局流，不会被父级的 `gap` 算出一个
 * 空行的高度）。若还套一层空 Flex，父级 `gap: 16` 会在页顶留出 16px 死空间。
 * （`showTitle` 为真时无所谓 —— 那种情况下这个子项本来就有尺寸。）
 */
export function PageHeader({ title, showTitle = false, extra }: PageHeaderProps) {
  const heading = (
    <Title
      level={4}
      className={showTitle ? 'page-header__title' : 'sr-only'}
      data-testid="page-title"
    >
      {title}
    </Title>
  )

  if (!extra) return heading

  return (
    /*
     * justify 随标题是否可见切换，而不是固定一个值：
     *   - 标题隐藏时只剩 `extra` 一个**布局流里的**子元素（`.sr-only` 是绝对
     *     定位，不算 flex item），`space-between` 在只有一个子项时会退化成
     *     `flex-start` —— 各页的按钮会整体左移，看着像排版坏了。按钮本来就在
     *     右边，所以这时用 `flex-end`。
     *   - 标题可见时用 `space-between`：标题贴左、操作区贴右，也就是「原标题的
     *     位置」。这是书籍详情页要的排布。
     */
    <Flex
      align="center"
      justify={showTitle ? 'space-between' : 'flex-end'}
      gap={12}
      className="page-header"
    >
      {heading}
      <Flex align="center" justify="flex-end" gap={8} wrap className="page-header__extra">
        {extra}
      </Flex>
    </Flex>
  )
}
