import { useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Flex, Input, Pagination, Select, Skeleton, Tag, Tooltip, Typography } from 'antd'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router'
import { DEFAULT_BOOK_QUERY } from '@shared/modules/books'
import {
  CARD_LIMITS,
  CARD_TYPES,
  CARD_TYPE_LABELS,
  DEFAULT_CARD_QUERY,
  SETTING_CATEGORIES,
  isCardBookScope,
  isCardType,
  isSettingCategory,
  type Card,
  type CardBookScope,
  type CardListQuery,
  type CardType,
  type SettingCategory
} from '@shared/modules/cards'
import { ErrorAlert } from '../../components/ErrorAlert'
import { IconButton } from '../../components/IconButton'
import { PageHeader } from '../../components/PageHeader'
import { useToast } from '../../components/Toast'
import { useBookList } from '../books/use-books'
import { CARD_TYPE_COLORS } from './card-meta'
import { CardEditorPanel, emptyCardDraft, type CardDraft } from './CardEditorPanel'
import { useCardList, useCreateCard, useDuplicateCard, useRemoveCard, useUpdateCard } from './use-cards'

const { Text } = Typography

/**
 * 书籍范围下拉的取值。
 *
 * 「全部书籍」与「仅通用卡片」都不是某一本书，而 API 那边需要用
 * scope + bookId 两个字段才能把三种情况说清楚。这里在界面层把它们
 * 编码成一个字符串值（`book:3`），于是下拉只需要一个受控值，
 * 不必维护「改了 scope 还得记得同步清空 bookId」这种联动。
 */
const ALL_SCOPE = 'all'
const GLOBAL_SCOPE = 'global'
const BOOK_PREFIX = 'book:'
/** 类别下拉里「不限类别」那一项的取值 */
const ALL_CATEGORY = 'all'

function scopeToValue(scope: CardBookScope, bookId: number | null): string {
  if (scope === 'book' && bookId !== null) return `${BOOK_PREFIX}${bookId}`
  return scope === 'global' ? GLOBAL_SCOPE : ALL_SCOPE
}

export function CardsPage() {
  const toast = useToast()

  const bookList = useBookList({ ...DEFAULT_BOOK_QUERY, pageSize: 200 })
  const books = useMemo(() => bookList.data?.items ?? [], [bookList.data])

  const [scope, setScope] = useState<CardBookScope>('all')
  const [bookId, setBookId] = useState<number | null>(null)
  const [cardType, setCardType] = useState<CardType | null>(null)
  const [settingCategory, setSettingCategory] = useState<SettingCategory | null>(null)
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)

  /** 选中与「新建草稿」互斥：新建时 card 为 null，看 draftSeed */
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [newDraft, setNewDraft] = useState<CardDraft | null>(null)

  /* ------------------------------------------------------------------ *
   * 深链：从全库检索跳过来
   * ------------------------------------------------------------------ */

  const [searchParams] = useSearchParams()

  /**
   * 目标卡片 id（`?cardId=NN`）。
   *
   * 用 QueryString 而不是路由 state 传：这条链接是「一条能直接回到某张卡」
   * 的地址，刷新、前进后退都还在。而 state 一刷新就没了 ——
   * 表现是「明明刚从检索跳过来，刷新一下却停在第一张卡上」。
   */
  const deepLinkCardId = useMemo(() => {
    const parsed = Number(searchParams.get('cardId'))
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  /** 已消费过的深链目标，避免用户之后改筛选时又被它拽回去 */
  const consumedCardRef = useRef<number | null>(null)

  /**
   * 类型深链（`?type=setting`）—— 编辑器右侧竖栏「设定」用的就是它。
   *
   * 为什么「设定」不另开一个页面：它和「角色」是同一种东西的两个视角
   * （一个是人物卡、一个是世界观条目卡），分开就要多一套增删改查、多一套
   * 导出与检索分组，而作者要的只是「从正文里一键看到这本书的设定」。
   * 于是入口指向同一个卡片库，只把类型筛选预先设好。
   */
  const deepLinkType = useMemo<CardType | null>(() => {
    const raw = searchParams.get('type')
    return isCardType(raw) ? raw : null
  }, [searchParams])

  /**
   * 书籍深链（`?book=NN`）—— 与类型一起由竖栏「角色 / 设定」带来。
   * 不带它的话，从某一章的正文里跳过来会看到「全部书籍」的卡片，
   * 作者得自己再挑一遍书才算开始查资料。
   */
  const deepLinkBookId = useMemo(() => {
    const parsed = Number(searchParams.get('book'))
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  /**
   * 类别深链（`?category=时间线`）—— 竖栏「设定」可以指定某一类。
   * 与类型深链配对使用：单独给类别不给类型也能工作（类别条件本身就隐含
   * 「只看设定卡」），但界面上的类别下拉只在选中「设定」时才出现，
   * 所以两者通常一起传，免得用户看到一个莫名生效却看不见的筛选。
   */
  const deepLinkCategory = useMemo<SettingCategory | null>(() => {
    const raw = searchParams.get('category')
    return isSettingCategory(raw) ? raw : null
  }, [searchParams])

  const consumedTypeRef = useRef<CardType | null>(null)

  useEffect(() => {
    if (deepLinkType === null || consumedTypeRef.current === deepLinkType) return
    consumedTypeRef.current = deepLinkType
    setCardType(deepLinkType)
    if (deepLinkBookId !== null) {
      setScope('book')
      setBookId(deepLinkBookId)
    }
    setPage(1)
  }, [deepLinkBookId, deepLinkType])

  const consumedCategoryRef = useRef<SettingCategory | null>(null)

  useEffect(() => {
    if (deepLinkCategory === null || consumedCategoryRef.current === deepLinkCategory) return
    consumedCategoryRef.current = deepLinkCategory
    setSettingCategory(deepLinkCategory)
    // 类别只在设定卡上存在，顺手把类型定下来，否则下拉不在、筛选却生效
    setCardType('setting')
    setPage(1)
  }, [deepLinkCategory])

  useEffect(() => {
    if (deepLinkCardId === null || consumedCardRef.current === deepLinkCardId) return
    consumedCardRef.current = deepLinkCardId

    /*
     * 必须先把筛选恢复到默认，再选中目标卡片。
     *
     * 目标卡片很可能不在当前筛选范围里 —— 用户上次可能停在「仅通用卡片」，
     * 而这张卡属于某本书；或者关键字筛选还留着。不重置的话，列表里根本没有
     * 这一条，右侧面板会是一片空白，看起来像「跳过来但没打开」。
     * 重置筛选还把分页归到第一页，保证目标一定落在当前页里。
     */
    setScope('all')
    setBookId(null)
    setCardType(null)
    setSettingCategory(null)
    setKeyword('')
    setPage(1)
    setNewDraft(null)
    setSelectedId(deepLinkCardId)
  }, [deepLinkCardId])

  /**
   * 选中的那本书被删掉之后回落到「全部书籍」。
   * 不做这一步的话，下拉会一直停在一个不存在的书上，列表永远空的，
   * 而用户看不出是「书没了」还是「这本书没卡片」。
   */
  useEffect(() => {
    if (scope !== 'book' || bookId === null) return
    if (books.length === 0 || books.some((book) => book.id === bookId)) return
    setScope('all')
    setBookId(null)
  }, [books, scope, bookId])

  const query = useMemo<CardListQuery>(
    () => ({
      ...DEFAULT_CARD_QUERY,
      bookScope: scope,
      bookId: scope === 'book' ? bookId : null,
      cardType,
      settingCategory,
      keyword,
      page
    }),
    [scope, bookId, cardType, settingCategory, keyword, page]
  )

  const list = useCardList(query)
  const createCard = useCreateCard()
  const updateCard = useUpdateCard()
  const removeCard = useRemoveCard()
  const duplicateCard = useDuplicateCard()

  const items = useMemo(() => list.data?.items ?? [], [list.data])

  /**
   * 默认选中第一张卡。
   *
   * 空白编辑器面板等于让用户先猜「这里要点一下才能编辑」，而卡片库的
   * 主要动作就是看某张卡 —— 进来就有内容可看，比空面板好得多。
   * 只在「没有选中任何东西」时做，因此不会抢走用户的选择。
   */
  useEffect(() => {
    if (selectedId !== null || newDraft !== null) return
    const first = items[0]
    if (first) setSelectedId(first.id)
  }, [items, selectedId, newDraft])

  const selectedCard = useMemo(
    () => (selectedId === null ? null : (items.find((card) => card.id === selectedId) ?? null)),
    [items, selectedId]
  )

  /**
   * 新建卡片的归属：跟随当前的筛选范围。
   * 看着某本书的新建，就落在那本书里；看着「仅通用」的新建，就是通用卡片。
   * 这比写死一个默认值更符合「我在看什么就是在给什么建东西」的直觉。
   */
  const defaultBookId = useMemo(() => {
    if (scope === 'global') return null
    if (scope === 'book') return bookId
    return books[0]?.id ?? null
  }, [scope, bookId, books])

  const bookOptions = useMemo(
    () => books.map((book) => ({ value: book.id, label: book.title })),
    [books]
  )

  /** 卡片 id → 书名。列表行上要显示归属，只有「全部书籍」时才有信息量 */
  const bookTitles = useMemo(() => {
    const map = new Map<number, string>()
    for (const book of books) map.set(book.id, book.title)
    return map
  }, [books])

  const handleScopeChange = (value: string): void => {
    if (value.startsWith(BOOK_PREFIX)) {
      setScope('book')
      setBookId(Number(value.slice(BOOK_PREFIX.length)))
    } else {
      setScope(isCardBookScope(value) ? value : 'all')
      setBookId(null)
    }
    setPage(1)
  }

  /**
   * 切换类型。
   *
   * 顺手清掉类别筛选：类别只在设定卡上存在，从「设定 / 时间线」切到「人物」
   * 时若留着类别条件，列表会一片空白，而界面上根本没有类别下拉可看 ——
   * 用户只会以为「这本书没有人物卡」。看不见的筛选都是这种下场。
   */
  const handleTypeChange = (value: string): void => {
    setCardType(value === ALL_SCOPE ? null : (value as CardType))
    setSettingCategory(null)
    setPage(1)
  }

  const handleStartNew = (): void => {
    /*
     * 新建的类型跟随当前类型筛选，否则新建出来的卡片会被自己的筛选条件挡住
     * ——「保存成功了，列表里却没有」看起来像保存失败。
     * 类别同理：正看着「时间线」这一类，新建的设定卡就该预填时间线。
     */
    const type = cardType ?? 'character'
    const draft = emptyCardDraft(type, defaultBookId)
    setSelectedId(null)
    setNewDraft(
      type === 'setting' && settingCategory !== null
        ? { ...draft, extra: { ...draft.extra, category: settingCategory } }
        : draft
    )
  }

  const handleCreate = async (draft: CardDraft): Promise<void> => {
    const created = await createCard.mutateAsync({
      bookId: draft.bookId,
      cardType: draft.cardType,
      title: draft.title.trim(),
      subtitle: draft.subtitle.trim(),
      content: draft.content.trim(),
      tags: draft.tags,
      extra: draft.extra
    })
    setNewDraft(null)
    setSelectedId(created.id)
  }

  /* 面板里的操作把异常往外抛，由面板统一提示 —— 这样「已保存」
     不会在失败时误报。只有页面自己的按钮在这里就地兜住异常。 */

  const handleSave = async (card: Card, draft: CardDraft): Promise<void> => {
    const updated = await updateCard.mutateAsync({
      id: card.id,
      bookId: draft.bookId,
      cardType: draft.cardType,
      title: draft.title.trim(),
      subtitle: draft.subtitle.trim(),
      content: draft.content.trim(),
      tags: draft.tags,
      extra: draft.extra
    })

    /*
     * 改了类型、又正好按类型筛选着，卡片会从列表里消失。
     * 那种「刚保存完卡片就不见了」看起来像是把数据弄丢了，
     * 所以这里主动把类型筛选放开，并说明原因。
     */
    if (cardType !== null && updated.cardType !== cardType) {
      setCardType(null)
      toast.notifySuccess(`类型已改为「${CARD_TYPE_LABELS[updated.cardType]}」，筛选已切回全部类型`)
    } else if (settingCategory !== null && updated.extra.category !== settingCategory) {
      // 类别改了也一样：卡片会从「时间线」这一组里消失，看着像保存把它丢了
      setSettingCategory(null)
      toast.notifySuccess('类别已改，类别筛选已切回全部')
    }
  }

  const handleDelete = async (card: Card): Promise<void> => {
    await removeCard.mutateAsync({ id: card.id })
    if (selectedId === card.id) setSelectedId(null)
  }

  const handleDuplicate = async (card: Card): Promise<void> => {
    const copy = await duplicateCard.mutateAsync({ id: card.id })
    setSelectedId(copy.id)
  }

  const total = list.data?.total ?? 0
  const pageCount = list.data?.pageCount ?? 0

  /*
   * 新建入口从「标题栏右侧的大主按钮」改成「搜索框左侧的图标按钮 + 悬浮提示」，
   * 与书籍管理页保持一致：它和筛选、搜索属于同一层操作。
   * 没有书时按钮禁用 —— 卡片必须归属到某本书或「通用」，此时提示改为说明原因，
   * 而不是留一个点不动、也不说为什么的灰按钮。
   * shape="circle"：与书籍管理页一致，做正圆而不是圆角矩形。
   */
  const addCardButton = (
    <IconButton
      label={books.length === 0 ? '先创建一本书，才能往里添加卡片' : '新建卡片'}
      icon={<PlusOutlined />}
      tone="primary"
      tipTestId="cards-add-tip"
      data-testid="cards-add"
      disabled={books.length === 0}
      onClick={handleStartNew}
    />
  )

  const header = <PageHeader title="卡片库" />

  if (bookList.isLoading) {
    return (
      <Flex vertical gap={16} className="cards-page" data-testid="cards-page">
        {header}
        <Skeleton active paragraph={{ rows: 8 }} />
      </Flex>
    )
  }

  return (
    <Flex vertical gap={16} className="cards-page" data-testid="cards-page">
      {header}

      {list.isError ? <ErrorAlert error={list.error} onRetry={() => void list.refetch()} /> : null}

      <Flex gap={10} wrap align="center" className="cards-toolbar">
        {/*
         * 新建按钮固定在工具栏最左端（用户指定的位置，勿动）。
         * 卡片库有两个筛选器排在搜索框前面，所以它不会紧贴搜索框 ——
         * 冒烟断言只要求「落在工具栏内且在搜索框左侧」，不强制间距。
         */}
        {addCardButton}

        <Select
          data-testid="cards-scope-select"
          className="cards-scope-select"
          value={scopeToValue(scope, bookId)}
          loading={bookList.isLoading}
          onChange={handleScopeChange}
          options={[
            { value: ALL_SCOPE, label: '全部书籍' },
            { value: GLOBAL_SCOPE, label: '仅通用卡片' },
            ...books.map((book) => ({ value: `${BOOK_PREFIX}${book.id}`, label: book.title }))
          ]}
        />

        <Select
          data-testid="cards-type-select"
          className="cards-type-select"
          value={cardType ?? ALL_SCOPE}
          onChange={handleTypeChange}
          options={[
            { value: ALL_SCOPE, label: '全部类型' },
            ...CARD_TYPES.map((type) => ({ value: type, label: CARD_TYPE_LABELS[type] }))
          ]}
        />

        {/*
         * 类别下拉只在选中「设定」时出现。
         *
         * 类别是设定卡的专属字段，挂在别处没有意义；更重要的是不能让
         * 「人物 + 时间线」这种组合可以被选出来 —— 它必然是空列表，
         * 而空列表看起来跟「这本书还没有设定」一模一样。
         */}
        {cardType === 'setting' ? (
          <Select
            data-testid="cards-category-select"
            className="cards-category-select"
            value={settingCategory ?? ALL_CATEGORY}
            onChange={(value: string) => {
              setSettingCategory(isSettingCategory(value) ? value : null)
              setPage(1)
            }}
            options={[
              { value: ALL_CATEGORY, label: '全部类别' },
              ...SETTING_CATEGORIES.map((category) => ({ value: category, label: category }))
            ]}
          />
        ) : null}

        <Input
          data-testid="cards-keyword"
          className="cards-keyword"
          value={keyword}
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜标题、简介、正文、标签"
          maxLength={CARD_LIMITS.title}
          onChange={(event) => {
            setKeyword(event.target.value)
            setPage(1)
          }}
        />

        <span className="cards-summary" data-testid="cards-summary">
          <span>
            共{' '}
            <strong data-testid="cards-total" data-value={total}>
              {total}
            </strong>{' '}
            张
          </span>
          {CARD_TYPES.map((type) => (
            <span key={type}>
              {CARD_TYPE_LABELS[type]}{' '}
              <strong
                data-testid={`cards-type-count-${type}`}
                data-value={list.data?.typeCounts[type] ?? 0}
              >
                {list.data?.typeCounts[type] ?? 0}
              </strong>
            </span>
          ))}
          {cardType === 'setting' && list.data !== undefined
            ? SETTING_CATEGORIES.map((category) => (
                <span key={category}>
                  {category}{' '}
                  <strong
                    data-testid={`cards-category-count-${category}`}
                    data-value={list.data?.settingCounts[category] ?? 0}
                  >
                    {list.data?.settingCounts[category] ?? 0}
                  </strong>
                </span>
              ))
            : null}
          {list.data === undefined || list.data.globalCount === 0 ? null : (
            <span>
              其中通用{' '}
              <strong data-testid="cards-global" data-value={list.data.globalCount}>
                {list.data.globalCount}
              </strong>{' '}
              张
            </span>
          )}
        </span>
      </Flex>

      <div className="cards-layout">
        <div className="cards-list-pane">
          {list.isLoading ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical gap={6} align="center">
                  <Text>
                    {keyword.length > 0 ? '没有匹配的卡片' : '这里还没有卡片'}
                  </Text>
                  <Text type="secondary">
                    {keyword.length > 0
                      ? '换个关键词，或把筛选范围放宽一些。'
                      : '人物、物品、灵感、设定都可以先记成卡片，写的时候好查。'}
                  </Text>
                </Flex>
              }
            >
              <IconButton
                label={keyword.length > 0 ? '新建卡片' : '新建第一张卡片'}
                icon={<PlusOutlined />}
                tone="primary"
                large
                onClick={handleStartNew}
              />
            </Empty>
          ) : (
            <div className="cards-list" data-testid="cards-list">
              {items.map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  selected={card.id === selectedId}
                  bookTitle={card.bookId === null ? null : (bookTitles.get(card.bookId) ?? null)}
                  onSelect={() => {
                    setNewDraft(null)
                    setSelectedId(card.id)
                  }}
                />
              ))}
            </div>
          )}

          {pageCount > 1 ? (
            <Flex justify="center" className="cards-pager">
              <Pagination
                size="small"
                current={list.data?.page ?? 1}
                pageSize={list.data?.pageSize ?? DEFAULT_CARD_QUERY.pageSize}
                total={total}
                showSizeChanger={false}
                onChange={setPage}
              />
            </Flex>
          ) : null}
        </div>

        <div className="cards-panel-pane">
          <CardEditorPanel
            card={selectedCard}
            draftSeed={newDraft}
            bookOptions={bookOptions}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onSave={handleSave}
            onCreate={handleCreate}
          />
        </div>
      </div>
    </Flex>
  )
}

interface CardRowProps {
  card: Card
  selected: boolean
  /** null 表示这张卡是通用的（不归属任何书） */
  bookTitle: string | null
  onSelect: () => void
}

/** 列表里的一行。用 button 而不是 div：键盘可以直接上下走，回车即选中 */
function CardRow({ card, selected, bookTitle, onSelect }: CardRowProps) {
  // 类型专属字段里有内容的部分，作为一行里的补充信息。
  // 不显示空字段：几个「—」只会把列表撑高，没有任何信息量
  const extraSummary = [
    card.subtitle,
    ...Object.values(card.extra).filter((value) => value.length > 0)
  ]
    .filter((value) => value.length > 0)
    .join(' · ')

  return (
    <button
      type="button"
      className={selected ? 'card-row card-row--selected' : 'card-row'}
      data-testid="card-row"
      data-card-id={card.id}
      data-card-type={card.cardType}
      /*
       * 类别也挂到行上：列表里它只是一行补充文字里的一段，
       * 而「按类别筛选到底筛对了没有」只有逐行读回来才知道 ——
       * 界面上的总数对、行数对，行却可能是别的类别。
       */
      data-card-category={card.cardType === 'setting' ? (card.extra.category ?? '') : ''}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
    >
      <Flex justify="space-between" align="center" gap={8}>
        <span className="card-row__title">{card.title}</span>
        <Tag color={CARD_TYPE_COLORS[card.cardType]} className="card-row__type">
          {CARD_TYPE_LABELS[card.cardType]}
        </Tag>
      </Flex>

      {extraSummary.length > 0 ? (
        <span className="card-row__subtitle">{extraSummary}</span>
      ) : null}

      <Flex gap={6} align="center" wrap className="card-row__meta">
        {card.tags.map((tag) => (
          <Tag key={tag} className="card-row__tag">
            {tag}
          </Tag>
        ))}
        <Tooltip title={bookTitle === null ? '不归属任何书' : `归属《${bookTitle}》`}>
          <span className="card-row__book">
            {bookTitle === null ? '通用' : bookTitle}
          </span>
        </Tooltip>
      </Flex>
    </button>
  )
}
