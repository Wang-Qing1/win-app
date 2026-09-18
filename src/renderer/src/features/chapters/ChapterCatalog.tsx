import { memo, useCallback, useMemo, useState } from 'react'
import { Button, Empty, Flex, Input, Select, Skeleton, Tooltip, Typography } from 'antd'
import {
  CheckOutlined,
  CloseOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined
} from '@ant-design/icons'
import type { ChapterListItem } from '@shared/modules/chapters'
import { DEFAULT_BOOK_QUERY, type BookListQuery } from '@shared/modules/books'
import type { VolumeListItem } from '@shared/modules/volumes'
import { formatCount } from '../../lib/format'
import { useBookList } from '../books/use-books'

const { Text } = Typography

/**
 * 书籍切换下拉用的查询：一次取满，不做分页。
 *
 * 一位作者的书通常个位数到几十本，把切换器做成带分页的下拉毫无意义 ——
 * 用户想要的只是「从这本书跳到那本」。上限 200 已经远超实际。
 */
const BOOK_SWITCHER_QUERY: BookListQuery = { ...DEFAULT_BOOK_QUERY, pageSize: 200 }

interface ChapterCatalogProps {
  bookId: number
  activeChapterId: number | null
  chapters: ChapterListItem[] | undefined
  volumes: VolumeListItem[] | undefined
  loading: boolean
  onCreateChapter: (title: string, volumeId: number | null) => void
  onCreateVolume: (title: string) => void
  onSelectChapter: (chapterId: number) => void
  onSwitchBook: (bookId: number) => void
  savingTitle: boolean
}

/**
 * 左侧目录栏。
 *
 * 它承担三件事：切换书籍、新建卷章、在章节间跳转。这三件事都属于
 * 「写作之前的准备工作」，所以放在最左、最窄的一列 —— 一旦开始写，
 * 视线就应该停在中间的正文上。
 *
 * 章节列表带上每章字数，这是有实际用途的：作者靠它快速判断哪一章
 * 偏短（网文单章通常 2000–4000 字），而不用逐章点开。
 *
 * 用 React.memo 包起来：正文每敲一个字都会触发页面重新渲染，而目录
 * 可能有上千行 —— 不做记忆化的话，每次按键都会把所有行重渲一遍。
 */
export const ChapterCatalog = memo(function ChapterCatalog({
  bookId,
  activeChapterId,
  chapters,
  volumes,
  loading,
  onCreateChapter,
  onCreateVolume,
  onSelectChapter,
  onSwitchBook,
  savingTitle
}: ChapterCatalogProps) {
  const { data: bookList } = useBookList(BOOK_SWITCHER_QUERY)
  const [collapsedVolumes, setCollapsedVolumes] = useState<ReadonlySet<number>>(new Set())
  const [draft, setDraft] = useState<{ kind: 'chapter' | 'volume'; volumeId: number | null } | null>(
    null
  )
  const [title, setTitle] = useState('')

  const grouped = useMemo(() => {
    const loose: ChapterListItem[] = []
    const byVolume = new Map<number, ChapterListItem[]>()

    for (const chapter of chapters ?? []) {
      if (chapter.volumeId === null) {
        loose.push(chapter)
      } else {
        const bucket = byVolume.get(chapter.volumeId)
        if (bucket) bucket.push(chapter)
        else byVolume.set(chapter.volumeId, [chapter])
      }
    }

    return { loose, byVolume }
  }, [chapters])

  const bookOptions = useMemo(
    () => (bookList?.items ?? []).map((item) => ({ value: item.id, label: item.title })),
    [bookList]
  )

  const toggleVolume = useCallback((volumeId: number): void => {
    setCollapsedVolumes((previous) => {
      const next = new Set(previous)
      if (next.has(volumeId)) next.delete(volumeId)
      else next.add(volumeId)
      return next
    })
  }, [])

  const startDraft = useCallback((kind: 'chapter' | 'volume', volumeId: number | null): void => {
    setDraft({ kind, volumeId })
    setTitle('')
  }, [])

  const cancelDraft = useCallback((): void => {
    setDraft(null)
    setTitle('')
  }, [])

  const commitDraft = useCallback((): void => {
    if (!draft) return
    const trimmed = title.trim()
    if (trimmed.length === 0) return

    if (draft.kind === 'chapter') onCreateChapter(trimmed, draft.volumeId)
    else onCreateVolume(trimmed)

    setDraft(null)
    setTitle('')
  }, [draft, onCreateChapter, onCreateVolume, title])

  const totalHanzi = useMemo(
    () => (chapters ?? []).reduce((sum, chapter) => sum + chapter.hanziCount, 0),
    [chapters]
  )

  return (
    <aside className="catalog" data-testid="chapter-catalog">
      {/* ---------------- 书籍切换 ---------------- */}
      <div className="catalog__head">
        <Select
          size="small"
          className="catalog__book-select"
          value={bookId}
          options={bookOptions}
          loading={bookList === undefined}
          onChange={onSwitchBook}
          showSearch
          optionFilterProp="label"
        />

        <Flex gap={6}>
          <Button
            size="small"
            type="primary"
            block
            icon={<PlusOutlined />}
            onClick={() => startDraft('chapter', activeVolumeId(chapters, activeChapterId))}
          >
            新建章
          </Button>
          <Button size="small" block onClick={() => startDraft('volume', null)}>
            新建卷
          </Button>
        </Flex>

        {draft ? (
          <Flex gap={4} className="catalog__draft">
            <Input
              size="small"
              autoFocus
              value={title}
              placeholder={draft.kind === 'chapter' ? '章节标题' : '分卷名称'}
              onChange={(event) => setTitle(event.target.value)}
              onPressEnter={commitDraft}
              disabled={savingTitle}
            />
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={savingTitle}
              onClick={commitDraft}
            />
            <Button size="small" icon={<CloseOutlined />} onClick={cancelDraft} />
          </Flex>
        ) : null}
      </div>

      {/* ---------------- 目录 ---------------- */}
      <Flex align="center" justify="space-between" className="catalog__section">
        <Text strong className="catalog__section-title">
          目录
        </Text>
        <Text type="secondary" className="catalog__summary">
          {(chapters ?? []).length} 章 · {formatCount(totalHanzi)}
        </Text>
      </Flex>

      <div className="catalog__list">
        {loading ? (
          <Skeleton active paragraph={{ rows: 8 }} title={false} />
        ) : (chapters ?? []).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<Text type="secondary">还没有章节</Text>}
          />
        ) : (
          <>
            {(volumes ?? []).map((volume) => {
              const items = grouped.byVolume.get(volume.id) ?? []
              const collapsed = collapsedVolumes.has(volume.id)
              return (
                <div key={`volume-${volume.id}`}>
                  <Flex
                    align="center"
                    gap={4}
                    className="catalog__volume"
                    onClick={() => toggleVolume(volume.id)}
                  >
                    {collapsed ? <RightOutlined /> : <LeftOutlined rotate={-90} />}
                    <Text className="catalog__volume-title" ellipsis>
                      {volume.title}
                    </Text>
                    <Text type="secondary" className="catalog__count">
                      {items.length}
                    </Text>
                    <Tooltip title="在这个分卷下新建章节">
                      <Button
                        size="small"
                        type="text"
                        icon={<PlusOutlined />}
                        onClick={(event) => {
                          event.stopPropagation()
                          startDraft('chapter', volume.id)
                        }}
                      />
                    </Tooltip>
                  </Flex>

                  {collapsed
                    ? null
                    : items.map((chapter) => (
                        <CatalogRow
                          key={chapter.id}
                          chapter={chapter}
                          active={chapter.id === activeChapterId}
                          onSelect={onSelectChapter}
                        />
                      ))}
                </div>
              )
            })}

            {grouped.loose.length > 0 ? (
              <>
                {(volumes ?? []).length > 0 ? (
                  <Flex className="catalog__volume catalog__volume--static">
                    <Text type="secondary" className="catalog__volume-title">
                      未分卷
                    </Text>
                    <Text type="secondary" className="catalog__count">
                      {grouped.loose.length}
                    </Text>
                  </Flex>
                ) : null}
                {grouped.loose.map((chapter) => (
                  <CatalogRow
                    key={chapter.id}
                    chapter={chapter}
                    active={chapter.id === activeChapterId}
                    onSelect={onSelectChapter}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="catalog__foot">
        <Button
          type="text"
          block
          icon={<PlusOutlined />}
          onClick={() => startDraft('chapter', activeVolumeId(chapters, activeChapterId))}
        >
          新建章节
        </Button>
      </div>
    </aside>
  )
})

interface CatalogRowProps {
  chapter: ChapterListItem
  active: boolean
  onSelect: (chapterId: number) => void
}

const CatalogRow = memo(function CatalogRow({ chapter, active, onSelect }: CatalogRowProps) {
  return (
    <button
      type="button"
      className={`catalog__row${active ? ' catalog__row--active' : ''}`}
      data-testid="catalog-row"
      data-active={active ? 'true' : 'false'}
      onClick={() => onSelect(chapter.id)}
    >
      <span className="catalog__row-title">{chapter.title}</span>
      <span className="catalog__row-count">{chapter.hanziCount}</span>
    </button>
  )
})

/**
 * 新建章节时默认落在哪一卷。
 *
 * 用「当前正在编辑的那一章所属的卷」而不是「最后一卷」：作者通常是在
 * 连续写同一卷的内容，新建时把它放进当前卷是常见的期待。当前没有
 * 章节时就退回未分卷，由作者在列表里自行归置。
 */
function activeVolumeId(
  chapters: ChapterListItem[] | undefined,
  activeChapterId: number | null
): number | null {
  if (!chapters || activeChapterId === null) return null
  return chapters.find((chapter) => chapter.id === activeChapterId)?.volumeId ?? null
}
