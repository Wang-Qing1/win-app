import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  Dropdown,
  Empty,
  Flex,
  Input,
  Select,
  Skeleton,
  Typography,
  type MenuProps
} from 'antd'
import { CheckOutlined, CloseOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import {
  CHAPTER_STATUSES,
  CHAPTER_STATUS_LABELS,
  type ChapterListItem,
  type ChapterStatus
} from '@shared/modules/chapters'
import { DEFAULT_BOOK_QUERY, type BookListQuery } from '@shared/modules/books'
import type { VolumeListItem } from '@shared/modules/volumes'
import { formatCount } from '../../lib/format'
import { useBookList } from '../books/use-books'
import { ChapterCreateModal, type ChapterCreateValues } from './ChapterCreateModal'

const { Text } = Typography

/**
 * 书籍切换下拉用的查询：一次取满，不做分页。
 *
 * 一位作者的书通常个位数到几十本，把切换器做成带分页的下拉毫无意义 ——
 * 用户想要的只是「从这本书跳到那本」。上限 200 已经远超实际。
 */
const BOOK_SWITCHER_QUERY: BookListQuery = { ...DEFAULT_BOOK_QUERY, pageSize: 200 }

/**
 * 稳定的空数组常量。
 *
 * `volumes ?? []` 每次渲染都会造一个新数组，而它要逐个传给每一行 ——
 * CatalogRow 是 memo 的，一个每帧都换引用的 prop 会让记忆化彻底失效，
 * 目录有多少行就被重渲多少行（这正是这个组件在正文打字时最怕的事）。
 */
const EMPTY_VOLUMES: VolumeListItem[] = []

/**
 * 目录行右键菜单能改的两件事。
 *
 * 只有这两个，是因为**别的字段本来就有入口**：标题在正文上方那一行可改、
 * 正文在中间的编辑器里、每章最少字数是书籍级规则（全书统一）。而这两项
 * 在新建章弹窗之外没有任何入口 —— 状态会随写作推进变化（草稿→修订中→
 * 已完成），却没有任何地方能改它，也没有任何地方能显示它。
 *
 * 用「补丁」而不是整套 ChapterUpdateInput：调用方（编辑页）才知道当前章
 * 有没有未落盘的标题改动，由它去拼完整的入参，菜单只说「我改了哪一项」。
 */
export interface ChapterPatch {
  status?: ChapterStatus
  volumeId?: number | null
}

interface ChapterCatalogProps {
  bookId: number
  activeChapterId: number | null
  chapters: ChapterListItem[] | undefined
  volumes: VolumeListItem[] | undefined
  loading: boolean
  /** 书籍的「每章最少字数」，透传给新建章弹窗做说明 */
  chapterWords: number
  onCreateChapter: (values: ChapterCreateValues) => Promise<boolean>
  onCreateVolume: (title: string) => void
  onSelectChapter: (chapterId: number) => void
  onSwitchBook: (bookId: number) => void
  /** 目录行右键菜单里改状态 / 移分卷时回调 */
  onPatchChapter: (chapter: ChapterListItem, patch: ChapterPatch) => void
  savingTitle: boolean
}

/**
 * 左侧目录栏。
 *
 * 它承担三件事：切换书籍、新建卷章、在章节间跳转。这三件事都属于
 * 「写作之前的准备工作」，所以放在最左、最窄的一列 —— 一旦开始写，
 * 视线就应该停在中间的正文上。
 *
 * **新建的入口只有头部那一个**（[+新建章] / [新建卷]）。这里刻意没有
 * 「分卷行上的 +」和「列表底部的 + 新建章节」：同一件事在一屏里给三个入口，
 * 唯一的效果是让人每次都要先做一次无意义的选择（点哪个都一样），
 * 而目录栏本身窄，这些按钮还挤占了本该给章节标题的宽度。
 *
 * 章节列表带上每章字数，这是有实际用途的：作者靠它快速判断哪一章
 * 偏短（网文单章通常 2000–4000 字），而不用逐章点开。
 *
 * **事后修改分卷与状态走行的右键菜单**（见 CatalogRow）。它们原先只在新
 * 建章弹窗里能设，而状态是会随写作推进变化的（草稿→修订中→已完成），
 * 设完就再也改不了等于这个字段是死的。放在右键菜单而不是行内加控件：
 * 目录栏只有 180px，塞不下两个下拉；而且这两项都是低频操作，
 * 不值得长期占着那一行的宽度。
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
  chapterWords,
  onCreateChapter,
  onCreateVolume,
  onPatchChapter,
  onSelectChapter,
  onSwitchBook,
  savingTitle
}: ChapterCatalogProps) {
  const { data: bookList } = useBookList(BOOK_SWITCHER_QUERY)
  const [collapsedVolumes, setCollapsedVolumes] = useState<ReadonlySet<number>>(new Set())
  const [chapterModalOpen, setChapterModalOpen] = useState(false)
  const [volumeDraftOpen, setVolumeDraftOpen] = useState(false)
  const [volumeTitle, setVolumeTitle] = useState('')

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

  const volumeItems = volumes ?? EMPTY_VOLUMES

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

  /* 新建章：弹窗一次收齐标题 / 分卷 / 状态 */
  const openChapterModal = useCallback((): void => {
    setChapterModalOpen(true)
  }, [])

  const submitChapter = useCallback(
    async (values: ChapterCreateValues): Promise<boolean> => {
      const created = await onCreateChapter(values)
      // 建成了才关。留在原地（这是之前的实际行为）会让作者看到「弹窗还在、
      // 后面的章节其实已经建好了」，第一反应是「没成功吧」再点一次 ——
      // 于是建出两章同名。
      if (created) setChapterModalOpen(false)
      return created
    },
    [onCreateChapter]
  )

  /* 新建卷：只有一个字段，用行内输入就够，不必再弹一层 */
  const openVolumeDraft = useCallback((): void => {
    setVolumeDraftOpen(true)
    setVolumeTitle('')
  }, [])

  const commitVolumeDraft = useCallback((): void => {
    const trimmed = volumeTitle.trim()
    if (trimmed.length === 0) return
    onCreateVolume(trimmed)
    setVolumeDraftOpen(false)
    setVolumeTitle('')
  }, [onCreateVolume, volumeTitle])

  const totalHanzi = useMemo(
    () => (chapters ?? []).reduce((sum, chapter) => sum + chapter.hanziCount, 0),
    [chapters]
  )

  /**
   * 新建章节时默认落在哪一卷。
   *
   * 用「当前正在编辑的那一章所属的卷」而不是「最后一卷」：作者通常是在
   * 连续写同一卷的内容，新建时把它放进当前卷是常见的期待。当前没有
   * 章节时就退回未分卷，由作者在弹窗里自行归置。
   */
  const defaultVolumeId = useMemo(() => {
    if (!chapters || activeChapterId === null) return null
    return chapters.find((chapter) => chapter.id === activeChapterId)?.volumeId ?? null
  }, [activeChapterId, chapters])

  /** 预填标题：「第 N 章」。作者连着往下写时多半就是这个，不必手打 */
  const suggestTitle = `第 ${(chapters ?? []).length + 1} 章`

  return (
    <aside className="catalog" data-testid="chapter-catalog">
      {/* ---------------- 书籍切换 + 唯一的两个新建入口 ---------------- */}
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
            onClick={openChapterModal}
            data-testid="catalog-new-chapter"
          >
            新建章
          </Button>
          <Button
            size="small"
            block
            onClick={openVolumeDraft}
            icon={<PlusOutlined />}
            data-testid="catalog-new-volume"
          >
            新建卷
          </Button>
        </Flex>

        {volumeDraftOpen ? (
          <Flex gap={4} className="catalog__draft">
            <Input
              size="small"
              autoFocus
              value={volumeTitle}
              placeholder="分卷名称"
              onChange={(event) => setVolumeTitle(event.target.value)}
              onPressEnter={commitVolumeDraft}
              disabled={savingTitle}
            />
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={savingTitle}
              onClick={commitVolumeDraft}
            />
            <Button
              size="small"
              icon={<CloseOutlined />}
              onClick={() => setVolumeDraftOpen(false)}
            />
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
            {volumeItems.map((volume) => {
              const items = grouped.byVolume.get(volume.id) ?? []
              const collapsed = collapsedVolumes.has(volume.id)
              return (
                <div
                  key={`volume-${volume.id}`}
                  data-testid="catalog-volume-group"
                  data-volume-id={volume.id}
                >
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
                  </Flex>

                  {collapsed
                    ? null
                    : items.map((chapter) => (
                        <CatalogRow
                          key={chapter.id}
                          chapter={chapter}
                          active={chapter.id === activeChapterId}
                          volumes={volumeItems}
                          onPatch={onPatchChapter}
                          onSelect={onSelectChapter}
                        />
                      ))}
                </div>
              )
            })}

            {grouped.loose.length > 0 ? (
              <div data-testid="catalog-volume-group" data-volume-id="none">
                {volumeItems.length > 0 ? (
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
                    volumes={volumeItems}
                    onPatch={onPatchChapter}
                    onSelect={onSelectChapter}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <ChapterCreateModal
        open={chapterModalOpen}
        volumes={volumeItems}
        defaultVolumeId={defaultVolumeId}
        suggestTitle={suggestTitle}
        chapterWords={chapterWords}
        submitting={savingTitle}
        onSubmit={submitChapter}
        onCancel={() => setChapterModalOpen(false)}
      />
    </aside>
  )
})

interface CatalogRowProps {
  chapter: ChapterListItem
  active: boolean
  volumes: VolumeListItem[]
  onPatch: (chapter: ChapterListItem, patch: ChapterPatch) => void
  onSelect: (chapterId: number) => void
}

/**
 * 一行章节，右键出菜单改「状态」与「所属分卷」。
 *
 * 为什么右键而不是行内控件：这一行只有 180px 宽，还挤着标题和字数。
 * 而这两项都是低频操作（状态一章改几次、分卷基本只在一卷写完时动一次），
 * 让它们常驻会一直吃掉标题的宽度 —— 而标题宽度是这一列唯一真正稀缺的东西。
 *
 * 菜单**不用子菜单**（悬停展开的那种），而是把两组选项直接平铺在同一个
 * 浮层里：分卷通常只有几卷，平铺一眼就能看全，比「悬停等一下再展开」
 * 少一次试错；也顺带避免了一个具体问题 —— 后台窗口 / 无 GPU 环境下
 * 悬停展开的子浮层不一定会被渲染出来，那会让这一整块行为没法自动验证。
 *
 * 当前值用对勾标出（而不是置灰）：置灰读起来是「这一项不可用」，
 * 而实际语义是「你已经在这一项上」。
 */
const CatalogRow = memo(function CatalogRow({
  chapter,
  active,
  volumes,
  onPatch,
  onSelect
}: CatalogRowProps) {
  const menuItems = useMemo<MenuProps['items']>(() => {
    const check = (current: boolean): ReactNode => (current ? <CheckOutlined /> : null)

    return [
      {
        type: 'group',
        label: '状态',
        children: CHAPTER_STATUSES.map((status) => ({
          key: `status:${status}`,
          icon: check(chapter.status === status),
          label: (
            <span
              data-testid={`catalog-menu-status-${status}`}
              data-current={chapter.status === status ? 'true' : 'false'}
            >
              {CHAPTER_STATUS_LABELS[status]}
            </span>
          )
        }))
      },
      { type: 'divider' },
      {
        type: 'group',
        label: '移到分卷',
        children: [
          {
            key: 'volume:none',
            icon: check(chapter.volumeId === null),
            label: (
              <span
                data-testid="catalog-menu-volume-none"
                data-current={chapter.volumeId === null ? 'true' : 'false'}
              >
                未分卷
              </span>
            )
          },
          ...volumes.map((volume) => ({
            key: `volume:${volume.id}`,
            icon: check(chapter.volumeId === volume.id),
            label: (
              <span
                data-testid={`catalog-menu-volume-${volume.id}`}
                data-current={chapter.volumeId === volume.id ? 'true' : 'false'}
              >
                {volume.title}
              </span>
            )
          }))
        ]
      }
    ]
  }, [chapter.status, chapter.volumeId, volumes])

  const handleMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(
    (info): void => {
      const [kind, raw] = String(info.key).split(':')

      if (kind === 'status') {
        const status = raw as ChapterStatus
        // 点在当前值上不是「改」：放过去会白写一次库，还会把列表的
        // updatedAt 推新，让「最近修改」这类排序凭据无端变动
        if (status !== chapter.status) onPatch(chapter, { status })
        return
      }

      if (kind === 'volume') {
        const volumeId = raw === 'none' ? null : Number(raw)
        if (volumeId !== chapter.volumeId) onPatch(chapter, { volumeId })
      }
    },
    [chapter, onPatch]
  )

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{ items: menuItems, onClick: handleMenuClick }}
      overlayClassName="catalog__menu"
    >
      <button
        type="button"
        className={`catalog__row${active ? ' catalog__row--active' : ''}`}
        data-testid="catalog-row"
        data-active={active ? 'true' : 'false'}
        data-chapter-id={chapter.id}
        data-status={chapter.status}
        // 右键菜单是个看不见的入口，这两张标签是它唯一的「被发现」渠道：
        // 悬停时能读到本章状态，并被告知这里可以右键
        title={`${CHAPTER_STATUS_LABELS[chapter.status]}｜右键可改状态与分卷`}
        onClick={() => onSelect(chapter.id)}
      >
        {/*
          草稿不显点。绝大多数行都是草稿，给每一行都点一个点等于没有重点；
          而「哪些章已经收尾」恰恰是靠这几个点一眼扫出来的。
        */}
        {chapter.status === 'draft' ? null : (
          <span
            className={`catalog__row-dot catalog__row-dot--${chapter.status}`}
            data-testid="catalog-row-status-dot"
            aria-hidden
          />
        )}
        <span className="catalog__row-title">{chapter.title}</span>
        <span className="catalog__row-count">{chapter.hanziCount}</span>
      </button>
    </Dropdown>
  )
})
