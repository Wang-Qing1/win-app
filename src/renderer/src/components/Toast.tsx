import { useMemo } from 'react'
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
