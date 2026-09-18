import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient
} from '@tanstack/react-query'
import type {
  Book,
  BookCreateInput,
  BookIdInput,
  BookListQuery,
  BookListResult,
  BookRemovalResult,
  BookUpdateInput
} from '@shared/modules/books'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { invalidateLibrary, queryKeys } from '../../lib/query-keys'

export function useBookList(query: BookListQuery) {
  return useQuery<BookListResult, ApiError>({
    queryKey: queryKeys.books.list(query),
    queryFn: () => invoke(() => getBridge().books.list(query)),
    // 翻页/搜索时保留上一页数据，避免整个书架闪成骨架屏
    placeholderData: keepPreviousData
  })
}

export function useBook(id: number | null) {
  return useQuery<Book, ApiError>({
    queryKey: queryKeys.books.detail(id ?? -1),
    queryFn: () => invoke(() => getBridge().books.get({ id: id as number })),
    // id 为空（比如路由参数还没解析出来）时不发请求
    enabled: id !== null && id > 0
  })
}

export function useBookStats() {
  return useQuery({
    queryKey: queryKeys.books.stats(),
    queryFn: () => invoke(() => getBridge().books.stats())
  })
}

export function useCreateBook() {
  const queryClient = useQueryClient()
  return useMutation<Book, ApiError, BookCreateInput>({
    mutationFn: (input) => invoke(() => getBridge().books.create(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useUpdateBook() {
  const queryClient = useQueryClient()
  return useMutation<Book, ApiError, BookUpdateInput>({
    mutationFn: (input) => invoke(() => getBridge().books.update(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

interface RemoveContext {
  previous: Array<[readonly unknown[], BookListResult | undefined]>
}

/**
 * 删除书籍：乐观更新。
 *
 * 本地 SQLite 删除几乎不可能失败，让用户等一个本地往返纯属浪费。
 * 但删书是破坏性操作（会连带删掉全部章节），因此乐观更新的前提是
 * 调用方已经做了二次确认 —— 这里假设确认已经完成。
 */
export function useRemoveBook() {
  const queryClient = useQueryClient()

  return useMutation<BookRemovalResult, ApiError, BookIdInput, RemoveContext>({
    mutationFn: (input) => invoke(() => getBridge().books.remove(input)),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.books.all })

      const previous = queryClient.getQueriesData<BookListResult>({
        queryKey: queryKeys.books.all
      })

      queryClient.setQueriesData<BookListResult>({ queryKey: queryKeys.books.all }, (current) => {
        if (!current || !Array.isArray(current.items)) return current
        const items = current.items.filter((item) => item.id !== input.id)
        const removed = current.items.length - items.length
        if (removed === 0) return current
        return { ...current, items, total: Math.max(0, current.total - removed) }
      })

      return { previous }
    },

    onError: (_error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data)
      }
    },

    onSettled: () => invalidateLibrary(queryClient)
  })
}
