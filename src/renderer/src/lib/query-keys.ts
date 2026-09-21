import type { QueryClient } from '@tanstack/react-query'
import type { BookListQuery } from '@shared/modules/books'
import type { CardListQuery } from '@shared/modules/cards'
import type { ChapterListQuery } from '@shared/modules/chapters'
import type { SessionListQuery } from '@shared/modules/sessions'
import type { BookProgressQuery, StatsTrendQuery } from '@shared/modules/stats'

/**
 * React Query 的键集中定义。
 *
 * 集中而不是各 hook 自己写数组字面量：失效范围是跨模块的——
 * 保存一章正文要同时让书籍列表、统计概览、趋势图失效。
 * 键散在四处时，漏掉某一个的表现是「界面上的数字不更新」，
 * 而且刷新一下就好了，很难被当成 bug 报出来。
 */
export const queryKeys = {
  health: () => ['health'] as const,

  books: {
    all: ['books'] as const,
    list: (query: BookListQuery) => ['books', 'list', query] as const,
    detail: (id: number) => ['books', 'detail', id] as const,
    stats: () => ['books', 'stats'] as const
  },

  volumes: {
    all: ['volumes'] as const,
    list: (bookId: number) => ['volumes', 'list', bookId] as const
  },

  chapters: {
    all: ['chapters'] as const,
    /**
     * 只命中「章节列表」，不命中「章节详情」。
     *
     * 这个区分是必要的：结算写作会话时（编辑器空闲 90 秒或关闭）需要刷新
     * 列表里的字数，但绝不能顺带让正在编辑的正文被判定为过期 ——
     * 一次重取就意味着编辑器要拿服务端的 HTML 去覆盖本地文档，
     * 表现是光标跳回开头。列表与详情必须能分别失效。
     */
    lists: ['chapters', 'list'] as const,
    list: (query: ChapterListQuery) => ['chapters', 'list', query] as const,
    detail: (id: number) => ['chapters', 'detail', id] as const
  },

  outline: {
    all: ['outline'] as const,
    /**
     * 整棵树一次取回，所以只有一个键。
     *
     * 不做按层懒加载：一本书的大纲节点在几百的量级，一次序列化比
     * 「展开一级发一次请求」简单得多，而且拖拽时上下文的树是完整一致的
     * （环检测、深度判断都需要全貌，分片取回来的数据做不了这些判断）。
     */
    tree: (bookId: number) => ['outline', 'tree', bookId] as const
  },

  cards: {
    all: ['cards'] as const,
    /**
     * 卡片列表带正文一起取（见 cards:list 的说明），因此没有「详情」键 ——
     * 点开一张卡不需要再发请求，也就不存在列表与详情两份数据不一致的可能。
     */
    list: (query: CardListQuery) => ['cards', 'list', query] as const
  },

  /**
   * 卡片 ↔ 章节的关联。
   *
   * 两个方向各一个键，但共用 `all` 前缀：关联是对称的，改一端另一端
   * 立刻就旧了。若两侧各起一套前缀，写操作要记得失效两个 —— 那是
   * 迟早会漏掉的清单，而漏掉的表现是「卡片页显示已关联、章节页却看不到」。
   */
  cardLinks: {
    all: ['card-links'] as const,
    byCard: (cardId: number | null) => ['card-links', 'card', cardId] as const,
    byChapter: (chapterId: number | null) => ['card-links', 'chapter', chapterId] as const,
    nodesByCard: (cardId: number | null) => ['card-links', 'nodes-of-card', cardId] as const,
    byNode: (nodeId: number | null) => ['card-links', 'node', nodeId] as const
  },

  search: {
    all: ['search'] as const,
    /**
     * 检索结果按「查询词 + 限定书籍」缓存。
     *
     * 刻意**不被任何写操作失效**：检索是只读的瞬时行为，浮层一关就没人看它了。
     * 在 `invalidateLibrary` 里挂上它反而有害 —— 编辑器每 2 秒自动保存一次，
     * 每次都让检索失效意味着「浮层开着时后台在不停重跑全库扫描」，
     * 而那份扫描是这个应用里最贵的一条查询。
     *
     * 结果的时效性由 staleTime: 0 兜住（每次打开浮层都重新查一遍），
     * 因此只存在「同一秒内读到的旧结果」这一种偏差，代价可以忽略。
     */
    query: (input: { keywords: string; bookId: number | null }) =>
      ['search', 'query', input] as const
  },

  sessions: {
    all: ['sessions'] as const,
    list: (query: SessionListQuery) => ['sessions', 'list', query] as const
  },

  stats: {
    all: ['stats'] as const,
    overview: () => ['stats', 'overview'] as const,
    trend: (query: StatsTrendQuery) => ['stats', 'trend', query] as const,
    books: (query: BookProgressQuery) => ['stats', 'books', query] as const,
    heatmap: (query: number | null) => ['stats', 'heatmap', query] as const
  }
} as const

/**
 * 结构性变更后的失效范围：新增/删除/移动章节、改书籍或分卷。
 * 这些操作会改变目录结构，因此书籍列表与统计都要重算。
 */
export function invalidateLibrary(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.books.all }),
    client.invalidateQueries({ queryKey: queryKeys.volumes.all }),
    client.invalidateQueries({ queryKey: queryKeys.chapters.all }),
    // 大纲节点会随章节一起变：删章节会让节点的 chapterId 置空、
    // 落地成章节会新增关联，两者都得让树重新取一次
    client.invalidateQueries({ queryKey: queryKeys.outline.all }),
    // 卡片挂在书下面（cards.book_id 是 ON DELETE CASCADE），
    // 删掉一本书会连带删掉它的卡片，列表必须重取
    client.invalidateQueries({ queryKey: queryKeys.cards.all }),
    client.invalidateQueries({ queryKey: queryKeys.stats.all })
  ]).then(() => undefined)
}

/**
 * 正文保存后的失效范围：刻意**不**失效章节详情与统计。
 *
 * 自动保存在用户打字过程中每 2 秒触发一次。若每次都让统计失效，
 * 首页那些聚合查询（多次跨表 SUM）会被反复重跑，而且编辑器自身的
 * 数据也会被判定为过期而重取，光标位置随之丢失。
 *
 * 统计的正确性由「结算写作会话」与「离开编辑器」这两个时机兜住，
 * 它们才真正代表一次写作告一段落。
 */
export function invalidateAfterSession(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.stats.all }),
    client.invalidateQueries({ queryKey: queryKeys.books.all }),
    // 只失效列表，不动详情：详见 queryKeys.chapters.lists 的说明
    client.invalidateQueries({ queryKey: queryKeys.chapters.lists })
  ]).then(() => undefined)
}
