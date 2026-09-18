import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Progress,
  Row,
  Select,
  Skeleton,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  PlusOutlined,
  SortAscendingOutlined,
  UpOutlined
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router'
import type { Book } from '@shared/modules/books'
import { CHAPTER_STATUS_LABELS, type ChapterListItem } from '@shared/modules/chapters'
import type { VolumeListItem } from '@shared/modules/volumes'
import { ErrorAlert } from '../../components/ErrorAlert'
import { PageHeader } from '../../components/PageHeader'
import { useToast } from '../../components/Toast'
import { formatCompact, formatCount, formatDateTime, formatRelativeTime, progressPercent } from '../../lib/format'
import { BookFormModal, type BookFormValues } from './BookFormModal'
import { useBook, useRemoveBook, useUpdateBook } from './use-books'
import {
  useCreateVolume,
  useRemoveVolume,
  useReorderVolumes,
  useUpdateVolume,
  useVolumeList
} from './use-volumes'
import {
  useChapterList,
  useCreateChapter,
  useMoveChapter,
  useRemoveChapter,
  useReorderChapters
} from '../chapters/use-chapters'

const { Text, Paragraph } = Typography

/**
 * 书籍详情：分卷、章节目录。
 *
 * 这一页是「结构管理」的场所，编辑器是「写字」的场所，两者刻意分开：
 * 在编辑器里塞进拖拽排序、批量移动这类操作，会让写作界面变成一张
 * 电子表格，而写字最需要的恰恰是安静。
 *
 * 所有重排都提交**完整的顺序数组**（见 volumes.ts 的说明）。上移/下移
 * 在界面上是「一次一格」，但底层依旧是全量提交 —— 界面的操作粒度
 * 与接口的提交粒度不必一致，而后者必须是原子的。
 */
export function BookDetailPage() {
  const params = useParams<{ bookId: string }>()
  const bookId = Number(params.bookId)
  const navigate = useNavigate()
  const { notifySuccess, notifyError } = useToast()

  const [formOpen, setFormOpen] = useState(false)
  const [creatingChapter, setCreatingChapter] = useState(false)
  const [chapterTitle, setChapterTitle] = useState('')
  const [creatingVolume, setCreatingVolume] = useState(false)
  const [volumeTitle, setVolumeTitle] = useState('')
  const [renamingVolumeId, setRenamingVolumeId] = useState<number | null>(null)
  const [renamingTitle, setRenamingTitle] = useState('')

  const book = useBook(bookId)
  const chapters = useChapterList({ bookId, volumeId: undefined })
  const volumes = useVolumeList(bookId)

  const updateBook = useUpdateBook()
  const removeBook = useRemoveBook()
  const createChapter = useCreateChapter()
  const removeChapter = useRemoveChapter()
  const reorderChapters = useReorderChapters()
  const moveChapter = useMoveChapter()
  const createVolume = useCreateVolume()
  const updateVolume = useUpdateVolume()
  const removeVolume = useRemoveVolume()
  const reorderVolumes = useReorderVolumes()

  const volumeMap = useMemo(() => {
    const map = new Map<number, VolumeListItem>()
    for (const volume of volumes.data ?? []) map.set(volume.id, volume)
    return map
  }, [volumes.data])

  /** 每个容器内的章节 id 顺序。重排要提交完整序列，因此需要它当基准 */
  const containerIds = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const chapter of chapters.data ?? []) {
      const key = chapter.volumeId === null ? 'loose' : String(chapter.volumeId)
      const bucket = map.get(key)
      if (bucket) bucket.push(chapter.id)
      else map.set(key, [chapter.id])
    }
    return map
  }, [chapters.data])

  /** 章节在它所属容器内的序号，用于表格里的「序号」列 */
  const orderInContainer = useMemo(() => {
    const map = new Map<number, number>()
    for (const ids of containerIds.values()) {
      ids.forEach((id, index) => map.set(id, index + 1))
    }
    return map
  }, [containerIds])

  const submitReorder = useCallback(
    async (chapter: ChapterListItem, direction: -1 | 1): Promise<void> => {
      const key = chapter.volumeId === null ? 'loose' : String(chapter.volumeId)
      const ids = containerIds.get(key) ?? []
      const index = ids.indexOf(chapter.id)
      const target = index + direction
      if (index === -1 || target < 0 || target >= ids.length) return

      const next = [...ids]
      next[index] = ids[target]
      next[target] = chapter.id

      if (next.length !== ids.length) return

      try {
        await reorderChapters.mutateAsync({
          bookId,
          volumeId: chapter.volumeId,
          orderedIds: next
        })
      } catch (error) {
        notifyError(error instanceof Error ? error.message : '调整顺序失败')
      }
    },
    [bookId, containerIds, notifyError, reorderChapters]
  )

  const handleCreateChapter = useCallback(async (): Promise<void> => {
    const title = chapterTitle.trim()
    if (title.length === 0) {
      notifyError('章节标题不能为空')
      return
    }

    try {
      const created = await createChapter.mutateAsync({ bookId, volumeId: null, title, targetWords: 0 })
      setChapterTitle('')
      setCreatingChapter(false)
      void navigate(`/books/${bookId}/chapters/${created.id}`)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '新建章节失败')
    }
  }, [bookId, chapterTitle, createChapter, navigate, notifyError])

  const handleCreateVolume = useCallback(async (): Promise<void> => {
    const title = volumeTitle.trim()
    if (title.length === 0) {
      notifyError('分卷名称不能为空')
      return
    }

    try {
      await createVolume.mutateAsync({ bookId, title, summary: '' })
      setVolumeTitle('')
      setCreatingVolume(false)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '新建分卷失败')
    }
  }, [bookId, createVolume, notifyError, volumeTitle])

  const handleRenameVolume = useCallback(async (): Promise<void> => {
    if (renamingVolumeId === null) return
    const volume = volumeMap.get(renamingVolumeId)
    if (!volume) return

    const title = renamingTitle.trim()
    if (title.length === 0) {
      notifyError('分卷名称不能为空')
      return
    }

    try {
      await updateVolume.mutateAsync({ id: renamingVolumeId, title, summary: volume.summary })
      setRenamingVolumeId(null)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '重命名失败')
    }
  }, [notifyError, renamingTitle, renamingVolumeId, updateVolume, volumeMap])

  const handleReorderVolumes = useCallback(
    async (volume: VolumeListItem, direction: -1 | 1): Promise<void> => {
      const ids = (volumes.data ?? []).map((item) => item.id)
      const index = ids.indexOf(volume.id)
      const target = index + direction
      if (index === -1 || target < 0 || target >= ids.length) return

      const next = [...ids]
      next[index] = ids[target]
      next[target] = volume.id

      try {
        await reorderVolumes.mutateAsync({ bookId, orderedIds: next })
      } catch (error) {
        notifyError(error instanceof Error ? error.message : '调整分卷顺序失败')
      }
    },
    [bookId, notifyError, reorderVolumes, volumes.data]
  )

  const columns: ColumnsType<ChapterListItem> = [
    {
      title: '序',
      key: 'order',
      width: 56,
      render: (_value, record) => (
        <Text type="secondary">{orderInContainer.get(record.id) ?? '—'}</Text>
      )
    },
    {
      title: '章节',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record) => (
        <Flex vertical gap={2}>
          <Button
            type="link"
            className="chapter-link"
            onClick={() => void navigate(`/books/${bookId}/chapters/${record.id}`)}
          >
            {title}
          </Button>
          <Text type="secondary" className="chapter-meta">
            {record.volumeId === null
              ? '未分卷'
              : (volumeMap.get(record.volumeId)?.title ?? '未知分卷')}{' '}
            · {formatRelativeTime(record.updatedAt)}
          </Text>
        </Flex>
      ),
      sorter: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 92,
      filters: Object.entries(CHAPTER_STATUS_LABELS).map(([value, label]) => ({ value, text: label })),
      onFilter: (value, record) => record.status === value,
      render: (status: ChapterListItem['status']) => (
        <Tag className="tag--flush" color={status === 'done' ? 'success' : status === 'revising' ? 'processing' : 'default'}>
          {CHAPTER_STATUS_LABELS[status]}
        </Tag>
      )
    },
    {
      title: '汉字',
      dataIndex: 'hanziCount',
      key: 'hanziCount',
      width: 96,
      align: 'right',
      sorter: (a, b) => a.hanziCount - b.hanziCount,
      render: (value: number, record) => (
        <Tooltip title={`含标点 ${record.charCount} · 目标 ${record.targetWords || '未设'}`}>
          <Text>{formatCount(value)}</Text>
        </Tooltip>
      )
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      render: (value: string) => <Text type="secondary">{formatDateTime(value)}</Text>
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_value, record) => (
        <Flex align="center" gap={2}>
          <Tooltip title="打开编辑">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => void navigate(`/books/${bookId}/chapters/${record.id}`)}
            />
          </Tooltip>
          <Tooltip title="上移">
            <Button
              size="small"
              type="text"
              icon={<UpOutlined />}
              onClick={() => void submitReorder(record, -1)}
            />
          </Tooltip>
          <Tooltip title="下移">
            <Button
              size="small"
              type="text"
              icon={<DownOutlined />}
              onClick={() => void submitReorder(record, 1)}
            />
          </Tooltip>
          <Select
            size="small"
            className="chapter-move"
            value={record.volumeId ?? null}
            options={[
              { value: null, label: '未分卷' },
              ...(volumes.data ?? []).map((volume) => ({ value: volume.id, label: volume.title }))
            ]}
            onChange={(value) => {
              void moveChapter
                .mutateAsync({ id: record.id, volumeId: value, targetIndex: 0 })
                .catch((error: unknown) =>
                  notifyError(error instanceof Error ? error.message : '移动失败')
                )
            }}
          />
          <Popconfirm
            title={`删除「${record.title}」？`}
            description="正文会一并删除且无法恢复。写作记录会保留。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => {
              void removeChapter.mutateAsync({ id: record.id }).catch((error: unknown) =>
                notifyError(error instanceof Error ? error.message : '删除失败')
              )
            }}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Flex>
      )
    }
  ]

  if (book.isPending) {
    return (
      <Flex vertical gap={16} className="page">
        <Skeleton active paragraph={{ rows: 8 }} />
      </Flex>
    )
  }

  if (book.isError || !book.data) {
    return (
      <Flex vertical gap={16} className="page">
        <ErrorAlert error={book.error} title="书籍加载失败" onRetry={() => void book.refetch()} />
        <Button onClick={() => void navigate('/books')}>返回书架</Button>
      </Flex>
    )
  }

  const data: Book = book.data
  const chapterItems = chapters.data ?? []
  const hanziTotal = chapterItems.reduce((sum, item) => sum + item.hanziCount, 0)
  const charTotal = chapterItems.reduce((sum, item) => sum + item.charCount, 0)
  // 进度用「各章汉字之和」而不是书籍列表项里的聚合字段：
  // 详情页要能在删改章节后立刻反映最新进度，而列表项的聚合是缓存的
  const percent = progressPercent(hanziTotal, data.targetWords)

  return (
    <Flex vertical gap={16} className="page">
      <PageHeader
        title={data.title}
        extra={
          <>
            <Button
              size="middle"
              icon={<ArrowLeftOutlined />}
              onClick={() => void navigate('/books')}
            >
              返回书架
            </Button>
            <Button icon={<EditOutlined />} onClick={() => setFormOpen(true)}>
              编辑信息
            </Button>
            <Popconfirm
              title={`删除《${data.title}》？`}
              description={`这本书的 ${chapters.data?.length ?? 0} 章正文会一并删除，且无法恢复。`}
              okText="确认删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => {
                void removeBook
                  .mutateAsync({ id: data.id })
                  .then(() => {
                    notifySuccess(`已删除《${data.title}》`)
                    void navigate('/books')
                  })
                  .catch((error: unknown) =>
                    notifyError(error instanceof Error ? error.message : '删除失败')
                  )
              }}
            >
              <Button danger icon={<DeleteOutlined />}>
                删除书籍
              </Button>
            </Popconfirm>
          </>
        }
      />

      {data.summary.length > 0 ? (
        <Card>
          <Paragraph type="secondary" className="book-summary">
            {data.summary}
          </Paragraph>
        </Card>
      ) : null}

      {/* ---------------- 概览 ---------------- */}
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic title="分卷" value={volumes.data?.length ?? 0} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic title="章节" value={chapters.data?.length ?? 0} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic title="全书汉字" value={hanziTotal} />
            <Text type="secondary" className="book-stat__hint">
              含标点 {charTotal.toLocaleString('zh-CN')}
            </Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            {percent === null ? (
              <>
                <Statistic title="目标字数" value="未设" />
                <Text type="secondary" className="book-stat__hint">
                  编辑书籍信息可以设定目标
                </Text>
              </>
            ) : (
              <>
                <Text type="secondary" className="book-stat__hint">
                  目标进度 {percent}%
                </Text>
                <Progress percent={percent} strokeColor={data.accentColor} />
                <Text type="secondary" className="book-stat__hint">
                  {formatCompact(hanziTotal)} / {formatCompact(data.targetWords)}
                </Text>
              </>
            )}
          </Card>
        </Col>
      </Row>

      {/* ---------------- 分卷管理 ---------------- */}
      <Card
        title="分卷"
        extra={
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() => setCreatingVolume(true)}
          >
            新建分卷
          </Button>
        }
      >
        {creatingVolume ? (
          <Flex gap={6} className="volume-draft">
            <Input
              size="small"
              autoFocus
              placeholder="例如：第一卷 启程"
              value={volumeTitle}
              onChange={(event) => setVolumeTitle(event.target.value)}
              onPressEnter={() => void handleCreateVolume()}
            />
            <Button
              size="small"
              type="primary"
              loading={createVolume.isPending}
              onClick={() => void handleCreateVolume()}
            >
              创建
            </Button>
            <Button size="small" onClick={() => setCreatingVolume(false)}>
              取消
            </Button>
          </Flex>
        ) : null}

        {(volumes.data ?? []).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary">
                还没有分卷。短篇或不打算分卷的书可以直接建章节，章节会落在「未分卷」里。
              </Text>
            }
          />
        ) : (
          <Flex vertical gap={6} className="volume-list">
            {(volumes.data ?? []).map((volume, index) => (
              <Flex key={volume.id} align="center" gap={10} className="volume-row">
                <span className="volume-row__index">{index + 1}</span>

                {renamingVolumeId === volume.id ? (
                  <Flex gap={6} className="volume-row__edit">
                    <Input
                      size="small"
                      autoFocus
                      value={renamingTitle}
                      onChange={(event) => setRenamingTitle(event.target.value)}
                      onPressEnter={() => void handleRenameVolume()}
                    />
                    <Button size="small" type="primary" onClick={() => void handleRenameVolume()}>
                      保存
                    </Button>
                    <Button size="small" onClick={() => setRenamingVolumeId(null)}>
                      取消
                    </Button>
                  </Flex>
                ) : (
                  <>
                    <Text className="volume-row__title">{volume.title}</Text>
                    <Text type="secondary" className="volume-row__meta">
                      {volume.chapterCount} 章 · {formatCount(volume.hanziCount)} 字
                    </Text>
                    <Flex align="center" gap={2} className="volume-row__actions">
                      <Tooltip title="上移">
                        <Button
                          size="small"
                          type="text"
                          icon={<SortAscendingOutlined />}
                          disabled={index === 0}
                          onClick={() => void handleReorderVolumes(volume, -1)}
                        />
                      </Tooltip>
                      <Tooltip title="下移">
                        <Button
                          size="small"
                          type="text"
                          icon={<SortAscendingOutlined rotate={180} />}
                          disabled={index === (volumes.data?.length ?? 0) - 1}
                          onClick={() => void handleReorderVolumes(volume, 1)}
                        />
                      </Tooltip>
                      <Tooltip title="重命名">
                        <Button
                          size="small"
                          type="text"
                          icon={<EditOutlined />}
                          onClick={() => {
                            setRenamingVolumeId(volume.id)
                            setRenamingTitle(volume.title)
                          }}
                        />
                      </Tooltip>
                      <Popconfirm
                        title={`删除分卷「${volume.title}」？`}
                        description={`卷下的 ${volume.chapterCount} 章不会被删除，会退回「未分卷」。`}
                        okText="删除分卷"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                        onConfirm={() => {
                          void removeVolume
                            .mutateAsync({ id: volume.id })
                            .then(() => notifySuccess('分卷已删除，卷下章节已退回未分卷'))
                            .catch((error: unknown) =>
                              notifyError(error instanceof Error ? error.message : '删除失败')
                            )
                        }}
                      >
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Flex>
                  </>
                )}
              </Flex>
            ))}
          </Flex>
        )}
      </Card>

      {/* ---------------- 章节 ---------------- */}
      <Card
        title="章节"
        extra={
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() => setCreatingChapter(true)}
          >
            新建章节
          </Button>
        }
      >
        {creatingChapter ? (
          <Flex gap={6} className="chapter-draft">
            <Input
              size="small"
              autoFocus
              placeholder="例如：第一章 出港"
              value={chapterTitle}
              onChange={(event) => setChapterTitle(event.target.value)}
              onPressEnter={() => void handleCreateChapter()}
            />
            <Button
              size="small"
              type="primary"
              loading={createChapter.isPending}
              onClick={() => void handleCreateChapter()}
            >
              创建并开始写
            </Button>
            <Button size="small" onClick={() => setCreatingChapter(false)}>
              取消
            </Button>
          </Flex>
        ) : null}

        {chapters.isError ? (
          <ErrorAlert
            error={chapters.error}
            title="章节列表加载失败"
            onRetry={() => void chapters.refetch()}
          />
        ) : (
          <Table<ChapterListItem>
            data-testid="chapter-table"
            rowKey="id"
            size="small"
            loading={chapters.isPending}
            columns={columns}
            dataSource={chapters.data ?? []}
            pagination={{
              pageSize: 30,
              showSizeChanger: false,
              hideOnSinglePage: true,
              showTotal: (total) => `共 ${total} 章`
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={<Text type="secondary">还没有章节，点右上角开始写第一章</Text>}
                />
              )
            }}
          />
        )}
      </Card>

      <Descriptions size="small" column={2} className="book-meta">
        <Descriptions.Item label="创建于">{formatDateTime(data.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="最近写作">
          {formatRelativeTime(data.updatedAt)}
        </Descriptions.Item>
      </Descriptions>

      <BookFormModal
        open={formOpen}
        book={data}
        submitting={updateBook.isPending}
        error={updateBook.error}
        onSubmit={(values: BookFormValues) => {
          void updateBook
            .mutateAsync({ id: data.id, ...values })
            .then(() => {
              notifySuccess('书籍信息已更新')
              setFormOpen(false)
            })
            .catch(() => undefined)
        }}
        onCancel={() => {
          setFormOpen(false)
          updateBook.reset()
        }}
      />
    </Flex>
  )
}
