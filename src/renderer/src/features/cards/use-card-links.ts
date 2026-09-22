import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CardChapterLink,
  CardOutlineLink,
  CardRelation,
  CardRelationEdge,
  CardRelationPairInput,
  CardRelationUnpairInput,
  ChapterCardRef,
  OutlineCardRef
} from '@shared/modules/card-links'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { queryKeys } from '../../lib/query-keys'

/**
 * 一张卡片关联到哪些章节。
 *
 * 关联是低频读取（只在打开某张卡、或某章检查区展开时读一次），
 * 所以不需要 keepPreviousData —— 换一张卡时短暂的空列表比「先显示
 * 上一张卡的关联章节」诚实，后者会让人以为这两张卡共用一批章节。
 */
export function useCardLinks(cardId: number | null) {
  return useQuery<CardChapterLink[], ApiError>({
    queryKey: queryKeys.cardLinks.byCard(cardId),
    enabled: cardId !== null,
    queryFn: () => invoke(() => getBridge().cards.listLinks({ cardId: cardId as number }))
  })
}

/** 某一章用到了哪些卡片 */
export function useChapterCards(chapterId: number | null) {
  return useQuery<ChapterCardRef[], ApiError>({
    queryKey: queryKeys.cardLinks.byChapter(chapterId),
    enabled: chapterId !== null,
    queryFn: () => invoke(() => getBridge().cards.listByChapter({ chapterId: chapterId as number }))
  })
}

/**
 * 建立 / 解除关联后的缓存同步。
 *
 * 两侧都不能只靠 invalidate：
 *   - 本侧用 `setQueryData` 直接写入服务端返回的完整列表 —— 它就是
 *     操作之后的真相，写回去界面立刻正确，没有「闪一下再回来」；
 *   - 另一侧必须失效重取，因为响应里没有它的内容，而它是同一份数据的
 *     另一个视角，旧着就是错的。
 */
function syncBothSides(
  client: ReturnType<typeof useQueryClient>,
  cardId: number,
  chapterId: number,
  links: CardChapterLink[]
): void {
  client.setQueryData(queryKeys.cardLinks.byCard(cardId), links)
  void client.invalidateQueries({ queryKey: queryKeys.cardLinks.byChapter(chapterId) })
}

export function useLinkCardChapter() {
  const queryClient = useQueryClient()
  return useMutation<CardChapterLink[], ApiError, { cardId: number; chapterId: number }>({
    mutationFn: (input) => invoke(() => getBridge().cards.linkChapter(input)),
    onSuccess: (links, variables) =>
      syncBothSides(queryClient, variables.cardId, variables.chapterId, links)
  })
}

export function useUnlinkCardChapter() {
  const queryClient = useQueryClient()
  return useMutation<CardChapterLink[], ApiError, { cardId: number; chapterId: number }>({
    mutationFn: (input) => invoke(() => getBridge().cards.unlinkChapter(input)),
    onSuccess: (links, variables) =>
      syncBothSides(queryClient, variables.cardId, variables.chapterId, links)
  })
}

/* ------------------------------------------------------------------ *
 * 大纲节点侧（第三期）
 *
 * 与章节侧一一对应，缓存同步的策略也照搬：本侧写入返回值，
 * 另一侧失效重取。
 * ------------------------------------------------------------------ */

/** 一张卡片挂在哪些大纲节点上 */
export function useCardNodeLinks(cardId: number | null) {
  return useQuery<CardOutlineLink[], ApiError>({
    queryKey: queryKeys.cardLinks.nodesByCard(cardId),
    enabled: cardId !== null,
    queryFn: () => invoke(() => getBridge().cards.listNodeLinks({ cardId: cardId as number }))
  })
}

/** 某个大纲节点用到了哪些卡片 */
export function useOutlineNodeCards(nodeId: number | null) {
  return useQuery<OutlineCardRef[], ApiError>({
    queryKey: queryKeys.cardLinks.byNode(nodeId),
    enabled: nodeId !== null,
    queryFn: () => invoke(() => getBridge().cards.listByNode({ nodeId: nodeId as number }))
  })
}

function syncNodeBothSides(
  client: ReturnType<typeof useQueryClient>,
  cardId: number,
  nodeId: number,
  links: CardOutlineLink[]
): void {
  client.setQueryData(queryKeys.cardLinks.nodesByCard(cardId), links)
  void client.invalidateQueries({ queryKey: queryKeys.cardLinks.byNode(nodeId) })
}

export function useLinkCardNode() {
  const queryClient = useQueryClient()
  return useMutation<CardOutlineLink[], ApiError, { cardId: number; nodeId: number }>({
    mutationFn: (input) => invoke(() => getBridge().cards.linkNode(input)),
    onSuccess: (links, variables) =>
      syncNodeBothSides(queryClient, variables.cardId, variables.nodeId, links)
  })
}

export function useUnlinkCardNode() {
  const queryClient = useQueryClient()
  return useMutation<CardOutlineLink[], ApiError, { cardId: number; nodeId: number }>({
    mutationFn: (input) => invoke(() => getBridge().cards.unlinkNode(input)),
    onSuccess: (links, variables) =>
      syncNodeBothSides(queryClient, variables.cardId, variables.nodeId, links)
  })
}

/* ------------------------------------------------------------------ *
 * 卡片 ↔ 卡片的关系（第三期第 3 件）
 * ------------------------------------------------------------------ */

/** 这张卡与哪些卡有关系（一条边的两头都能看到它） */
export function useCardRelations(cardId: number | null) {
  return useQuery<CardRelation[], ApiError>({
    queryKey: queryKeys.cardRelations.byCard(cardId),
    enabled: cardId !== null,
    queryFn: () => invoke(() => getBridge().cards.listRelations({ cardId: cardId as number }))
  })
}

/** 一本书里所有的关系边。关系网用；bookId 为 null（通用卡片范围）时不查 */
export function useBookRelations(bookId: number | null) {
  return useQuery<CardRelationEdge[], ApiError>({
    queryKey: queryKeys.cardRelations.byBook(bookId),
    enabled: bookId !== null,
    queryFn: () => invoke(() => getBridge().cards.listBookRelations({ bookId: bookId as number }))
  })
}

/**
 * 关系变更后的缓存同步。
 *
 * 本侧（被操作的那一头）写入服务端返回的完整列表；**另一头与关系网**
 * 只能失效重取 —— 响应里是这一头的视角，那一头看到的虽然是同一条边，
 * 但列表内容不同（对方那一栏是这张卡），拿它顶替会张冠李戴。
 */
function syncRelationSides(
  client: ReturnType<typeof useQueryClient>,
  cardId: number,
  relations: CardRelation[]
): void {
  client.setQueryData(queryKeys.cardRelations.byCard(cardId), relations)
  void client.invalidateQueries({ queryKey: queryKeys.cardRelations.all })
}

export function useRelateCards() {
  const queryClient = useQueryClient()
  return useMutation<CardRelation[], ApiError, CardRelationPairInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.relate(input)),
    onSuccess: (relations, variables) =>
      syncRelationSides(queryClient, variables.cardId, relations)
  })
}

export function useUnrelateCards() {
  const queryClient = useQueryClient()
  return useMutation<CardRelation[], ApiError, CardRelationUnpairInput>({
    mutationFn: (input) => invoke(() => getBridge().cards.unrelate(input)),
    onSuccess: (relations, variables) =>
      syncRelationSides(queryClient, variables.cardId, relations)
  })
}
