import type { ReactNode } from 'react'

/**
 * 下拉菜单项的行：圆形图标 + 两行文字。
 *
 * 顶栏的 `…`（健康 / 备份 / 主题）与编辑器顶栏的书籍菜单（编辑信息 / 导出 /
 * 删除）共用同一份形状 —— 「低频操作怎么摆」全应用只该有一种答案，
 * 而圆形的判定规矩（宽 = 高、圆角 50%）也只有一份。
 *
 * `data-testid` 挂在行与图标上：冒烟要能分别量「这一项在不在」「图标是不是
 * 正圆」和「文字有没有丢」—— 只读菜单的整体文案，量不出圆形这件事。
 *
 * `statusIcon` 给「状态型」图标（一个状态点）用中性底：它不是一个可点的
 * 功能图标，套上强调色底会让人以为点它能做什么。
 */
export function MenuRow({
  testId,
  icon,
  title,
  hint,
  statusIcon = false
}: {
  testId: string
  icon: ReactNode
  title: string
  hint: string
  statusIcon?: boolean
}) {
  return (
    <span className="topbar-menu__row" data-testid={testId}>
      <span
        className={`topbar-menu__icon${statusIcon ? ' topbar-menu__icon--status' : ''}`}
        data-testid={`${testId}-icon`}
      >
        {icon}
      </span>
      <span className="topbar-menu__text">
        <span className="topbar-menu__title">{title}</span>
        <span className="topbar-menu__hint">{hint}</span>
      </span>
    </span>
  )
}
