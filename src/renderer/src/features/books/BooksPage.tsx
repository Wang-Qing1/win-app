import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Pagination,
  Popconfirm,
  Progress,
  Row,
  Select,
  Skeleton,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReadOutlined,
  RightOutlined,
  SearchOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router'
import {
  BOOK_STATUSES,
  BOOK_STATUS_LABELS,
  DEFAULT_BOOK_QUERY,
  type Book,
  type BookListQuery,
  type BookStatus
} from '@shared/modules/books'
import { ErrorAlert } from '../../components/ErrorAlert'
import { PageHeader } from '../../components/PageHeader'
import { useToast } from '../../components/Toast'
import { useDebouncedValue } from '../../hooks/use-debounced-value'
import { formatCompact, formatCount, formatRelativeTime, progressPercent } from '../../lib/format'
import { BookFormModal, type BookFormValues } from './BookFormModal'
import { useBookList, useCreateBook, useRemoveBook, useUpdateBook } from './use-books'

const { Text, Paragraph } = Typography

/**
 * 书架页。
 *
 * 布局用卡片网格而不是表格。表格适合「同一批记录逐字段对比」，
 * 而书架的浏览方式是「扫一眼封面，认出我要写的那本」——卡片能让书名
 * 与标识色形成视觉锚点，表格做不到这一点。
 *
 * 搜索走防抖后再进查询键：不防抖的话每敲一个字都会产生一个新的
 * React Query 缓存键，敲「星海归途」会留下 4 份互不相同的列表缓存，
 * 而它们再也不会被用到。
 */
export function BooksPage() {
  const navigate = useNavigate()
  const { notifySuccess, notifyError } = useToast()

  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<BookStatus | null>(null)
  const [sort, setSort] = useState<'updatedAt' | 'createdAt' | 'title' | 'hanziCount'>('updatedAt')
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Book | null>(null)

  const debouncedKeyword = useDebouncedValue(keyword, 260)

  const query = useMemo<BookListQuery>(
    () => ({
      ...DEFAULT_BOOK_QUERY,
      keyword: debouncedKeyword,
      status,
      page,
      sortBy: sort,
      sortOrder: sort === 'title' ? 'asc' : 'desc'
    }),
    [debouncedKeyword, page, sort, status]
  )

  const list = useBookList(query)
  const createBook = useCreateBook()
  const updateBook = useUpdateBook()
  const removeBook = useRemoveBook()

  const items = list.data?.items ?? []

  const openCreate = useCallback((): void => {
    setEditing(null)
    setFormOpen(true)
  }, [])

  const openEdit = useCallback((book: Book): void => {
    setEditing(book)
    setFormOpen(true)
  }, [])

  const handleSubmit = useCallback(
    async (values: BookFormValues): Promise<void> => {
      try {
        if (editing === null) {
          const created = await createBook.mutateAsync(values)
          notifySuccess(`已创建《${created.title}》`)
          setFormOpen(false)
          // 新建后直接进详情页：用户建书的目的就是开始写，不该让他再点一次
          void navigate(`/books/${created.id}`)
        } else {
          await updateBook.mutateAsync({ id: editing.id, ...values })
          notifySuccess(`《${values.title}》已更新`)
          setFormOpen(false)
        }
      } catch {
        // 错误由弹窗内的 Alert 展示，这里不重复弹提示
      }
    },
    [createBook, editing, navigate, notifySuccess, updateBook]
  )

  const handleRemove = useCallback(
    async (book: Book): Promise<void> => {
      try {
        const result = await removeBook.mutateAsync({ id: book.id })
        notifySuccess(
          result.removedChapters > 0
            ? `已删除《${result.title}》及其 ${result.removedChapters} 章正文`
            : `已删除《${result.title}》`
        )
      } catch (error) {
        notifyError(error instanceof Error ? error.message : '删除失败')
      }
    },
    [notifyError, notifySuccess, removeBook]
  )

  const mutationError = createBook.error ?? updateBook.error

  return (
    <Flex vertical gap={16} className="page">
      {/* 页面标题仍由 PageHeader 提供（视觉隐藏，供读屏与冒烟测试使用） */}
      <PageHeader title="书籍管理" />

      <Flex className="books-toolbar" align="center" justify="space-between" gap={12} wrap>
        <Flex align="center" gap={8} wrap>
          {/*
           * 新建入口从「标题栏右侧的大主按钮」改成「搜索框左侧的图标按钮 + 悬浮提示」。
           * 理由：它和搜索 / 筛选是同一层的操作，放在工具栏里手指不必横跨整个窗口；
           * 文案转为 tooltip 后不再占位，工具栏一行能多放一个筛选器。
           * aria-label 与 Tooltip 同文案：图标按钮没有可见文字，读屏必须能读出它是什么。
           * shape="circle"：按钮做正圆而不是圆角矩形（只有一个图标时，方形留白会显得比
           * 工具栏里的其他控件重）。圆角由 antd 画成 50%，我们不另外写 px 值去覆盖它。
           */}
          <Tooltip title={<span data-testid="books-add-tip">新建书籍</span>}>
            <Button
              type="primary"
              shape="circle"
              icon={<PlusOutlined />}
              aria-label="新建书籍"
              data-testid="books-add"
              onClick={openCreate}
            />
          </Tooltip>
          <Input
            allowClear
            className="books-toolbar__search"
            prefix={<SearchOutlined />}
            placeholder="搜索书名"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value)
              setPage(1)
            }}
          />
          <Select
            className="books-toolbar__filter"
            value={status}
            options={[
              { value: null, label: '全部状态' },
              ...BOOK_STATUSES.map((item) => ({ value: item, label: BOOK_STATUS_LABELS[item] }))
            ]}
            onChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
          />
          <Select
            className="books-toolbar__filter"
            value={sort}
            options={[
              { value: 'updatedAt', label: '最近写作' },
              { value: 'createdAt', label: '最近创建' },
              { value: 'hanziCount', label: '字数最多' },
              { value: 'title', label: '按书名' }
            ]}
            onChange={(value) => {
              setSort(value)
              setPage(1)
            }}
          />
        </Flex>

        {list.data ? (
          <Text type="secondary" className="books-toolbar__count">
            共 {list.data.total} 本
          </Text>
        ) : null}
      </Flex>

      {list.isError ? (
        <ErrorAlert error={list.error} title="书架加载失败" onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Row gutter={[16, 16]} data-card-row="书架骨架">
          {[0, 1, 2, 3].map((key) => (
            <Col xs={24} sm={12} xl={8} key={key}>
              <Card className="card-fill">
                <Skeleton active paragraph={{ rows: 3 }} />
              </Card>
            </Col>
          ))}
        </Row>
      ) : items.length === 0 ? (
        <Card>
          <Empty
            description={
              <Flex vertical gap={10} align="center">
                <Text type="secondary">
                  {debouncedKeyword.length > 0 || status !== null
                    ? '没有符合条件的书籍'
                    : '书架还是空的'}
                </Text>
                {debouncedKeyword.length === 0 && status === null ? (
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    新建第一本书
                  </Button>
                ) : null}
              </Flex>
            }
          />
        </Card>
      ) : (
        /*
         * 书架是并排的卡片网格，所以每张卡都要吃满列高：每本书的简介长短不一，
         * 不填充的话同一行里「三行的」会把「一行的」衬出一大截空白底边
         * （用户 2026-09-20：「并排的卡片都需要高度对齐」）。
         */
        <Row gutter={[16, 16]} data-testid="book-grid" data-card-row="书架">
          {items.map((book) => {
            const percent = progressPercent(book.hanziCount, book.targetWords)
            return (
              <Col xs={24} sm={12} xl={8} key={book.id}>
                <Card
                  className="book-card card-fill"
                  data-testid="book-card"
                  hoverable
                  onClick={() => void navigate(`/books/${book.id}`)}
                  actions={[
                    <Tooltip title="编辑书籍信息" key="edit">
                      <EditOutlined
                        onClick={(event) => {
                          event.stopPropagation()
                          openEdit(book)
                        }}
                      />
                    </Tooltip>,
                    <Popconfirm
                      key="delete"
                      title={`删除《${book.title}》？`}
                      description={
                        <span>
                          这本书的 {book.chapterCount} 章正文会一并删除，且无法恢复。
                          <br />
                          写作记录会保留，历史字数统计不受影响。
                        </span>
                      }
                      okText="确认删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void handleRemove(book)}
                    >
                      <DeleteOutlined onClick={(event) => event.stopPropagation()} />
                    </Popconfirm>
                  ]}
                >
                  <Flex gap={12}>
                    <span className="book-card__spine" style={{ background: book.accentColor }} />
                    <Flex vertical gap={6} className="book-card__body">
                      <Flex align="center" gap={8} wrap>
                        <Text strong className="book-card__title">
                          {book.title}
                        </Text>
                        <Tag className="tag--flush" color={statusColorOf(book.status)}>
                          {BOOK_STATUS_LABELS[book.status]}
                        </Tag>
                      </Flex>

                      <Text type="secondary" className="book-card__meta">
                        {[book.penName, book.genre].filter((part) => part.length > 0).join(' · ') ||
                          '未填笔名与题材'}
                      </Text>

                      {book.summary.length > 0 ? (
                        <Paragraph
                          type="secondary"
                          className="book-card__summary"
                          ellipsis={{ rows: 2 }}
                        >
                          {book.summary}
                        </Paragraph>
                      ) : null}

                      <Flex gap={12} wrap className="book-card__stats">
                        <Text type="secondary">
                          <ReadOutlined /> {book.volumeCount} 卷 / {book.chapterCount} 章
                        </Text>
                        <Text type="secondary">{formatCount(book.hanziCount)} 字</Text>
                      </Flex>

                      {percent !== null ? (
                        <Flex vertical gap={2}>
                          <Progress
                            percent={percent}
                            size="small"
                            showInfo={false}
                            strokeColor={book.accentColor}
                          />
                          <Text type="secondary" className="book-card__progress">
                            {formatCompact(book.hanziCount)} / {formatCompact(book.targetWords)} ·{' '}
                            {percent}%
                          </Text>
                        </Flex>
                      ) : null}

                      <Flex align="center" justify="space-between">
                        <Text type="secondary" className="book-card__meta">
                          {book.lastEditedAt
                            ? `上次写作 ${formatRelativeTime(book.lastEditedAt)}`
                            : '还没有正文'}
                        </Text>
                        <Text type="secondary" className="book-card__open">
                          打开 <RightOutlined />
                        </Text>
                      </Flex>
                    </Flex>
                  </Flex>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}

      {list.data && list.data.pageCount > 1 ? (
        <Flex justify="center">
          <Pagination
            current={list.data.page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            showSizeChanger={false}
            onChange={setPage}
          />
        </Flex>
      ) : null}

      <BookFormModal
        open={formOpen}
        book={editing}
        submitting={createBook.isPending || updateBook.isPending}
        error={mutationError}
        onSubmit={(values) => void handleSubmit(values)}
        onCancel={() => {
          setFormOpen(false)
          createBook.reset()
          updateBook.reset()
        }}
      />
    </Flex>
  )
}

function statusColorOf(status: BookStatus): string {
  switch (status) {
    case 'serializing':
      return 'processing'
    case 'completed':
      return 'success'
    case 'paused':
      return 'warning'
    default:
      return 'default'
  }
}
