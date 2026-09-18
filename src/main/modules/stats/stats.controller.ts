import { IpcChannel } from '@shared/ipc-channels'
import {
  bookProgressQuerySchema,
  normalizeBookProgressQuery,
  normalizeStatsTrendQuery,
  statsHeatmapQuerySchema,
  statsTrendQuerySchema
} from '@shared/modules/stats'
import { registerHandler } from '../../core/ipc-handler'
import type { StatsService } from './stats.service'

/**
 * 控制器层：解析请求 → 调用服务 → 返回结果。
 * 全部是只读聚合，没有写通道 —— 统计模块不产生数据，只解释数据。
 */
export function registerStatsHandlers(service: StatsService): void {
  registerHandler(IpcChannel.StatsOverview, {
    label: '查询总览统计',
    handle: () => service.overview()
  })

  registerHandler(IpcChannel.StatsTrend, {
    label: '查询字数趋势',
    parse: (raw) => normalizeStatsTrendQuery(statsTrendQuerySchema.parse(raw ?? {})),
    handle: (query) => service.trend(query)
  })

  registerHandler(IpcChannel.StatsBooks, {
    label: '查询分书统计',
    parse: (raw) => normalizeBookProgressQuery(bookProgressQuerySchema.parse(raw ?? {})),
    handle: (query) => service.books(query)
  })

  registerHandler(IpcChannel.StatsHeatmap, {
    label: '查询写作热力图',
    parse: (raw) => statsHeatmapQuerySchema.parse(raw ?? {}),
    handle: (query) => service.heatmap(query.days, query.bookId)
  })
}
