import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Flex, Select, Tabs, Tooltip, Typography } from 'antd'
import {
  AimOutlined,
  AppstoreOutlined,
  AuditOutlined,
  ClearOutlined,
  PartitionOutlined,
  SelectOutlined,
  ThunderboltOutlined,
  TeamOutlined
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router'
import { PLATFORM_SPECS, platformOf } from './platform-preview'
import { PlatformPreview } from './PlatformPreview'
import { FillerPanel, ProofreadPanel } from './ProofreadPanel'
import { IconButton } from '../../components/IconButton'
import { withOrigin } from '../../components/OriginReturn'
import type { ProofreadState } from './use-proofread'

const { Text } = Typography

export type InspectorView = 'proofread' | 'filler' | 'preview'

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
      key: 'outline',
      label: '大纲',
      icon: <PartitionOutlined />,
      hint: '卷章树与情节节点（右下角有回到正文的圆钮）',
      onClick: () => void navigate(withOrigin('/outline', location.pathname))
    },
    {
      key: 'characters',
      label: '角色',
      icon: <TeamOutlined />,
      hint: '人物卡与关系设定（右下角有回到正文的圆钮）',
      onClick: () => void navigate(withOrigin('/cards', location.pathname))
    },
    {
      key: 'setups',
      label: '设定',
      icon: <ThunderboltOutlined />,
      disabled: true,
      hint: '物品与世界观设定卡（第二期）',
      onClick: () => undefined
    }
  ]

  return (
    <div className="inspector" data-testid="editor-inspector">
      <div className="inspector__panel">
        <Tabs
          size="small"
          activeKey={view}
          onChange={(key) => setView(key as InspectorView)}
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
