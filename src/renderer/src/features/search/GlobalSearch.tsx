import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Input, Spin, Tag, Typography, type InputRef } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router'
import {
  SEARCH_FIELD_LABELS,
  SEARCH_SOURCE_LABELS,
  type SearchHit,
  type SnippetHighlight
} from '@shared/modules/search'
import { targetOf } from './search-target'
import { useSearch } from './use-search'

const { Text } = Typography

/**
 * 输入防抖。
 *
 * 一次全库检索在主进程里要扫一遍全部正文（1024 万字约 52 毫秒，单本书 5 毫秒），
 * 主进程是**同步**执行这条 SQL 的，每敲一个字都发一次会让主进程持续被占用，
 * 其他 IPC（自动保存、会话结算）只能排队。250 毫秒是「打字时明显不卡」
 * 与「停下来就能看到结果」之间的常见取法。
 */
const DEBOUNCE_MS = 250

/** 面板类型。用状态机而不是一堆布尔量，避免出现「既在加载又是空」这种矛盾组合 */
type PanelState = 'hint' | 'loading' | 'error' | 'empty' | 'ready'

/**
 * 顶栏全库检索。
 *
 * 为什么是浮层而不是独立页面：检索的使用场景是「写着写着想起某个设定，
 * 立刻找一下再回来」。独立页面意味着离开当前编辑器再回来，
 * 而回来的路上光标、展开的分卷、滚动位置全都要重新建立。
 * 浮层盖在当前页面上，关掉它就等于什么都没发生过。
 */
export function GlobalSearch() {
  const navigate = useNavigate()
  const inputRef = useRef<InputRef>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [debounced, setDebounced] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(raw), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [raw])

  // bookId 传 null（全库）。刻意不做「自动限定在当前这本书」：
  // 那种优化会让「明明书里有、却搜不到」变成一个需要用户自己去猜的谜题，
  // 而每条结果都标了所属书籍，全库搜的代价只是列表长一点。
  const search = useSearch(debounced, null, open)

  /** 扁平化的命中列表，供键盘上下键在分组之间连续移动 */
  const flatHits = useMemo<SearchHit[]>(
    () => search.data.groups.flatMap((group) => group.hits),
    [search.data]
  )

  // 结果集变化后游标必须归零：否则新结果里会指向一个不存在的位置
  useEffect(() => {
    setActiveIndex(0)
  }, [debounced])

  const close = useCallback((): void => {
    setOpen(false)
    inputRef.current?.blur()
  }, [])

  /** 唤起：无论当前在哪个页面、焦点在哪，Ctrl+K 都应该能直接开搜 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** 点击面板与输入框之外收起。用 mousedown 而不是 click：
   *  点击外部元素时，click 要在目标元素上完成一次完整按下-抬起才触发，
   *  而拖动选中文字再松开会被判成「点在外面」。 */
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (boxRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const reveal = useCallback(
    (hit: SearchHit | undefined): void => {
      if (!hit) return
      const target = targetOf(hit)
      if (!target) return
      close()
      void navigate(target.path)
    },
    [close, navigate]
  )

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (flatHits.length === 0) return
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((current) => (current + delta + flatHits.length) % flatHits.length)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        reveal(flatHits[activeIndex])
      }
    },
    [activeIndex, close, flatHits, reveal]
  )

  const state: PanelState = !open
    ? 'hint'
    : search.error !== null
      ? 'error'
      : search.keywords.length === 0
        ? 'hint'
        : search.loading
          ? 'loading'
          : search.data.total === 0
            ? 'empty'
            : 'ready'

  /*
   * 键盘游标要在分组之间连续编号，所以一边渲染一边累加。
   * 用可变游标 + map 是这里最直白的写法：分组与扁平列表的下标必须错位对应，
   * 分成两处各算一次编号，迟早会出现「上下键跳到的和点开的不是同一条」。
   */
  let cursor = -1

  return (
    <div className="global-search" ref={boxRef} data-testid="global-search">
      <Input
        ref={inputRef}
        allowClear
        className="global-search__input"
        placeholder="搜索正文、卡片、大纲（Ctrl + K）"
        prefix={<SearchOutlined className="global-search__icon" />}
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        onFocus={() => {
          setOpen(true)
          setDebounced(raw)
        }}
        onKeyDown={onInputKeyDown}
        data-testid="search-input"
      />

      {open ? (
        <div
          className="search-panel"
          data-testid="search-panel"
          data-state={state}
          data-keywords={search.keywords.join('|')}
          data-total={search.data.total}
        >
          {state === 'hint' ? (
            <div className="search-panel__hint">
              空格分隔多个关键词，需要 <strong>同时</strong> 包含才会命中。例如「林澈 星云」
            </div>
          ) : null}

          {state === 'loading' ? (
            <div className="search-panel__hint">
              <Spin size="small" /> 正在检索…
            </div>
          ) : null}

          {state === 'error' ? (
            <div className="search-panel__hint search-panel__hint--error">
              检索失败：{search.error?.message}
            </div>
          ) : null}

          {state === 'empty' ? (
            <div className="search-panel__hint" data-testid="search-empty">
              没有找到同时包含
              {search.keywords.map((keyword) => (
                <Tag key={keyword} className="search-panel__chip">
                  {keyword}
                </Tag>
              ))}
              的内容
            </div>
          ) : null}

          {state === 'ready' ? (
            <>
              <div className="search-panel__head">
                <Text type="secondary" className="search-panel__summary">
                  共 {search.data.total} 处
                </Text>
                <div className="search-panel__chips">
                  {search.keywords.map((keyword) => (
                    <Tag key={keyword} className="search-panel__chip">
                      {keyword}
                    </Tag>
                  ))}
                </div>
              </div>

              <div className="search-panel__body">
                {search.data.groups.map((group) => (
                  <div className="search-group" key={group.source} data-source={group.source}>
                    <div className="search-group__title">
                      <span className="search-group__name">{SEARCH_SOURCE_LABELS[group.source]}</span>
                      <span className="search-group__count">
                        {group.truncated ? `显示前 ${group.hits.length} / 共 ${group.total}` : group.total}
                      </span>
                    </div>

                    {group.hits.map((hit) => {
                      cursor += 1
                      const index = cursor
                      return (
                        <button
                          type="button"
                          key={`${hit.source}-${hit.id}`}
                          className={
                            index === activeIndex ? 'search-hit search-hit--active' : 'search-hit'
                          }
                          data-testid="search-hit"
                          data-hit-source={hit.source}
                          data-hit-id={hit.id}
                          data-hit-active={index === activeIndex ? 'true' : 'false'}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => reveal(hit)}
                        >
                          <span className="search-hit__top">
                            <span className="search-hit__title">{hit.title}</span>
                            <span className="search-hit__where">
                              {hit.bookTitle ?? '通用卡片'}
                              <span className="search-hit__field">
                                {SEARCH_FIELD_LABELS[hit.field]}
                              </span>
                            </span>
                          </span>
                          <span className="search-hit__snippet">
                            <SnippetText text={hit.snippet} highlights={hit.highlights} />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 片段正文 + 关键词高亮。
 *
 * 高亮区间可能**互相重叠**（两个关键词在原文里交叠，比如「天气」与「气很」），
 * 而区间是由不同关键词各自扫出来的，主进程只做了「完整落在窗口内」的过滤。
 * 一旦交叠，按区间顺序切就会把游标切回去、输出重复甚至倒序的文字。
 * 因此这里遇到起点落在游标之前的区间直接跳过 —— 少标一个词，
 * 远好过把正文切得读不通。
 */
function SnippetText({
  text,
  highlights
}: {
  text: string
  highlights: readonly SnippetHighlight[]
}): ReactNode {
  const nodes: ReactNode[] = []
  let at = 0

  for (const highlight of highlights) {
    if (highlight.start < at || highlight.end > text.length) continue
    if (highlight.start > at) nodes.push(text.slice(at, highlight.start))
    nodes.push(
      <mark className="search-hit__mark" key={highlight.start}>
        {text.slice(highlight.start, highlight.end)}
      </mark>
    )
    at = highlight.end
  }

  if (at < text.length) nodes.push(text.slice(at))
  return nodes
}
