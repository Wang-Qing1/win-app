import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  TrashEmptyInput,
  TrashEmptyResult,
  TrashItemInput,
  TrashItemRef,
  TrashListInput,
  TrashListResult
} from '@shared/modules/trash'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { invalidateLibrary, queryKeys } from '../../lib/query-keys'

/**
 * 回收站列表。
 *
 * `staleTime: 0`（全局默认是 15 秒之外的取值，这里显式写死 0）：
 * 这一页的使用方式就是「删掉东西 → 立刻过来看它在不在」，
 * 而列表的变更源全在别的页面上（卡片库、编辑器）。若沿用默认的
 * 15 秒新鲜期，从卡片库删一张卡再切到回收站，读到的会是上一次
 * 打开这一页时的**空列表缓存** —— 用户看到「回收站是空的」，
 * 而库里明明有。这正是第 4 件（历史版本）踩过的同一个坑：
 * 「关掉再打开」是用户的刷新动作，缓存必须让它真的重新取数。
 *
 * 反过来它不需要 keepPreviousData：回收站条目少，切页签时闪一下
 * 骨架屏比留着一份「另一个页签的数据」更不误导。
 */
export function useTrashList(kind: string) {
  const input: TrashListInput = { kind: kind === '' ? null : (kind as TrashListInput['kind']) }
  return useQuery<TrashListResult, ApiError>({
    queryKey: queryKeys.trash.list(kind),
    queryFn: () => invoke(() => getBridge().trash.list(input)),
    staleTime: 0
  })
}

/**
 * 回收站的写操作与别的模块**反过来**：这里动的东西会影响整个应用。
 *
 * 从回收站恢复一章，这本书的字数变了、目录变了、统计变了、检索结果变了 ——
 * 所以一律走 `invalidateLibrary`（它覆盖书籍 / 分卷 / 章节 / 大纲 / 卡片 /
 * 回收站 / 统计七组），而不是像卡片那样只失效自己那一组。
 * 彻底删除同理：它会让关联与章节历史版本一起消失。
 *
 * 不做乐观更新：恢复的落点由主进程决定（章节会落到所属容器的末尾），
 * 前端猜出来的位置在「容器里刚加过别的章」时必然猜错 —— 猜错再回滚
 * 比等那一下更晃眼。
 */
function invalidateAll(client: ReturnType<typeof useQueryClient>): Promise<void> {
  return invalidateLibrary(client)
}

export function useRestoreTrash() {
  const queryClient = useQueryClient()
  return useMutation<TrashItemRef, ApiError, TrashItemInput>({
    mutationFn: (input) => invoke(() => getBridge().trash.restore(input)),
    onSuccess: () => invalidateAll(queryClient)
  })
}

export function usePurgeTrash() {
  const queryClient = useQueryClient()
  return useMutation<TrashItemRef, ApiError, TrashItemInput>({
    mutationFn: (input) => invoke(() => getBridge().trash.purge(input)),
    onSuccess: () => invalidateAll(queryClient)
  })
}

export function useEmptyTrash() {
  const queryClient = useQueryClient()
  return useMutation<TrashEmptyResult, ApiError, Partial<TrashEmptyInput>>({
    mutationFn: (input) => invoke(() => getBridge().trash.empty(input)),
    onSuccess: () => invalidateAll(queryClient)
  })
}
