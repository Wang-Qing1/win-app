import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api-client'

/** 4xx 类错误不重试；仅服务端内部错误自动重试，上限 3 次 */
export const MAX_RETRY_ATTEMPTS = 3

export function isRetryableError(error: unknown): boolean {
  return error instanceof ApiError && error.retryable
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => isRetryableError(error) && failureCount < MAX_RETRY_ATTEMPTS,
      retryDelay: (attempt) => Math.min(600 * 2 ** attempt, 6000),
      staleTime: 15_000,
      // 桌面应用窗口切换极其频繁，每次聚焦都重新拉数据只会制造无谓请求
      refetchOnWindowFocus: false
    },
    mutations: {
      // 写操作一律不自动重试：重试可能造成重复写入
      retry: false
    }
  }
})
