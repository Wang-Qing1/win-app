import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  OutlineAttachChapterInput,
  OutlineMaterializeInput,
  OutlineMaterializeResult,
  OutlineNode,
  OutlineNodeCreateInput,
  OutlineNodeIdInput,
  OutlineNodeMoveInput,
  OutlineNodeUpdateInput,
  OutlineTreeResult
} from '@shared/modules/outline'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { invalidateLibrary, queryKeys } from '../../lib/query-keys'

/**
 * 大纲树的失效范围。
 *
 * 刻意**不**走 `invalidateLibrary`：那个范围里包含统计模块（多次跨表
 * SUM 的聚合查询）。而拖拽一次就会调一次 move —— 拖拽过程中连续落点
 * 很常见，每次都让统计重算纯属浪费。树结构的变化不影响字数与时长，
 * 只失效树本身和书籍列表（更新的时间戳）就够。
 */
function invalidateOutline(client: QueryClient, bookId: number): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.outline.tree(bookId) }),
    client.invalidateQueries({ queryKey: queryKeys.books.all })
  ]).then(() => undefined)
}

/**
 * 整棵树。
 *
 * `staleTime` 给 30 秒：树在页面上是被频繁交互的对象（选中、展开），
 * 而这些交互不该触发重取。真正的变更会自己 invalidate。
 */
export function useOutlineTree(bookId: number | null) {
  return useQuery<OutlineTreeResult, ApiError>({
    queryKey: queryKeys.outline.tree(bookId ?? -1),
    queryFn: () => invoke(() => getBridge().outline.tree({ bookId: bookId as number })),
    enabled: bookId !== null && bookId > 0,
    staleTime: 30_000
  })
}

export function useCreateOutlineNode() {
  const queryClient = useQueryClient()
  return useMutation<OutlineNode, ApiError, OutlineNodeCreateInput>({
    mutationFn: (input) => invoke(() => getBridge().outline.create(input)),
    onSuccess: (_node, input) => invalidateOutline(queryClient, input.bookId)
  })
}

export function useUpdateOutlineNode() {
  const queryClient = useQueryClient()
  return useMutation<OutlineNode, ApiError, OutlineNodeUpdateInput & { bookId: number }>({
    mutationFn: ({ bookId: _bookId, ...input }) =>
      invoke(() => getBridge().outline.update(input)),
    onSuccess: (_node, input) => invalidateOutline(queryClient, input.bookId)
  })
}

export function useRemoveOutlineNode() {
  const queryClient = useQueryClient()
  return useMutation<
    { id: number; removedCount: number },
    ApiError,
    OutlineNodeIdInput & { bookId: number }
  >({
    mutationFn: ({ bookId: _bookId, ...input }) =>
      invoke(() => getBridge().outline.remove(input)),
    onSuccess: (_result, input) => invalidateOutline(queryClient, input.bookId)
  })
}

/**
 * 拖拽落点。
 *
 * 不做乐观更新：顺序由主进程基于数据库当前状态算出来，前端猜出来的
 * 新顺序在跨层拖动时会算错（还要重算所有兄弟的下标），猜错再回滚
 * 反而比直接等结果更晃眼。一次本地 IPC 往返足够快。
 */
export function useMoveOutlineNode() {
  const queryClient = useQueryClient()
  return useMutation<OutlineNode, ApiError, OutlineNodeMoveInput & { bookId: number }>({
    mutationFn: ({ bookId: _bookId, ...input }) =>
      invoke(() => getBridge().outline.move(input)),
    onSuccess: (_node, input) => invalidateOutline(queryClient, input.bookId)
  })
}

export function useAttachOutlineChapter() {
  const queryClient = useQueryClient()
  return useMutation<OutlineNode, ApiError, OutlineAttachChapterInput & { bookId: number }>({
    mutationFn: ({ bookId: _bookId, ...input }) =>
      invoke(() => getBridge().outline.attachChapter(input)),
    onSuccess: (_node, input) => invalidateOutline(queryClient, input.bookId)
  })
}

/**
 * 落地成章节。
 *
 * 这里用 `invalidateLibrary` 而不是 `invalidateOutline`：它真的会新建
 * 一个章节，图章列表、目录、统计都跟着变了。
 */
export function useMaterializeOutlineNode() {
  const queryClient = useQueryClient()
  return useMutation<
    OutlineMaterializeResult,
    ApiError,
    OutlineMaterializeInput & { bookId: number }
  >({
    mutationFn: ({ bookId: _bookId, ...input }) =>
      invoke(() => getBridge().outline.materialize(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}
