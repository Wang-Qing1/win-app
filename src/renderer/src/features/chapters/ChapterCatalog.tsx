import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import {Button, Dropdown, Empty, Flex, Select, Skeleton, Typography, type MenuProps} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined
} from '@ant-design/icons'
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
import { VolumeFormModal, type VolumeFormValues } from './VolumeFormModal'

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

/**
 * 章节菜单里「不是改字段」的那几项 —— 它们动的是顺序或存在性。
 *
 * 与 `ChapterPatch` 分开：补丁是「改这个字段的值」，而这三项要的是
 * 「拿这一章去做一件别的事」，处理方式完全不同（重排要提交整个容器的
 * 完整顺序、删除要先确认）。
 */
export type ChapterMenuAction = 'up' | 'down' | 'remove'

/** 分卷菜单里的动作。改名收进了弹窗，不再当「动作」发出去 */
export type VolumeMenuAction = 'up' | 'down' | 'export' | 'remove'

interface ChapterCatalogProps {
  bookId: number
  activeChapterId: number | null
  chapters: ChapterListItem[] | undefined
  volumes: VolumeListItem[] | undefined
  loading: boolean
  /**
   * 打开「新建章」弹窗。
   *
   * 弹窗本身**不在这里**：空书打开时，正文区中央那枚「新建第一章」也要能
   * 打开同一个弹窗（用户 2026-09-20：「打开书籍后直接就是正文编辑界面，
   * 左侧可以新建卷和章节」），而它渲染在目录栏外面。弹窗由页面持有，
   * 两处入口都调这一个回调 —— 两个入口两份弹窗的实现，迟早会长歪。
   */
  onOpenChapterModal: () => void
  onCreateVolume: (title: string) => Promise<boolean>
  /** 分卷改名。返回是否真的改成了，失败时弹窗留着别把用户敲的字吃掉 */
  onRenameVolume: (volume: VolumeListItem, title: string) => Promise<boolean>
  onSelectChapter: (chapterId: number) => void
  onSwitchBook: (bookId: number) => void
  /** 目录行右键菜单里改状态 / 移分卷时回调 */
  onPatchChapter: (chapter: ChapterListItem, patch: ChapterPatch) => void
  /** 目录行右键菜单里的上移 / 下移 / 删除 */
  onChapterAction: (chapter: ChapterListItem, action: ChapterMenuAction) => void
  /** 分卷行右键菜单里的全部动作 */
  onVolumeAction: (volume: VolumeListItem, action: VolumeMenuAction) => void
  /** 建卷 / 改名进行中，用来让弹窗的确认键进入加载态 */
  savingTitle: boolean
}

/**
 * 左侧目录栏。
 *
 * 它承担三件事：切换书籍、新建卷章、在章节间跳转。这三件事都属于
 * 「写作之前的准备工作」，所以放在最左、最窄的一列 —— 一旦开始写，
 * 视线就应该停在中间的正文上。
 *
 * **新建的入口只有头部那两枚**（[+ 新建章] / [+ 新建卷]）。这里刻意没有
 * 「分卷行上的 +」和「列表底部的 + 新建章节」：同一件事在一屏里给三个入口，
 * 唯一的效果是让人每次都要先做一次无意义的选择（点哪个都一样），
 * 而目录栏本身窄，这些按钮还挤占了本该给章节标题的宽度。
 *
 * **这两枚是全项目唯一保留文字的按钮**（用户 2026-09-20 点名例外）：别的
 * 按钮都改成了圆形图标 + 悬浮提示，而它们两个图标都是加号，圆钮化之后
 * 「章」与「卷」就分不出来了 —— 详见头部那段注释。
 *
 * **新建卷与编辑卷都是弹窗**（用户 2026-09-20：「新建/编辑卷也要是弹窗的
 * 形式」）。以前是目录栏里的行内输入条 —— 184px 宽的列里挤一条输入框，
 * 顺带把「简介」这个字段整个藏没了；弹窗不占布局，两个字段都放得下。
 *
 * **空卷也要显示**（同一天追加的要求）：一卷书常常是先建卷、后写章的，
 * 卷建好而章还是零的时候，卷必须在目录树里站住那一行，而不是跟着
 * 「还没有章节」的空状态一起消失。
 *
 * 章节列表带上每章字数，这是有实际用途的：作者靠它快速判断哪一章
 * 偏短（网文单章通常 2000–4000 字），而不用逐章点开。
 *
 * **事后修改走行的右键菜单**：章节行能改状态 / 分卷 / 顺序，也能删；
 * 分卷行能改名（弹窗）/ 排序 / 导出本卷 / 删除。
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
  onOpenChapterModal,
  onCreateVolume,
  onRenameVolume,
  onPatchChapter,
  onChapterAction,
  onVolumeAction,
  onSelectChapter,
  onSwitchBook,
  savingTitle
}: ChapterCatalogProps) {
  const { data: bookList } = useBookList(BOOK_SWITCHER_QUERY)
  const [collapsedVolumes, setCollapsedVolumes] = useState<ReadonlySet<number>>(new Set())
  /** 分卷弹窗：null = 新建，非 null = 编辑这一卷 */
  const [volumeModalVolume, setVolumeModalVolume] = useState<VolumeListItem | null>(null)
  const [volumeModalOpen, setVolumeModalOpen] = useState(false)

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

  const openCreateVolumeModal = useCallback((): void => {
    setVolumeModalVolume(null)
    setVolumeModalOpen(true)
  }, [])

  const openEditVolumeModal = useCallback((volume: VolumeListItem): void => {
    setVolumeModalVolume(volume)
    setVolumeModalOpen(true)
  }, [])

  /** 弹窗提交：按打开时的模式分发给建卷 / 改名。成功了才关弹窗 */
  const handleVolumeSubmit = useCallback(
    async (values: VolumeFormValues): Promise<boolean> => {
      const title = values.title.trim()
      if (title.length === 0) return false

      const ok =
        volumeModalVolume === null
          ? await onCreateVolume(title)
          : await onRenameVolume(volumeModalVolume, title)
      if (ok) setVolumeModalOpen(false)
      return ok
    },
    [onCreateVolume, onRenameVolume, volumeModalVolume]
  )

  const totalHanzi = useMemo(
    () => (chapters ?? []).reduce((sum, chapter) => sum + chapter.hanziCount, 0),
    [chapters]
  )

  const hasAnything = (chapters ?? []).length > 0 || volumeItems.length > 0

  return (
    <aside className="catalog" data-testid="chapter-catalog">
      {/* ---------------- 书籍切换 + 唯一的两枚新建圆钮 ---------------- */}
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

        {/*
          这两枚是**带文字的按钮**，不是圆形图标钮 —— 用户 2026-09-20 点名：
          「目录栏头部按钮不用改成图标 + 鼠标悬浮提示的形式」。

          道理也确实在这两枚身上成立：它们是这一栏**唯一的常驻动作**，而
          「新建章」与「新建卷」是两件不同的事，圆钮化之后两枚都只剩一个
          加号，第一次进来的人只能靠悬停挨个猜。别处的按钮之所以能圆钮化，
          是因为它们的图标本身已经把话说清了（铅笔=写、书本=打开）；两个
          一模一样的加号则相反 —— 在这里省掉文字等于把区分成本转嫁给作者。

          所以这是全项目「圆钮 + 悬浮提示」这套规矩**唯一登记的例外**：
          其它地方新增按钮仍走 `IconButton`，只有这里保留文字。
        */}
        <Flex gap={6}>
          <Button
            size="small"
            type="primary"
            block
            icon={<PlusOutlined />}
            onClick={onOpenChapterModal}
            data-testid="catalog-new-chapter"
          >
            新建章
          </Button>
          <Button
            size="small"
            block
            icon={<PlusOutlined />}
            onClick={openCreateVolumeModal}
            data-testid="catalog-new-volume"
          >
            新建卷
          </Button>
        </Flex>
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
        ) : !hasAnything ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<Text type="secondary">还没有分卷和章节</Text>}
          />
        ) : (
          <>
            {/*
              卷先渲染、章跟在卷里：**哪怕一卷的章节数是 0**，这一行也在
              （先建卷后写章是常规操作，卷建好了却从树上消失，作者会以为没建成）。
            */}
            {volumeItems.map((volume, volumeIndex) => {
              const items = grouped.byVolume.get(volume.id) ?? []
              const collapsed = collapsedVolumes.has(volume.id)

              return (
                <div
                  key={`volume-${volume.id}`}
                  data-testid="catalog-volume-group"
                  data-volume-id={volume.id}
                >
                  <VolumeRow
                    volume={volume}
                    count={items.length}
                    collapsed={collapsed}
                    first={volumeIndex === 0}
                    last={volumeIndex === volumeItems.length - 1}
                    onToggle={toggleVolume}
                    onAction={onVolumeAction}
                    onEdit={openEditVolumeModal}
                  />

                  {collapsed
                    ? null
                    : items.map((chapter, index) => (
                        <CatalogRow
                          key={chapter.id}
                          chapter={chapter}
                          active={chapter.id === activeChapterId}
                          volumes={volumeItems}
                          first={index === 0}
                          last={index === items.length - 1}
                          onPatch={onPatchChapter}
                          onAction={onChapterAction}
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
                {grouped.loose.map((chapter, index) => (
                  <CatalogRow
                    key={chapter.id}
                    chapter={chapter}
                    active={chapter.id === activeChapterId}
                    volumes={volumeItems}
                    first={index === 0}
                    last={index === grouped.loose.length - 1}
                    onPatch={onPatchChapter}
                    onAction={onChapterAction}
                    onSelect={onSelectChapter}
                  />
                ))}
              </div>
            ) : null}

            {(chapters ?? []).length === 0 ? (
              <Text type="secondary" className="catalog__summary">
                还没有章节
              </Text>
            ) : null}
          </>
        )}
      </div>

      {/* 新建与编辑共用这一个弹窗，两种入口不会长成两种样子 */}
      <VolumeFormModal
        open={volumeModalOpen}
        volume={volumeModalVolume}
        submitting={savingTitle}
        onSubmit={handleVolumeSubmit}
        onCancel={() => setVolumeModalOpen(false)}
      />
    </aside>
  )
})

/* ------------------------------------------------------------------ *
 * 分卷行
 * ------------------------------------------------------------------ */

interface VolumeRowProps {
  volume: VolumeListItem
  /** 这一卷下的章节数。0 也要照常显示这一行 */
  count: number
  collapsed: boolean
  first: boolean
  last: boolean
  onToggle: (volumeId: number) => void
  onAction: (volume: VolumeListItem, action: VolumeMenuAction) => void
  /** 「重命名分卷」→ 打开编辑弹窗（不再走行内输入） */
  onEdit: (volume: VolumeListItem) => void
}

/**
 * 一行分卷：点一下折叠 / 展开，右键出菜单。
 */
function VolumeRow({ volume, count, collapsed, first, last, onToggle, onAction, onEdit }: VolumeRowProps) {
  const menuItems = useMemo<MenuProps['items']>(
    () => [
      {
        key: 'rename',
        icon: <EditOutlined />,
        label: <span data-testid="catalog-volume-menu-rename">编辑分卷</span>
      },
      { type: 'divider' },
      {
        key: 'up',
        icon: <ArrowUpOutlined />,
        disabled: first,
        label: <span data-testid="catalog-volume-menu-up">上移</span>
      },
      {
        key: 'down',
        icon: <ArrowDownOutlined />,
        disabled: last,
        label: <span data-testid="catalog-volume-menu-down">下移</span>
      },
      { type: 'divider' },
      {
        key: 'export',
        icon: <ExportOutlined />,
        label: <span data-testid="catalog-volume-menu-export">导出本卷</span>
      },
      {
        key: 'remove',
        icon: <DeleteOutlined />,
        danger: true,
        label: <span data-testid="catalog-volume-menu-remove">删除分卷</span>
      }
    ],
    [first, last]
  )

  const handleMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(
    (info): void => {
      const action = String(info.key) as VolumeMenuAction | 'rename'
      // 改名不发「动作」事件：它打开的是编辑弹窗，由目录栏自己处理
      if (action === 'rename') onEdit(volume)
      else onAction(volume, action)
    },
    [onAction, onEdit, volume]
  )

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{ items: menuItems, onClick: handleMenuClick }}
      overlayClassName="catalog__menu"
    >
      <Flex
        align="center"
        gap={4}
        className="catalog__volume"
        data-testid="catalog-volume"
        data-volume-id={volume.id}
        // 右键菜单是个看不见的入口，title 是它唯一的「被发现」渠道
        title={`${volume.title}｜${count} 章｜右键可编辑 / 排序 / 导出 / 删除`}
        onClick={() => onToggle(volume.id)}
      >
        {collapsed ? <RightOutlined /> : <LeftOutlined rotate={-90} />}
        <Text className="catalog__volume-title" ellipsis>
          {volume.title}
        </Text>
        <Text type="secondary" className="catalog__count">
          {count}
        </Text>
      </Flex>
    </Dropdown>
  )
}

/* ------------------------------------------------------------------ *
 * 章节行
 * ------------------------------------------------------------------ */

interface CatalogRowProps {
  chapter: ChapterListItem
  active: boolean
  volumes: VolumeListItem[]
  /** 在这一卷（或「未分卷」）里的位置，用来决定上移 / 下移能不能点 */
  first: boolean
  last: boolean
  onPatch: (chapter: ChapterListItem, patch: ChapterPatch) => void
  onAction: (chapter: ChapterListItem, action: ChapterMenuAction) => void
  onSelect: (chapterId: number) => void
}

/**
 * 一行章节，右键出菜单改状态 / 分卷 / 顺序，或删掉它。
 *
 * 为什么右键而不是行内控件：这一行只有 184px 宽，还挤着标题和字数。
 * 而这些都是低频操作（状态一章改几次、分卷基本只在一卷写完时动一次），
 * 让它们常驻会一直吃掉标题的宽度 —— 而标题宽度是这一列唯一真正稀缺的东西。
 *
 * 菜单**不用子菜单**（悬停展开的那种），而是把各组选项直接平铺在同一个
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
  first,
  last,
  onPatch,
  onAction,
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
      },
      { type: 'divider' },
      {
        key: 'up',
        icon: <ArrowUpOutlined />,
        // 排在最前 / 最后时置灰。点它其实也无害（实现里会判越界直接返回），
        // 但一枚「点了没反应」的菜单项会让人以为界面卡住了
        disabled: first,
        label: <span data-testid="catalog-menu-chapter-up">上移</span>
      },
      {
        key: 'down',
        icon: <ArrowDownOutlined />,
        disabled: last,
        label: <span data-testid="catalog-menu-chapter-down">下移</span>
      },
      {
        key: 'remove',
        icon: <DeleteOutlined />,
        danger: true,
        label: <span data-testid="catalog-menu-chapter-remove">删除本章</span>
      }
    ]
  }, [chapter.status, chapter.volumeId, first, last, volumes])

  const handleMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(
    (info): void => {
      const key = String(info.key)

      if (key.startsWith('status:')) {
        const status = key.slice('status:'.length) as ChapterStatus
        // 点在当前值上不是「改」：放过去会白写一次库，还会把列表的
        // updatedAt 推新，让「最近修改」这类排序凭据无端变动
        if (status !== chapter.status) onPatch(chapter, { status })
        return
      }

      if (key.startsWith('volume:')) {
        const raw = key.slice('volume:'.length)
        const volumeId = raw === 'none' ? null : Number(raw)
        if (volumeId !== chapter.volumeId) onPatch(chapter, { volumeId })
        return
      }

      if (key === 'up' || key === 'down' || key === 'remove') onAction(chapter, key)
    },
    [chapter, onAction, onPatch]
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
        title={`${CHAPTER_STATUS_LABELS[chapter.status]}｜右键可改状态、分卷、顺序或删除`}
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
