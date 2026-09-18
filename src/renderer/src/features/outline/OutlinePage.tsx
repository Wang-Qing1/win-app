import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Empty, Flex, Select, Skeleton, Tag, Tooltip, Typography } from 'antd'
import type { Key } from 'react'
import { CompressOutlined, ExpandOutlined, PlusOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router'
import { DEFAULT_BOOK_QUERY } from '@shared/modules/books'
import {
  OUTLINE_STATUSES,
  OUTLINE_STATUS_LABELS,
  type OutlineTreeNode
} from '@shared/modules/outline'
import { ErrorAlert } from '../../components/ErrorAlert'
import { PageHeader } from '../../components/PageHeader'
import { useToast } from '../../components/Toast'
import { useBookList } from '../books/use-books'
import { useVolumeList } from '../books/use-volumes'
import { useChapterList } from '../chapters/use-chapters'
import { OutlineNodePanel, type OutlineNodeDraft } from './OutlineNodePanel'
import { OutlineTree, type OutlineDropTarget } from './OutlineTree'
import { readOutlineBookId, writeOutlineBookId } from './outline-prefs'
import {
  useAttachOutlineChapter,
  useCreateOutlineNode,
  useMaterializeOutlineNode,
  useMoveOutlineNode,
  useOutlineTree,
  useRemoveOutlineNode,
  useUpdateOutlineNode
} from './use-outline'

const { Text } = Typography

/** 在树里按 id 找节点。树的规模在千级以内，递归一次比维护索引表更简单 */
function findNode(nodes: readonly OutlineTreeNode[], id: number): OutlineTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findNode(node.children, id)
    if (hit) return hit
  }
  return null
}

/** 所有「有子节点」的节点 id —— 展开这些等于把整棵树铺开 */
function collectParentKeys(nodes: readonly OutlineTreeNode[]): Key[] {
  const keys: Key[] = []

  const walk = (list: readonly OutlineTreeNode[]): void => {
    for (const node of list) {
      if (node.children.length > 0) {
        keys.push(node.id)
        walk(node.children)
      }
    }
  }

  walk(nodes)
  return keys
}

/** 树里所有节点的 id，用于「全部展开」（叶子也要展开，否则收不起也展不开） */
function collectAllKeys(nodes: readonly OutlineTreeNode[]): Key[] {
  return nodes.flatMap((node) => [node.id, ...collectAllKeys(node.children)])
}

/**
 * 从根到目标节点的祖先链（不含目标自己）。找不到时返回 null。
 *
 * 深链跳过来时只把节点选中是不够的：它若被折叠在几层父节点之下，
 * 树里根本看不见它，用户会以为「跳过来了但什么都没发生」。
 */
function collectAncestorKeys(
  nodes: readonly OutlineTreeNode[],
  targetId: number
): Key[] | null {
  const path: Key[] = []

  const walk = (list: readonly OutlineTreeNode[]): boolean => {
    for (const node of list) {
      if (node.id === targetId) return true
      path.push(node.id)
      if (walk(node.children)) return true
      path.pop()
    }
    return false
  }

  return walk(nodes) ? path : null
}

export function OutlinePage() {
  const toast = useToast()

  const bookList = useBookList({ ...DEFAULT_BOOK_QUERY, pageSize: 200 })
  const books = useMemo(() => bookList.data?.items ?? [], [bookList.data])

  const [searchParams] = useSearchParams()

  /* ------------------------------------------------------------------ *
   * 深链：从全库检索跳过来（?bookId=NN&nodeId=MM）
   *
   * 两个参数都需要。大纲树是按书查的，只有 nodeId 的话目标页面只能靠
   * 本地记忆猜一本书 —— 而本地记忆里存的很可能是另一本。
   * ------------------------------------------------------------------ */

  const deepLinkBookId = useMemo(() => {
    const parsed = Number(searchParams.get('bookId'))
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  const deepLinkNodeId = useMemo(() => {
    const parsed = Number(searchParams.get('nodeId'))
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  /** 已消费过的深链目标，避免用户之后切换书籍时又被它拽回去 */
  const consumedNodeRef = useRef<number | null>(null)

  // 深链给了书就以它为准，否则回落到上次看的那本
  const [bookId, setBookId] = useState<number | null>(() => deepLinkBookId ?? readOutlineBookId())

  /**
   * 回落逻辑：书列表到达后，若还没选过、或选中的那本已经被删掉，
   * 就落到第一本上。不做这一步的话，删掉当前书再回大纲页会一直空着，
   * 而用户看不出是「书没了」还是「大纲没了」。
   */
  useEffect(() => {
    if (books.length === 0) {
      setBookId(null)
      return
    }
    if (bookId !== null && books.some((book) => book.id === bookId)) return
    setBookId(books[0].id)
  }, [books, bookId])

  useEffect(() => {
    writeOutlineBookId(bookId)
  }, [bookId])

  const tree = useOutlineTree(bookId)
  const volumes = useVolumeList(bookId)
  const chapters = useChapterList({ bookId: bookId ?? -1, volumeId: undefined })

  const createNode = useCreateOutlineNode()
  const updateNode = useUpdateOutlineNode()
  const removeNode = useRemoveOutlineNode()
  const moveNode = useMoveOutlineNode()
  const attachChapter = useAttachOutlineChapter()
  const materialize = useMaterializeOutlineNode()

  const nodes = useMemo(() => tree.data?.nodes ?? [], [tree.data])

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([])
  const seededBookRef = useRef<number | null>(null)

  /** 只在该书第一次拿到数据时铺开整棵树，之后的展开状态完全由用户控制 */
  useEffect(() => {
    if (tree.data === undefined || bookId === null) return
    if (seededBookRef.current === bookId) return
    seededBookRef.current = bookId
    setExpandedKeys(collectParentKeys(tree.data.nodes))
  }, [tree.data, bookId])

  /** 换书就把选中清掉：选中的 id 属于上一本书，留着会指向一个不存在的节点 */
  useEffect(() => {
    setSelectedId(null)
  }, [bookId])

  /**
   * 消费深链：树到了之后选中目标节点，并把它的祖先链展开。
   *
   * 之所以要等 `tree.data` 到位再动手，是因为「选中」与「展开」都是
   * 针对具体节点的操作，而节点属于这一本书的树。深链带了 bookId，
   * 所以这里不会出现「拿 A 书的节点 id 去 B 书里找」的情况。
   *
   * 声明位置在「换书清空选中」之后：两个 effect 在同一次渲染里按顺序执行，
   * 这样互换 bookId 时会先清空、再选中，不会互相抵消。
   */
  useEffect(() => {
    if (deepLinkNodeId === null || bookId === null) return
    if (consumedNodeRef.current === deepLinkNodeId) return
    if (tree.data === undefined) return
    // 节点不在这一本书里（书被删了、或者参数被手工改过）：不做任何事，
    // 也不标记已消费，等树真的到了再说
    if (findNode(tree.data.nodes, deepLinkNodeId) === null) return

    consumedNodeRef.current = deepLinkNodeId
    setSelectedId(deepLinkNodeId)
    const ancestors = collectAncestorKeys(tree.data.nodes, deepLinkNodeId)
    if (ancestors !== null) setExpandedKeys(ancestors)
  }, [bookId, deepLinkNodeId, tree.data])

  const selectedNode = useMemo(
    () => (selectedId === null ? null : findNode(nodes, selectedId)),
    [nodes, selectedId]
  )

  /** 章节 id → 占用它的节点标题。用来把已被占用的选项置灰 */
  const takenChapters = useMemo(() => {
    const map = new Map<number, string>()
    const walk = (list: readonly OutlineTreeNode[]): void => {
      for (const node of list) {
        if (node.chapterId !== null) map.set(node.chapterId, node.title)
        walk(node.children)
      }
    }
    walk(nodes)
    return map
  }, [nodes])

  const expand = (ids: readonly Key[]): void => {
    setExpandedKeys((keys) => {
      const merged = new Set(keys)
      for (const id of ids) merged.add(id)
      return [...merged]
    })
  }

  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : '操作失败'

  /** 新增节点后要保证它可见：父节点收着的话，新节点加进去了却看不见 */
  const handleAdd = async (parentId: number | null): Promise<void> => {
    if (bookId === null) return

    try {
      const created = await createNode.mutateAsync({
        bookId,
        parentId,
        nodeType: 'event',
        title: '新节点',
        summary: '',
        status: 'planned'
      })
      setSelectedId(created.id)
      if (parentId !== null) expand([parentId])
      toast.notifySuccess('已新增节点，可在右侧改名')
    } catch (error) {
      toast.notifyError(messageOf(error))
    }
  }

  const handleMove = async (dragId: number, target: OutlineDropTarget): Promise<void> => {
    if (bookId === null) return

    try {
      await moveNode.mutateAsync({
        bookId,
        id: dragId,
        parentId: target.parentId,
        targetIndex: target.targetIndex
      })
      if (target.parentId !== null) expand([target.parentId])
    } catch (error) {
      toast.notifyError(messageOf(error))
    }
  }

  /* 面板里的操作把异常往外抛，由面板统一提示 —— 这样「已保存」这类
     成功提示不会在失败时误报。只有页面自己的按钮在这里就地兜住异常。 */

  const handleSave = async (
    node: OutlineTreeNode,
    draft: OutlineNodeDraft
  ): Promise<void> => {
    if (bookId === null) return
    await updateNode.mutateAsync({
      bookId,
      id: node.id,
      nodeType: draft.nodeType,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      status: draft.status
    })
  }

  const handleDelete = async (node: OutlineTreeNode): Promise<void> => {
    if (bookId === null) return
    await removeNode.mutateAsync({ bookId, id: node.id })
    if (selectedId === node.id) setSelectedId(null)
  }

  const header = (
    <PageHeader
      title="大纲管理"
      extra={
        <>
          <Select
            data-testid="outline-book-select"
            className="outline-book-select"
            value={bookId}
            placeholder="选择书籍"
            loading={bookList.isLoading}
            onChange={(value: number) => setBookId(value)}
            options={books.map((book) => ({ value: book.id, label: book.title }))}
          />
          <Tooltip title="展开整棵树">
            <Button
              icon={<ExpandOutlined />}
              disabled={nodes.length === 0}
              onClick={() => setExpandedKeys(collectAllKeys(nodes))}
            />
          </Tooltip>
          <Tooltip title="只留下有子节点的层级">
            <Button
              icon={<CompressOutlined />}
              disabled={nodes.length === 0}
              onClick={() => setExpandedKeys([])}
            />
          </Tooltip>
          <Tooltip title="新增一个根节点">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              data-testid="outline-add-root"
              loading={createNode.isPending}
              disabled={bookId === null}
              onClick={() => void handleAdd(null)}
            >
              根节点
            </Button>
          </Tooltip>
        </>
      }
    />
  )

  if (bookList.isLoading) {
    return (
      <Flex vertical gap={16} className="outline-page" data-testid="outline-page">
        {header}
        <Skeleton active paragraph={{ rows: 8 }} />
      </Flex>
    )
  }

  if (books.length === 0) {
    return (
      <Flex vertical gap={16} className="outline-page" data-testid="outline-page">
        {header}
        <Empty
          description={
            <Flex vertical gap={6} align="center">
              <Text>还没有任何书籍</Text>
              <Text type="secondary">大纲是挂在一本书下面的，先去建一本书。</Text>
            </Flex>
          }
        />
      </Flex>
    )
  }

  return (
    <Flex vertical gap={16} className="outline-page" data-testid="outline-page">
      {header}

      {tree.isError ? <ErrorAlert error={tree.error} onRetry={() => void tree.refetch()} /> : null}

      <div className="outline-layout">
        <div className="outline-tree-pane">
          <Flex justify="flex-end" align="center" className="outline-tree-pane__head">
            <span className="outline-summary" data-testid="outline-summary">
              <span>
                节点{' '}
                <strong data-testid="outline-node-total" data-value={tree.data?.total ?? 0}>
                  {tree.data?.total ?? 0}
                </strong>
              </span>
              <span>层级 {tree.data?.depth ?? 0}</span>
              <span>
                已落地{' '}
                <strong data-testid="outline-landed" data-value={tree.data?.landedCount ?? 0}>
                  {tree.data?.landedCount ?? 0}
                </strong>
              </span>
            </span>
          </Flex>

          {tree.isLoading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : nodes.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical gap={6} align="center">
                  <Text>这本书还没有大纲</Text>
                  <Text type="secondary">
                    先加一个根节点，比如「第一卷 起点」，再往下挂事件。
                  </Text>
                </Flex>
              }
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleAdd(null)}>
                新增根节点
              </Button>
            </Empty>
          ) : (
            <OutlineTree
              nodes={nodes}
              selectedId={selectedId}
              expandedKeys={expandedKeys}
              onSelect={setSelectedId}
              onExpandedKeysChange={setExpandedKeys}
              onMove={(dragId, target) => void handleMove(dragId, target)}
            />
          )}

          {tree.data === undefined ? null : (
            <Flex gap={10} wrap className="outline-legend">
              {OUTLINE_STATUSES.map((status) => (
                <span key={status} className="outline-legend__item">
                  <Tag className="outline-legend__tag">
                    {OUTLINE_STATUS_LABELS[status]}
                  </Tag>
                  <strong
                    data-testid={`outline-status-${status}`}
                    data-value={tree.data?.statusCounts[status] ?? 0}
                  >
                    {tree.data?.statusCounts[status] ?? 0}
                  </strong>
                </span>
              ))}
            </Flex>
          )}
        </div>

        <div className="outline-panel-pane">
          <OutlineNodePanel
            node={selectedNode}
            bookId={bookId ?? 0}
            chapters={chapters.data ?? []}
            volumes={volumes.data ?? []}
            takenChapters={takenChapters}
            onAddChild={(parentId) => void handleAdd(parentId)}
            onAddSibling={(node) => void handleAdd(node.parentId)}
            onDelete={handleDelete}
            onSave={handleSave}
            onAttachChapter={async (node, chapterId) => {
              if (bookId === null) return
              await attachChapter.mutateAsync({ bookId, id: node.id, chapterId })
              toast.notifySuccess(chapterId === null ? '已解除关联' : '已关联章节')
            }}
            onDetachChapter={async (node) => {
              if (bookId === null) return
              await attachChapter.mutateAsync({ bookId, id: node.id, chapterId: null })
              toast.notifySuccess('已解除关联')
            }}
            onMaterialize={async (node, volumeId) => {
              if (bookId === null) return
              const result = await materialize.mutateAsync({
                bookId,
                id: node.id,
                volumeId,
                targetWords: 0
              })
              toast.notifySuccess(`已创建章节《${result.chapterTitle}》`)
            }}
          />
        </div>
      </div>
    </Flex>
  )
}
