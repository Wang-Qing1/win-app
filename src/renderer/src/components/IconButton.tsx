import type { ReactNode, Ref } from 'react'
import { Button, Tooltip } from 'antd'
import type { ButtonProps } from 'antd'

/** 语气。默认中性描边；`primary` 是「这一页唯一的那个主操作」；`danger` 是删除 */
export type IconButtonTone = 'default' | 'primary' | 'danger'

export interface IconButtonProps
  extends Omit<
    ButtonProps,
    'children' | 'icon' | 'shape' | 'type' | 'size' | 'danger' | 'aria-label'
  > {
  /**
   * 按钮的名字。
   *
   * 它同时是**悬浮提示文案**与 **`aria-label`** —— 两个都从这一个值来，
   * 所以不可能出现「提示改了、读屏还念旧的」。图标按钮画面上没有文字，
   * 这两个是它唯一的说明渠道。
   */
  label: string
  icon: ReactNode
  tone?: IconButtonTone
  /** 40px（顶栏与悬浮按钮的规格）。页面 / 面板头部默认 32px，见下方说明 */
  large?: boolean
  /** 提示浮层里的锚点，供冒烟测试读到「浮层真的弹出来了」 */
  tipTestId?: string
  ref?: Ref<HTMLAnchorElement | HTMLButtonElement>
}

/**
 * 圆形图标按钮 —— 页面与面板头部**唯一**的功能按钮形态。
 *
 * 用户 2026-09-20 先改的顶栏（「头部的所有功能图标都太丑了，需要修正为圆形
 * 只展示图标的功能按钮，所有的文字都移动到鼠标悬浮的提示中」），随后要求
 * 各个界面跟着统一（「各个界面中的图标也要跟着改，比如书籍详情页、大纲页、
 * 卡片页等」）。所以这个组件存在的意义不是「少写几行」——
 * 是让「正圆 + 只有图标 + 文字在提示里」这套形状**只有一处定义**。
 * 散着写的话，下一轮改尺寸时必然只改到一半，界面上就会出现两种圆。
 *
 * 尺寸为什么默认 32px 而不是顶栏那样的 40px：
 * 页面头部那一行里还站着 `Select` / `Segmented`（都是 32px），按钮比同排的
 * 控件高出一截，整行会看着参差；而且这些按钮改造前就是 32px 高的
 * `size="middle"` 按钮，保持 32px 意味着**行高一点没变**，这次改造是纯外观变化。
 *
 * 形状仍然由样式表里的 `.app-icon-button` 定义（正圆 = 圆角 50%，跟着宽度走），
 * 这里只负责挑规格与语气，不自己写 px。
 *
 * 三件容易漏掉的事已经收进来：
 *   1. **`aria-label` 与提示文案同源**。文字从画面上移走 ≠ 可以删掉 ——
 *      读屏软件只能靠 `aria-label` 知道这枚圆球是什么。
 *   2. **禁用时外面套一层 `span`**。禁用按钮不派发鼠标事件，Tooltip 永远
 *      不会出现；调用方不必各自记得这件事。
 *   3. **`ref` 透传**。`Popconfirm` / `Dropdown` 这类浮层触发器需要拿到真实
 *      DOM 节点才能把自己定位到按钮旁边，函数组件不透传 ref 就会飘到屏幕角落。
 */
export function IconButton({
  label,
  icon,
  tone = 'default',
  large = false,
  tipTestId,
  disabled,
  ref,
  ...rest
}: IconButtonProps) {
  const className = [
    'app-icon-button',
    large ? '' : 'app-icon-button--compact',
    tone === 'primary' ? 'app-icon-button--primary' : '',
    tone === 'danger' ? 'app-icon-button--danger' : ''
  ]
    .filter((item) => item.length > 0)
    .join(' ')

  const button = (
    <Button
      ref={ref}
      type="text"
      className={className}
      aria-label={label}
      icon={icon}
      disabled={disabled}
      {...rest}
    />
  )

  return (
    <Tooltip title={tipTestId ? <span data-testid={tipTestId}>{label}</span> : label}>
      {disabled ? <span className="icon-button__slot">{button}</span> : button}
    </Tooltip>
  )
}
