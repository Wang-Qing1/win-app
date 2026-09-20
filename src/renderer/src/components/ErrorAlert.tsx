import { Alert, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { ApiError, toUserMessage } from '../lib/api-client'
import { IconButton } from './IconButton'

const { Text } = Typography

interface ErrorAlertProps {
  error: unknown
  /** 覆盖主文案，用于「加载失败」这类场景化标题 */
  title?: string
  onRetry?: () => void
}

/**
 * 统一错误展示。
 *
 * 把 ApiError 的追踪 ID 一并显示出来 —— 用户报障时凭这个 ID
 * 可以直接在主进程日志里定位到那一次调用，省掉一轮「你再试试」。
 *
 * 冲突类错误降级为 warning：它通常不是故障，而是业务规则
 * （例如重名），用红色只会让用户以为程序坏了。
 */
export function ErrorAlert({ error, title, onRetry }: ErrorAlertProps) {
  const message = toUserMessage(error)
  const requestId = error instanceof ApiError ? error.requestId : null
  const isConflict = error instanceof ApiError && error.code === 'CONFLICT'
  const hasTrace = requestId !== null && requestId !== '-'

  // Alert 只要收到 description 就会渲染描述区，哪怕内容为空片段也会撑出一块空白，
  // 所以没有可展示内容时必须传 undefined
  const description =
    title || hasTrace ? (
      <>
        {title ? <div>{message}</div> : null}
        {hasTrace ? (
          <Text type="secondary" className="error-alert__trace">
            追踪 ID：{requestId}
          </Text>
        ) : null}
      </>
    ) : undefined

  return (
    <Alert
      type={isConflict ? 'warning' : 'error'}
      showIcon
      message={title ?? message}
      description={description}
      action={
        onRetry ? (
          <IconButton label="重试" icon={<ReloadOutlined />} onClick={onRetry} />
        ) : undefined
      }
    />
  )
}
