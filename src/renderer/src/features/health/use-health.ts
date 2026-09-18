import { useQuery } from '@tanstack/react-query'
import type { HealthStatus } from '@shared/api'
import { ApiError, getBridge, invoke } from '../../lib/api-client'

/**
 * 启动自检。
 * 前端挂载后立刻问一次主进程「你还好吗」：能拿到响应就说明
 * IPC 通道、数据库、迁移都正常，比等用户点了按钮才发现问题强得多。
 */
export function useHealth() {
  return useQuery<HealthStatus, ApiError>({
    queryKey: ['health'],
    queryFn: () => invoke(() => getBridge().health.ping()),
    staleTime: 30_000,
    retry: 1
  })
}
