import { useCallback, useMemo } from 'react'
import { App } from 'antd'

/**
 * 全局提示。
 *
 * 对外接口刻意保持与自建实现完全一致（notifySuccess / notifyError），
 * 内部换成 antd 的 message：好处是它自动继承 ConfigProvider 的主题与
 * z-index 层级，并且带了进出场动画、最大数量限制、鼠标悬停暂停倒计时
 * 这些自建版本没有的细节。
 *
 * 注意不能用 `import { message } from 'antd'` 的静态方法——那会脱离
 * ConfigProvider 上下文，在深色主题下样式会不对。必须走 App.useApp()。
 */
export interface ToastApi {
  notifySuccess: (message: string) => void
  notifyError: (message: string) => void
}

export function useToast(): ToastApi {
  const { message } = App.useApp()

  return useMemo<ToastApi>(
    () => ({
      notifySuccess: (text: string) => {
        void message.success(text)
      },
      // 错误提示停留更久：用户往往需要读完再决定下一步，
      // 而且其中的追踪 ID 是要抄下来反馈问题的
      notifyError: (text: string) => {
        void message.error({ content: text, duration: 7 })
      }
    }),
    [message]
  )
}

export interface ConfirmOptions {
  title: string
  /** 说清「会发生什么、能不能撤」。删除类操作必须填，别只留一句「确定吗？」 */
  description?: string
  okText?: string
  danger?: boolean
}

/**
 * 二次确认。返回一个 Promise：确认 → true，取消 → false。
 *
 * 为什么要有它 —— 菜单项里的删除没法用 `Popconfirm`：
 * `Popconfirm` 需要一枚常驻的触发元素，而菜单项是浮层里的临时元素，
 * 点一下菜单就关了，「确认」气泡一起消失。所以从菜单里触发的破坏性操作
 * 只能走模态确认框。
 *
 * 走 `App.useApp()` 而不是 `Modal.confirm` 静态方法：静态方法会脱离
 * ConfigProvider 上下文，在深色主题下样式不对（同上面 message 的理由）。
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const { modal } = App.useApp()

  return useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title: options.title,
          content: options.description,
          okText: options.okText ?? '确定',
          cancelText: '取消',
          okButtonProps: options.danger ? { danger: true } : undefined,
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      }),
    [modal]
  )
}
