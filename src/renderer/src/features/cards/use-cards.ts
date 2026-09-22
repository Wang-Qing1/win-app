import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Card,
  CardCreateInput,
  CardIdInput,
  CardListQuery,
  CardListResult,
  CardRemovalResult,
  CardTimelineOrderInput,
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

/**
 * 删除一张卡片 —— 第三期第 5 件起是**移到回收站**，不是真的删掉。
 *
 * 因此比别的卡片操作多失效一组 `trash`：卡片列表少了一条的同时，
 * 回收站列表多了一条。漏掉它的表现是「删完卡片切到回收站，什么都没有」——
 * 用户会以为删除失败了，再删一次。
 * 仍然不走 invalidateLibrary：回收站里的卡片不影响任何字数与时长。
 */
export function useRemoveCard() {
  const queryClient = useQueryClient()
  return useMutation<CardRemovalResult, ApiError, CardIdInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.remove(input)),
    onSuccess: () =>
      Promise.all([
        invalidateCards(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.trash.all })
      ]).then(() => undefined)
  })
}

/**
 * 设定卡时间线重排。
 *
 * 与章节的 `reorder` 同样的取舍：不做乐观更新。序号由**整组顺序**决定，
 * 前端本地换一下位置虽然能立刻显示，但服务端会因为「卡片不属于这本书」
 * 「类别不一致」之类的理由拒绝 —— 那时界面已经先动过了，回滚比等待更晃眼。
 */
export function useSetTimelineOrder() {
  const queryClient = useQueryClient()
  return useMutation<Card[], ApiError, CardTimelineOrderInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.setTimelineOrder(input)),
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
