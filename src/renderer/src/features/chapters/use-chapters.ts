import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  Chapter,
  ChapterCreateInput,
  ChapterIdInput,
  ChapterListItem,
  ChapterListQuery,
  ChapterMoveInput,
  ChapterReorderInput,
  ChapterRestoreInput,
  ChapterRestoreResult,
  ChapterRevision,
  ChapterRevisionSummary,
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

/* ------------------------------------------------------------------ *
 * 历史版本（第三期第 4 件）
 * ------------------------------------------------------------------ */

/**
 * 某一章的历史版本列表。
 *
 * **`staleTime: 0` 是必须的，不能靠全局默认值。**
 *
 * 全局默认是 `staleTime: 15_000`（见 lib/query-client.ts）。历史面板是
 * 「关掉再打开」的用法：作者打开面板发现是空的，写了几秒钟，再关掉、
 * 重新打开 —— 此时距上一次取数还不到 15 秒，缓存仍被判定为新鲜，
 * 于是**不再请求**，面板照旧显示那份空列表和「还没有可回退的版本」。
 * 而库里刚刚明明留下了一版。用户看到的正是他最怕的那句话
 * 「我的历史没了」，实际上只是缓存没失效。
 *
 * 面板的打开动作本身就是「我要看最新的」，每次都该重新取一次；
 * 它不常开，也不会产生后台轮询。
 */
export function useChapterRevisions(chapterId: number | null) {
  return useQuery<ChapterRevisionSummary[], ApiError>({
    queryKey: queryKeys.chapters.revisions(chapterId ?? -1),
    queryFn: () => invoke(() => getBridge().chapters.listRevisions({ chapterId: chapterId as number })),
    enabled: chapterId !== null && chapterId > 0,
    staleTime: 0
  })
}

/**
 * 取某一版的完整正文（点开一条版本看差异时用）。
 *
 * `staleTime: Infinity`：版本内容是**只读且不可变**的 —— 一版一旦写下来
 * 就不会再被修改（剪枝只会整条删掉）。因此同一个 id 取一次之后永远有效，
 * 反复点开同一版不该再发请求。
 */
export function useChapterRevision(id: number | null) {
  return useQuery<ChapterRevision, ApiError>({
    queryKey: [...queryKeys.chapters.revisions(-1).slice(0, 2), 'revision', id ?? -1] as const,
    queryFn: () => invoke(() => getBridge().chapters.getRevision({ id: id as number })),
    enabled: id !== null && id > 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  })
}

/**
 * 回档到某一版。
 *
 * 与「保存正文」的收尾方式刻意不同：这里**必须**同时把详情缓存里的
 * 正文改掉，因为回档的结果就是「正文变了」，而详情查询是
 * `staleTime: Infinity`（见 useChapter）—— 不写缓存的话，编辑器会拿着
 * 回档前的旧 HTML 继续显示，直到重启应用。
 *
 * 但同样**不整体 invalidate**：回档时编辑器正开着，让详情与列表全部重取
 * 会引发一次全文比对、光标跳回开头。就地写回这三处（列表字数、详情正文、
 * 版本列表失效）是最小的正确集合。
 *
 * 版本列表则要失效：回档会在服务端**再留一版**（回档前的正文），
 * 列表必须重取才能看到那条「撤销点」。
 */
export function useRestoreChapterRevision() {
  const queryClient = useQueryClient()

  return useMutation<ChapterRestoreResult, ApiError, ChapterRestoreInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.restoreRevision(input)),
    onSuccess: (result, input) => {
      // 复用与保存正文完全相同的就地写回：服务端回传的字数就是权威值
      patchChapterCounts(queryClient, result)

      queryClient.setQueryData<Chapter>(queryKeys.chapters.detail(result.id), (old) => {
        if (old === undefined) return old
        return {
          ...old,
          contentHtml: revisionHtmlCache.get(input.revisionId) ?? old.contentHtml,
          hanziCount: result.hanziCount,
          charCount: result.charCount,
          updatedAt: result.updatedAt
        }
      })

      void queryClient.invalidateQueries({ queryKey: queryKeys.chapters.revisions(input.chapterId) })
    }
  })
}

/**
 * 回档时要写进详情缓存的 HTML 来源。
 *
 * 回档接口本身只回传字数，不回传正文（正文在版本详情查询里，前端手里
 * 已经有）。用一个按 version id 索引的临时表把「用户点的那一版的 HTML」
 * 交给 onSuccess —— 比在 mutation 变量里再塞一份 HTML（那会让类型
 * 偏离 ChapterRestoreInput 这个共享契约）更干净。
 *
 * 只在一次点击的范围内有效，写完即清。
 */
const revisionHtmlCache = new Map<number, string>()

/** 记录用户即将回档到的那一版正文，供 useRestoreChapterRevision 写缓存用 */
export function rememberRevisionHtml(revisionId: number, contentHtml: string): void {
  revisionHtmlCache.set(revisionId, contentHtml)
  // 一次点击最多用到一条；上一条留着只会让这个表慢慢长大
  if (revisionHtmlCache.size > 4) {
    const oldest = revisionHtmlCache.keys().next().value
    if (oldest !== undefined) revisionHtmlCache.delete(oldest)
  }
}
