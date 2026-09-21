import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Flex, Select, Tabs, Tooltip, Typography } from 'antd'
import {
  AimOutlined,
  AppstoreOutlined,
  ArrowLeftOutlined,
  AuditOutlined,
  ClearOutlined,
  CompassOutlined,
  ExportOutlined,
  PartitionOutlined,
  SelectOutlined,
  TeamOutlined
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router'
import { PLATFORM_SPECS, platformOf } from './platform-preview'
import { PlatformPreview } from './PlatformPreview'
import { FillerPanel, ProofreadPanel } from './ProofreadPanel'
import { CardLookupPanel, OutlineLookupPanel } from './InspectorLookups'
import { IconButton } from '../../components/IconButton'
import { withOrigin } from '../../components/OriginReturn'
import { ChapterCardRefs } from '../cards/ChapterCardRefs'
import { useChapterCards } from '../cards/use-card-links'
import type { ProofreadState } from './use-proofread'

const { Text } = Typography

/**
 * 右侧展示栏的视图。
 *
 * 后三个（大纲 / 角色 / 设定）是**查阅视图**：它们把本书的资料列在右侧，
 * 点一条弹窗看全文，而不跳走 —— 见 InspectorLookups 的说明。
 * 与前面几个写作工具（纠错 / 废字 / 预览 / 本章设定）不是一类东西，
 * 所以切换到它们时整个 Tabs 会被替换掉，而不是多出几个页签把窄栏挤爆。
 */
export type InspectorView =
  | 'proofread'
  | 'filler'
  | 'preview'
  | 'refs'
  | 'outline'
  | 'characters'
  | 'setups'

const LOOKUP_TITLES: Partial<Record<InspectorView, string>> = {
  outline: '本书大纲',
  characters: '角色卡片',
  setups: '设定卡片'
}

interface RailItem {
  key: string
  label: string
  icon: ReactNode
  hint: string
  /** 未开放的功能置灰，而不是隐藏：让人知道路线图，也便于核对信息架构 */
  disabled?: boolean
  active?: boolean
  badge?: string
  onClick: () => void
}

interface EditorInspectorProps {
  /** 当前这本书。竖栏「角色 / 设定」跳卡片库时带上它，只让作者看这一本 */
  bookId: number
  /**
   * 当前这一章。「设定」页签要列的是**本章**用到的卡片。
   * null 表示这本书还没有任何章节（空书直落编辑器时的状态）。
   */
  chapterId: number | null
  bookTitle: string
  text: string
  charCount: number
  proofread: ProofreadState
  platformKey: string
  onPlatformChange: (key: string) => void
  /** 跳到正文的某一段纯文本区间 */
  onJump: (start: number, end: number) => void
  /** 读当前光标在第几段。由页面从编辑器选区换算 */
  resolveCursorParagraph: () => number | null
  /** 把正文光标移到第 N 段 */
  onRevealParagraph: (index: number) => void
}

/**
 * 右侧检查区：纠错 / 废字 / 平台预览，外加一条竖排功能栏。
 *
 * 为什么做成「一个面板 + 三个页签 + 一条竖栏」而不是三个并排面板：
 * 这三件事永远不会同时需要 —— 你在改标点的时候不看手机预览，看预览的
 * 时候不需要废字统计。并排会各占掉三分之一宽度，结果是每件事都挤得没法用。
 * 竖栏承担两个职责：「快速切换视图」和「通往其它写作模块」。
 */
export function EditorInspector({
  bookId,
  chapterId,
  bookTitle,
  text,
  charCount,
  proofread,
  platformKey,
  onPlatformChange,
  onJump,
  resolveCursorParagraph,
  onRevealParagraph
}: EditorInspectorProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [view, setView] = useState<InspectorView>('proofread')
  const [previewFocus, setPreviewFocus] = useState<number | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)

  const spec = useMemo(() => platformOf(platformKey), [platformKey])

  const errorCount = proofread.result?.errorCount ?? 0
  const suggestionCount = proofread.result?.suggestionCount ?? 0
  const fillerTotal = useMemo(
    () => (proofread.result?.fillers ?? []).reduce((sum, item) => sum + item.count, 0),
    [proofread.result]
  )

  /*
   * 本章关联的卡片数，只为了给「设定」页签挂一个数字。
   * 与页签内部那个组件用的是同一个 queryKey（因此是同一份缓存，
   * 不会多打一次 IPC），这里读到的数字与点开后看到的必然一致。
   */
  const chapterCards = useChapterCards(chapterId)
  const refCount = chapterCards.data?.length ?? 0

  /**
   * 把预览滚到某一段。
   *
   * 用原生 scrollIntoView 而不是自己算 scrollTop：段落高度由字号与行距
   * 决定，是内容相关的，自己算就得把排版规则再实现一遍。
   */
  const scrollPreviewTo = useCallback((index: number): void => {
    const container = previewRef.current
    if (!container) return
    const target = container.querySelector<HTMLElement>(`[data-paragraph-index="${index}"]`)
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const locatePreviewFromCursor = useCallback((): void => {
    const index = resolveCursorParagraph()
    if (index === null) return
    setView('preview')
    setPreviewFocus(index)
    // 切页签与滚动放在同一帧会落空：此时 DOM 还停留在旧页签上。
    // 推到下一个宏任务里，等 React 把新页签提交完再滚
    window.setTimeout(() => scrollPreviewTo(index), 0)
  }, [resolveCursorParagraph, scrollPreviewTo])

  const locateCursorFromPreview = useCallback((): void => {
    if (previewFocus === null) return
    onRevealParagraph(previewFocus)
  }, [onRevealParagraph, previewFocus])

  /**
   * 查阅面板头部的「打开完整页面」。
   *
   * 查阅视图解决的是「写到一半查一下」，但**批量整理**卡片或大纲时
   * 完整页面才够用 —— 所以入口保留，只是从「点竖栏就跳」降级成
   * 「明确点这一枚才跳」。
   *
   * 带上 `type` 与 `book` 而不是跳到模块首页：从正文里过去的目的是
   * 「查我正在写的这一本书的某类资料」，落到「全部书籍的全部卡片」
   * 等于让人再筛一次。带 `?from=` 则是为了右下角那枚回程票。
   */
  const openFullPage = useCallback((): void => {
    const target =
      view === 'outline'
        ? `/outline?bookId=${bookId}`
        : `/cards?type=${view === 'characters' ? 'character' : 'setting'}&book=${bookId}`
    void navigate(withOrigin(target, location.pathname))
  }, [bookId, location.pathname, navigate, view])

  const rail: RailItem[] = [
    {
      key: 'proofread',
      label: '校对',
      icon: <AuditOutlined />,
      active: view === 'proofread',
      badge: errorCount > 0 ? String(errorCount) : undefined,
      hint: `标点、引号配对、中英标点混用${errorCount > 0 ? `（${errorCount} 处需要修改）` : ''}`,
      onClick: () => setView('proofread')
    },
    {
      key: 'filler',
      label: '废字',
      icon: <ClearOutlined />,
      active: view === 'filler',
      badge: fillerTotal > 0 ? String(fillerTotal) : undefined,
      hint: '统计冗余修饰、套话与口头禅的密度',
      onClick: () => setView('filler')
    },
    {
      key: 'preview',
      label: '预览',
      icon: <AppstoreOutlined />,
      active: view === 'preview',
      hint: '按各平台版式看手机上的阅读效果',
      onClick: () => setView('preview')
    },
    {
      /*
       * 2026-09-21 改：这三项原来是「跳去对应模块页」，现在改成在右侧
       * 展示栏就地列出、点开弹窗看详情。
       *
       * 跳走的代价是每次查资料都要离开正文、回来再找光标；而这件事
       * 在写作中是高频动作。完整页面仍然可达 —— 查阅面板头部有一枚
       * 「打开完整页面」的圆钮，批量整理时用得上。
       */
      key: 'outline',
      label: '大纲',
      icon: <PartitionOutlined />,
      active: view === 'outline',
      hint: '在右侧列出本书的情节节点，点一条看摘要',
      onClick: () => setView('outline')
    },
    {
      key: 'characters',
      label: '角色',
      icon: <TeamOutlined />,
      active: view === 'characters',
      hint: '在右侧列出本书的人物卡，点一张看全文',
      onClick: () => setView('characters')
    },
    {
      /*
       * 「设定」这一格从置灰的「第二期」转为可用（2026-09-20 实现的第二期）。
       * 它记的是世界观条目 —— 地点 / 势力 / 规则体系 / 时间线，与「角色」
       * 共用同一套卡片，只是类别不同（见共享层 SETTING_CATEGORIES 的注释）。
       */
      key: 'setups',
      label: '设定',
      icon: <CompassOutlined />,
      active: view === 'setups',
      hint: '在右侧列出地点 / 势力 / 规则体系 / 时间线设定卡，点一张看全文',
      onClick: () => setView('setups')
    }
  ]

  return (
    <div className="inspector" data-testid="editor-inspector">
      <div className="inspector__panel">
        {/*
         * 查阅视图把整组 Tabs 换掉，而不是「再加三个页签」：
         * 右栏很窄，七个页签会挤成两行；而且「设定」会出现两次
         * （本章用到的 vs 全书设定卡），两个不同东西共用一个名字
         * 比多一行页签更难懂。
         */}
        {LOOKUP_TITLES[view] === undefined ? null : (
          <div className="inspector__lookup" data-testid="inspector-lookup">
            <Flex align="center" gap={6} className="inspector__lookup-head">
              <IconButton
                label="返回写作工具"
                icon={<ArrowLeftOutlined />}
                data-testid="inspector-lookup-back"
                onClick={() => setView('proofread')}
              />
              <Text strong className="inspector__lookup-title">
                {LOOKUP_TITLES[view]}
              </Text>
              <IconButton
                label="打开完整页面"
                icon={<ExportOutlined />}
                data-testid="inspector-open-page"
                onClick={openFullPage}
              />
            </Flex>

            {view === 'outline' ? (
              <OutlineLookupPanel bookId={bookId} />
            ) : (
              <CardLookupPanel
                bookId={bookId}
                cardType={view === 'characters' ? 'character' : 'setting'}
              />
            )}
          </div>
        )}

        <Tabs
          size="small"
          activeKey={view}
          onChange={(key) => setView(key as InspectorView)}
          className={LOOKUP_TITLES[view] === undefined ? undefined : 'inspector__tabs--hidden'}
          items={[
            {
              key: 'proofread',
              label: `纠错${suggestionCount + errorCount > 0 ? ` ${suggestionCount + errorCount}` : ''}`,
              children: (
                <ProofreadPanel
                  result={proofread.result}
                  pending={proofread.pending}
                  text={text}
                  onJump={onJump}
                />
              )
            },
            {
              key: 'filler',
              label: `废字${fillerTotal > 0 ? ` ${fillerTotal}` : ''}`,
              children: (
                <FillerPanel
                  result={proofread.result}
                  pending={proofread.pending}
                  onJump={onJump}
                />
              )
            },
            {
              key: 'preview',
              label: '预览',
              children: (
                <div className="inspector__body">
                  <Flex vertical gap={8}>
                    <Select
                      size="small"
                      value={platformKey}
                      options={PLATFORM_SPECS.map((item) => ({
                        value: item.key,
                        label: item.label
                      }))}
                      onChange={onPlatformChange}
                    />

                    <div ref={previewRef} className="preview__scroller">
                      <PlatformPreview
                        spec={spec}
                        bookTitle={bookTitle}
                        text={text}
                        charCount={charCount}
                        focusParagraph={previewFocus}
                        onSelectParagraph={setPreviewFocus}
                      />
                    </div>

                    <Flex gap={6} align="center">
                      <IconButton
                        label="定位右侧预览"
                        icon={<AimOutlined />}
                        onClick={locatePreviewFromCursor}
                      />
                      <IconButton
                        label="定位左侧正文"
                        icon={<SelectOutlined />}
                        disabled={previewFocus === null}
                        onClick={locateCursorFromPreview}
                      />
                    </Flex>

                    <Text type="secondary" className="inspector__hint">
                      {previewFocus === null
                        ? '点预览里的任意段落可以选中它，再用「定位左侧正文」跳回正文。'
                        : `已选中第 ${previewFocus + 1} 段`}
                    </Text>
                  </Flex>
                </div>
              )
            },
            {
              /*
               * 「设定」页签：这一章用到了哪几条设定 / 人物 / 道具。
               *
               * 它是卡片 ↔ 章节关联的**反方向**。卡片侧看的是「这条设定
               * 用在哪几章」，这一侧看的是「这一章答应读者要用上的东西
               * 到底用上了没有」—— 同一份数据的两个视角。
               */
              key: 'refs',
              label: `设定${refCount > 0 ? ` ${refCount}` : ''}`,
              children:
                chapterId === null ? (
                  <Text type="secondary" className="inspector__hint">
                    这本书还没有章节，先建一章再回来看这一章用到了哪些设定。
                  </Text>
                ) : (
                  <ChapterCardRefs chapterId={chapterId} bookId={bookId} />
                )
            }
          ]}
        />
      </div>

      <nav className="rail" aria-label="写作工具">
        {rail.map((item) => (
          <Tooltip key={item.key} title={item.hint} placement="left">
            <button
              type="button"
              className={`rail__item${item.active ? ' rail__item--active' : ''}`}
              disabled={item.disabled}
              data-testid={`rail-${item.key}`}
              onClick={item.onClick}
            >
              <span className="rail__icon">{item.icon}</span>
              <span className="rail__label">{item.label}</span>
              {item.badge ? <span className="rail__badge">{item.badge}</span> : null}
            </button>
          </Tooltip>
        ))}
      </nav>
    </div>
  )
}
