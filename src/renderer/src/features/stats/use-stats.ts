import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionFinishInput, WritingSession } from '@shared/modules/sessions'
import type { BookProgressQuery, StatsTrendQuery, TrendResult, HeatmapResult, OverviewStats, BookProgressItem } from '@shared/modules/stats'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { invalidateAfterSession, queryKeys } from '../../lib/query-keys'

export function useOverview() {
  return useQuery<OverviewStats, ApiError>({
    queryKey: queryKeys.stats.overview(),
    queryFn: () => invoke(() => getBridge().stats.overview())
  })
}

/**
 * 字数与时长趋势。
 *
 * placeholderData 用 (previous) 保留上一次的数据：切换「近 7 天 / 近 30 天」
 * 时如果图表整块消失再重绘，视觉上是一次闪动；保留旧数据则只是曲线平滑地变过去。
 */
export function useTrend(query: StatsTrendQuery) {
  return useQuery<TrendResult, ApiError>({
    queryKey: queryKeys.stats.trend(query),
    queryFn: () => invoke(() => getBridge().stats.trend(query)),
    placeholderData: (previous) => previous
  })
}

export function useBookProgress(query: BookProgressQuery) {
  return useQuery<BookProgressItem[], ApiError>({
    queryKey: queryKeys.stats.books(query),
    queryFn: () => invoke(() => getBridge().stats.books(query)),
    placeholderData: (previous) => previous
  })
}

/**
 * 热力日历。
 *
 * key 里只放 days：bookId 目前界面不提供筛选，放进去会让
 * 「同一份数据在缓存里存了两份」，而两份的失效时机还不一致。
 */
export function useHeatmap(days: number) {
  return useQuery<HeatmapResult, ApiError>({
    queryKey: queryKeys.stats.heatmap(days),
    queryFn: () => invoke(() => getBridge().stats.heatmap({ days, bookId: null })),
    placeholderData: (previous) => previous
  })
}

/**
 * 结算一次写作会话。
 *
 * 这是让统计数字变准的关键时机：写作者离开编辑器或空闲 90 秒后调用一次。
 * 成功后要让统计与书籍缓存失效 —— 首页的「今日字数」「在写书籍」都依赖它们。
 */
export function useFinishSession() {
  const queryClient = useQueryClient()
  return useMutation<WritingSession, ApiError, SessionFinishInput>({
    mutationFn: (input) => invoke(() => getBridge().sessions.finish(input)),
    onSuccess: () => invalidateAfterSession(queryClient)
  })
}
