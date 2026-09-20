import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  Chapter,
  ChapterCreateInput,
  ChapterIdInput,
  ChapterListItem,
  ChapterListQuery,
  ChapterMoveInput,
  ChapterReorderInput,
  ChapterSaveContentInput,
  ChapterSaveResult,
  ChapterUpdateInput
} from '@shared/modules/chapters'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { invalidateLibrary, queryKeys } from '../../lib/query-keys'

export function useChapterList(query: ChapterListQuery) {
  return useQuery<ChapterListItem[], ApiError>({
    queryKey: queryKeys.chapters.list(query),
    queryFn: () => invoke(() => getBridge().chapters.list(query)),
    enabled: query.bookId > 0
  })
}

/**
 * 章节详情（含正文）。
 *
 * staleTime 设为 Infinity：编辑器自己管理正文状态，
 * 让缓存再去重取只会带来「光标跳回开头」这类干扰。
 * 内容的新鲜度由编辑器负责，不由缓存负责。
 */
export function useChapter(id: number | null) {
  return useQuery<Chapter, ApiError>({
    queryKey: queryKeys.chapters.detail(id ?? -1),
    queryFn: () => invoke(() => getBridge().chapters.get({ id: id as number })),
    enabled: id !== null && id > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  })
}

export function useCreateChapter() {
  const queryClient = useQueryClient()
  return useMutation<ChapterListItem, ApiError, ChapterCreateInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.create(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useUpdateChapter() {
  const queryClient = useQueryClient()
  return useMutation<ChapterListItem, ApiError, ChapterUpdateInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.update(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useRemoveChapter() {
  const queryClient = useQueryClient()
  return useMutation<{ id: number }, ApiError, ChapterIdInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.remove(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useReorderChapters() {
  const queryClient = useQueryClient()
  return useMutation<{ count: number }, ApiError, ChapterReorderInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.reorder(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useMoveChapter() {
  const queryClient = useQueryClient()
  return useMutation<ChapterListItem, ApiError, ChapterMoveInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.move(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

/**
 * 保存正文。
 *
 * 成功后**不整体失效章节缓存**，而是把服务端回传的权威字数就地写回列表缓存。
 *
 * 原因是这个接口调用得极其频繁（打字时每 2 秒一次）。若每次都 invalidate，
 * 章节列表会被反复重取，而且编辑器自身的数据也会被判定过期 ——
 * 在我们的实现里那意味着一次全文比对，光标位置很可能丢失。
 *
 * 就地改写还要一个好处：列表里显示的字数与数据库里存的**永远是同一个值**，
 * 因为这个值就是服务端自己算出来并回传的，而不是前端另算一遍。
 */
/**
 * 保存正文。
 *
 * 成功后**不整体失效章节缓存**，而是就地写回两处：
 * 列表缓存里那个章节的字数（`patchChapterCounts`），以及**详情缓存里的正文**。
 *
 * 不整体 invalidate 的原因是这个接口调用得极其频繁（打字时每 2 秒一次）。
 * 若每次都 invalidate，章节列表会被反复重取，而且编辑器自身的数据也会被
 * 判定过期 —— 在我们的实现里那意味着一次全文比对，光标位置很可能丢失。
 *
 * 但**详情缓存必须跟着写**：详情查询是 `staleTime: Infinity`（见 `useChapter`），
 * 编辑器重新挂载时直接用缓存里的 `contentHtml` 起稿。只存库、不写缓存的话，
 * 「输入 → 跳去别处 → 回来」读到的是**这一章第一次加载时的旧正文** ——
 * 字其实已经存进库了，画面上却消失了，要重启应用才回来。
 * 用户 2026-09-20 报的就是这个：「输入文字后点击到其它地方返回来后
 * 输入的文字消失不见」。
 *
 * 就地写回不会打断正在编辑的人：编辑器实例只在「换了章节」时重建
 * （`RichTextEditor` 的依赖是 `chapterKey`），同章的缓存更新不会碰 doc。
 * 列表字数写的是服务端回传的权威值，前端不另算一遍。
 */
export function useSaveChapterContent() {
  const queryClient = useQueryClient()

  return useMutation<ChapterSaveResult, ApiError, ChapterSaveContentInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.saveContent(input)),
    onSuccess: (result, input) => {
      patchChapterCounts(queryClient, result)
      queryClient.setQueryData<Chapter>(queryKeys.chapters.detail(result.id), (old) =>
        old === undefined
          ? old
          : {
              ...old,
              contentHtml: input.contentHtml,
              hanziCount: result.hanziCount,
              charCount: result.charCount,
              updatedAt: result.updatedAt
            }
      )
    }
  })
}

function patchChapterCounts(client: QueryClient, result: ChapterSaveResult): void {
  client.setQueriesData<ChapterListItem[]>({ queryKey: queryKeys.chapters.lists }, (current) => {
    // 这个前缀下只会是列表（详情在 'detail' 前缀下），但保留守卫更稳：
    // 将来若有人往列表前缀下放别的形状，也不会被静默改坏
    if (!Array.isArray(current)) return current

    let touched = false
    const next = current.map((item) => {
      if (item.id !== result.id) return item
      touched = true
      return {
        ...item,
        hanziCount: result.hanziCount,
        charCount: result.charCount,
        updatedAt: result.updatedAt
      }
    })

    return touched ? next : current
  })
}
