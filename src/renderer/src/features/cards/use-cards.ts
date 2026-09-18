import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Card,
  CardCreateInput,
  CardIdInput,
  CardListQuery,
  CardListResult,
  CardRemovalResult,
  CardUpdateInput
} from '@shared/modules/cards'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { queryKeys } from '../../lib/query-keys'

/**
 * 卡片列表。
 *
 * `keepPreviousData` 是必需的：筛选与翻页都由这个 query 驱动，
 * 没有它每改一次筛选整个列表就闪成骨架屏，而卡片库的操作节奏就是
 * 「不断切换类型/关键字」——闪烁会让人以为数据没了。
 */
export function useCardList(query: CardListQuery) {
  return useQuery<CardListResult, ApiError>({
    queryKey: queryKeys.cards.list(query),
    queryFn: () => invoke(() => getBridge().cards.list(query)),
    placeholderData: keepPreviousData
  })
}

/**
 * 卡片变更后只失效卡片列表。
 *
 * 刻意不走 `invalidateLibrary`：那个范围包含统计模块（多次跨表 SUM 的聚合）。
 * 卡片是写作的**辅助材料**，增删一张卡不改变任何字数与时长，
 * 没必要让首页与统计页重算一遍。
 */
function invalidateCards(client: ReturnType<typeof useQueryClient>): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.cards.all }).then(() => undefined)
}

export function useCreateCard() {
  const queryClient = useQueryClient()
  return useMutation<Card, ApiError, CardCreateInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.create(input)),
    onSuccess: () => invalidateCards(queryClient)
  })
}

export function useUpdateCard() {
  const queryClient = useQueryClient()
  return useMutation<Card, ApiError, CardUpdateInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.update(input)),
    onSuccess: () => invalidateCards(queryClient)
  })
}

export function useRemoveCard() {
  const queryClient = useQueryClient()
  return useMutation<CardRemovalResult, ApiError, CardIdInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.remove(input)),
    onSuccess: () => invalidateCards(queryClient)
  })
}

/**
 * 复制一张卡片。
 *
 * 不做乐观更新：副本的标题由主进程生成（要避开同书同类型下的重名），
 * 前端猜出来的名字在「已经有一张叫 X 副本」时必然猜错，猜错再回滚更晃眼。
 */
export function useDuplicateCard() {
  const queryClient = useQueryClient()
  return useMutation<Card, ApiError, CardIdInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.duplicate(input)),
    onSuccess: () => invalidateCards(queryClient)
  })
}
