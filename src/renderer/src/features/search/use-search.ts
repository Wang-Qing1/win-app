import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { EMPTY_SEARCH_RESULT, parseKeywords, type SearchResult } from '@shared/modules/search'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { queryKeys } from '../../lib/query-keys'

/** 检索结果的缓存保留时长。浮层关掉后再开很快能命中缓存，久了就丢掉 */
const GC_MS = 30_000

export interface SearchState {
  data: SearchResult
  /** 切好的关键词（与后端同一份实现），界面据此显示实际生效的词条 */
  keywords: string[]
  loading: boolean
  error: ApiError | null
}

/**
 * 全库检索。
 *
 * 几个刻意的取舍：
 *
 * 1. **不防抖在这里**，由调用方（浮层）负责。理由是这个 hook 不知道
 *    「用户还在打字」还是「已经敲完了」；把延迟塞进来会让「按回车立即搜」
 *    也被拖延 250 毫秒，而回车是一个明确的「我输完了」信号。
 *
 * 2. `enabled` 由「浮层是否打开 + 是否有词」共同决定。空查询直接不发请求：
 *    全库扫描是有成本的，而「搜索框刚聚焦、还没输入」是极高频的状态。
 *
 * 3. `staleTime: 0` —— 每次打开浮层都重新查，避免展示已被编辑过的旧结果。
 *    这也是它不需要挂进 invalidateLibrary 的原因（见 queryKeys.search.query）。
 *
 * 4. `keepPreviousData`：每敲一个字就是一个新查询键，没有它结果列表会在
 *    每次输入时闪成空状态，而「边打字边看结果收敛」正是检索的核心体验。
 */
export function useSearch(rawKeywords: string, bookId: number | null, enabled: boolean): SearchState {
  const trimmed = rawKeywords.trim()
  const keywords = parseKeywords(trimmed)
  const active = enabled && keywords.length > 0

  const query = useQuery<SearchResult, ApiError>({
    queryKey: queryKeys.search.query({ keywords: trimmed, bookId }),
    queryFn: () => invoke(() => getBridge().search.query({ keywords: trimmed, bookId })),
    enabled: active,
    staleTime: 0,
    gcTime: GC_MS,
    placeholderData: keepPreviousData,
    // 检索是每次输入都跑的查询，失败时重试只会让用户多等三个来回
    retry: false
  })

  return {
    data: query.data ?? EMPTY_SEARCH_RESULT,
    keywords,
    // 有旧数据时不显示加载态：列表还在，只是正在收敛
    loading: active && query.isFetching && query.data === undefined,
    error: query.error ?? null
  }
}
