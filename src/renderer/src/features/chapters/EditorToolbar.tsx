import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Divider, Flex, Popover, Select, Slider, Switch, Tooltip, Typography } from 'antd'
import {
  AlignLeftOutlined,
  BgColorsOutlined,
  BoldOutlined,
  ClearOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  LeftOutlined,
  OrderedListOutlined,
  PicLeftOutlined,
  PlusOutlined,
  RedoOutlined,
  RightOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import type { Editor } from '@tiptap/react'
import {
  EDITOR_FONT_PRESETS,
  EDITOR_PREF_LIMITS,
  PAPER_PRESETS,
  tidyLayoutPatch,
  type EditorFontKey,
  type EditorPrefs
} from './editor-prefs'
import { tidyDocument } from './doc-tidy'

const { Text } = Typography

/** 正文字号的候选项。区间直接取偏好里的上下限，免得两处各写一份数字 */
const FONT_SIZE_OPTIONS = Array.from(
  { length: EDITOR_PREF_LIMITS.fontSize[1] - EDITOR_PREF_LIMITS.fontSize[0] + 1 },
  (_, index) => {
    const value = EDITOR_PREF_LIMITS.fontSize[0] + index
    return { value, label: `${value}px` }
  }
)

const TIDY_HINT = (
  <span>
    一键格式整理
    <br />
    每段开头空两个字、段落之间空一行；
    <br />
    顺带清掉段落首尾的空白与多余空行
  </span>
)

interface EditorToolbarProps {
  editor: Editor | null
  prefs: EditorPrefs
  onPrefsChange: (patch: Partial<EditorPrefs>) => void
  readOnly: boolean
}

/**
 * 编辑器工具栏。
 *
 * 分组顺序照着「先调看的样子、再改文字、最后是排版细节」来：
 *   字体 / 字号 / 背景 —— 影响整页观感，先调好再动笔
 *   加粗 斜体 下划线 删除线 标题 引用 列表 —— 正文里的实际格式
 *   撤销 / 重做
 *   整理格式 / 排版 / 插入 —— 细节微调
 *
 * 字体与字号不再收进弹层：它们是每次开写都会碰的开关，藏在弹层里
 * 等于没有（用户明确提过找不到）。留在弹层里的是行距、段间距这类调一次就算的。
 *
 * 所有「偏好类」的改动都走 onPrefsChange（只影响本地渲染，不进文档），
 * 所有「格式类」的改动才落到编辑器上（写进 content_html）。
 * 这条界线在界面上的体现是：前者用下拉与滑杆，后者用可高亮的按钮。
 */
export function EditorToolbar({ editor, prefs, onPrefsChange, readOnly }: EditorToolbarProps) {
  const disabled = editor === null || readOnly

  /**
   * 一键格式整理 = 排版补丁（首行缩进两字 + 段间空一行）+ 正文清理。
   *
   * 两件事合成一个按钮，是因为在作者眼里它们就是一件事：「把这一章收拾干净」。
   * 正文清理那半边走事务提交，因此可以被 Ctrl+Z 撤销；
   * 而且整理前后的文档若完全相同就不提交，避免白写一条撤销记录。
   */
  const handleTidy = (): void => {
    onPrefsChange(tidyLayoutPatch(prefs))
    if (!editor || editor.isDestroyed) return
    const next = tidyDocument(editor.state.doc)
    if (next === editor.state.doc) return
    editor.chain().focus().setContent(next.toJSON()).run()
  }

  /**
   * 工具栏横向溢出的状态。
   *
   * 控件多了之后有两条路：折行，或者横向滑动。折行会白白吃掉正文的可视高度
   * （工具栏是浮在正文上方的一整条），而正文的高度才是这一页最值钱的空间，
   * 所以选横向滑动，并在头尾各放一个箭头按钮代劳滚动 —— 横向滚动条本身
   * 既占高度又不显眼，很多人根本不会想到去拖它。
   */
  const stripRef = useRef<HTMLDivElement | null>(null)
  const [bar, setBar] = useState({ overflows: false, atStart: true, atEnd: true })

  const syncBar = useCallback((): void => {
    const strip = stripRef.current
    if (!strip) return
    setBar({
      overflows: strip.scrollWidth - strip.clientWidth > 1,
      atStart: strip.scrollLeft <= 1,
      atEnd: strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1
    })
  }, [])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return

    const sync = (): void => syncBar()

    sync()
    strip.addEventListener('scroll', sync, { passive: true })

    // 尺寸会变的来源不止窗口：字号下拉的文案变长、字体名换成更长的字体，
    // 都会把内容撑宽。所以容器与内容两层都要观察
    const observer = new ResizeObserver(sync)
    observer.observe(strip)
    if (strip.firstElementChild) observer.observe(strip.firstElementChild)

    return () => {
      strip.removeEventListener('scroll', sync)
      observer.disconnect()
    }
  }, [syncBar])

  const scrollStrip = useCallback((direction: -1 | 1): void => {
    const strip = stripRef.current
    if (!strip) return
    // 一次滑过大半屏：滑满一屏会让人失去位置感，滑太少又要点很多次。
    //
    // 用即时滚动而不是 smooth 动画：动画只在窗口被合成器持续渲染时才推进，
    // 后台窗口 / 无 GPU 环境里 scrollLeft 会一直停在 0（断言实测踩到过），
    // 而「点了没反应」比「跳一下」糟糕得多。
    strip.scrollLeft += direction * Math.round(strip.clientWidth * 0.7)
    // 程序化改 scrollLeft 后，滚动事件不保证同一帧派发（无 GPU / 后台窗口里
    // 实测会丢），箭头按钮的禁用态就会慢一拍，看着像「点不动」。主动同步一次。
    syncBar()
  }, [syncBar])

  return (
    <div className="editor-toolbar" data-testid="editor-toolbar">
      {bar.overflows ? (
        <Tooltip title="向左滑动">
          <Button
            size="small"
            type="text"
            className="editor-toolbar__scroll"
            icon={<LeftOutlined />}
            aria-label="工具栏向左滑动"
            data-testid="editor-toolbar-scroll-left"
            disabled={bar.atStart}
            onClick={() => scrollStrip(-1)}
          />
        </Tooltip>
      ) : null}

      <div className="editor-toolbar__strip" data-testid="editor-toolbar-strip" ref={stripRef}>
        <Flex align="center" gap={2} className="editor-toolbar__items">
          {/* ---------------- 字体 / 字号 ---------------- */}
          <Tooltip title="正文字体（只影响你自己的阅读观感，不写进正文）">
            <Select
              size="small"
              className="editor-toolbar__font"
              data-testid="editor-font-select"
              value={prefs.fontKey}
              onChange={(value: EditorFontKey) => onPrefsChange({ fontKey: value })}
              options={EDITOR_FONT_PRESETS.map((preset) => ({ value: preset.key, label: preset.label }))}
            />
          </Tooltip>

          <Tooltip title="正文字号（只影响你自己的阅读观感，不写进正文）">
            <Select
              size="small"
              className="editor-toolbar__font-size"
              data-testid="editor-font-size-select"
              value={prefs.fontSize}
              onChange={(value: number) => onPrefsChange({ fontSize: value })}
              options={FONT_SIZE_OPTIONS}
            />
          </Tooltip>

          {/* ---------------- 背景 ---------------- */}
          {/* 悬浮提示说明它是什么，点击弹出的面板负责真正的内容：两层各管一件事 */}
          <Popover
            trigger="click"
            placement="bottomLeft"
            title="纸面背景"
            content={<PaperPanel prefs={prefs} onPrefsChange={onPrefsChange} />}
          >
            <Tooltip title="纸面背景">
              <Button
                size="small"
                type="text"
                shape="circle"
                icon={<BgColorsOutlined />}
                aria-label="纸面背景"
                data-testid="editor-paper"
                disabled={disabled}
              />
            </Tooltip>
          </Popover>

          <Divider type="vertical" />

          {/* ---------------- 文字格式 ---------------- */}
          <Tooltip title="加粗（Ctrl+B）">
            <Button
              size="small"
              type={editor?.isActive('bold') ? 'primary' : 'text'}
              shape="circle"
              icon={<BoldOutlined />}
              aria-label="加粗（Ctrl+B）"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            />
          </Tooltip>
          <Tooltip title="斜体（Ctrl+I）">
            <Button
              size="small"
              type={editor?.isActive('italic') ? 'primary' : 'text'}
              shape="circle"
              icon={<ItalicOutlined />}
              aria-label="斜体（Ctrl+I）"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            />
          </Tooltip>
          <Tooltip title="下划线（Ctrl+U）">
            <Button
              size="small"
              type={editor?.isActive('underline') ? 'primary' : 'text'}
              shape="circle"
              icon={<UnderlineOutlined />}
              aria-label="下划线（Ctrl+U）"
              data-testid="editor-underline"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
            />
          </Tooltip>
          <Tooltip title="删除线">
            <Button
              size="small"
              type={editor?.isActive('strike') ? 'primary' : 'text'}
              shape="circle"
              icon={<StrikethroughOutlined />}
              aria-label="删除线"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleStrike().run()}
            />
          </Tooltip>

          <Divider type="vertical" />

          <Tooltip title="小标题">
            <Button
              size="small"
              type={editor?.isActive('heading', { level: 3 }) ? 'primary' : 'text'}
              shape="circle"
              icon={<FontSizeOutlined />}
              aria-label="小标题"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
            />
          </Tooltip>
          <Tooltip title="引用段落">
            <Button
              size="small"
              type={editor?.isActive('blockquote') ? 'primary' : 'text'}
              shape="circle"
              icon={<PicLeftOutlined />}
              aria-label="引用段落"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            />
          </Tooltip>
          <Tooltip title="无序列表">
            <Button
              size="small"
              type={editor?.isActive('bulletList') ? 'primary' : 'text'}
              shape="circle"
              icon={<UnorderedListOutlined />}
              aria-label="无序列表"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            />
          </Tooltip>
          <Tooltip title="有序列表">
            <Button
              size="small"
              type={editor?.isActive('orderedList') ? 'primary' : 'text'}
              shape="circle"
              icon={<OrderedListOutlined />}
              aria-label="有序列表"
              disabled={disabled}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            />
          </Tooltip>

          <Divider type="vertical" />

          <Tooltip title="撤销（Ctrl+Z）">
            <Button
              size="small"
              type="text"
              shape="circle"
              icon={<UndoOutlined />}
              aria-label="撤销（Ctrl+Z）"
              disabled={disabled || !editor?.can().undo()}
              onClick={() => editor?.chain().focus().undo().run()}
            />
          </Tooltip>
          <Tooltip title="重做（Ctrl+Shift+Z）">
            <Button
              size="small"
              type="text"
              shape="circle"
              icon={<RedoOutlined />}
              aria-label="重做（Ctrl+Shift+Z）"
              disabled={disabled || !editor?.can().redo()}
              onClick={() => editor?.chain().focus().redo().run()}
            />
          </Tooltip>

          <Divider type="vertical" />

          {/* ---------------- 整理格式 / 排版 ---------------- */}
          <Tooltip title={TIDY_HINT}>
            <Button
              size="small"
              type="text"
              shape="circle"
              icon={<ClearOutlined />}
              aria-label="整理格式"
              data-testid="editor-tidy"
              disabled={disabled}
              onClick={handleTidy}
            />
          </Tooltip>

          <Popover
            trigger="click"
            placement="bottomLeft"
            title="排版"
            content={<LayoutPanel prefs={prefs} onPrefsChange={onPrefsChange} />}
          >
            <Tooltip title="排版">
              <Button
                size="small"
                type="text"
                shape="circle"
                icon={<AlignLeftOutlined />}
                aria-label="排版"
                data-testid="editor-layout"
                disabled={disabled}
              />
            </Tooltip>
          </Popover>

          {/* ---------------- 插入 ---------------- */}
          {/* 不设标题：四个动作一眼可读，「插入」两个字只是占高度的重复。
              样式（无边框、无左右留白）见 styles.css 的 .editor-insert-popover */}
          <Popover
            trigger="click"
            placement="bottomLeft"
            overlayClassName="editor-insert-popover"
            content={<InsertPanel editor={editor} disabled={disabled} />}
          >
            <Tooltip title="插入分隔线与引号">
              <Button
                size="small"
                type="text"
                shape="circle"
                icon={<PlusOutlined />}
                aria-label="插入分隔线与引号"
                data-testid="editor-insert"
                disabled={disabled}
              />
            </Tooltip>
          </Popover>
        </Flex>
      </div>

      {bar.overflows ? (
        <Tooltip title="向右滑动">
          <Button
            size="small"
            type="text"
            shape="circle"
            className="editor-toolbar__scroll"
            icon={<RightOutlined />}
            aria-label="工具栏向右滑动"
            data-testid="editor-toolbar-scroll-right"
            disabled={bar.atEnd}
            onClick={() => scrollStrip(1)}
          />
        </Tooltip>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

function PanelRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="toolbar-panel__row">
      <Flex align="center" justify="space-between" gap={12}>
        <Text className="toolbar-panel__label">{label}</Text>
        {children}
      </Flex>
      {hint ? (
        <Text type="secondary" className="toolbar-panel__hint">
          {hint}
        </Text>
      ) : null}
    </div>
  )
}

/*
 * 原先这里有一个「字体与行距」面板（字体、字号、行距三行）。
 * 字体与字号已经提到工具栏面上；行距并进了「排版」面板 ——
 * 它和段间距、首行缩进属于同一类「调一次就不再碰」的排版参数，
 * 分在两处反而要在两个弹层之间来回找。
 */

function PaperPanel({
  prefs,
  onPrefsChange
}: {
  prefs: EditorPrefs
  onPrefsChange: (patch: Partial<EditorPrefs>) => void
}) {
  return (
    <div className="toolbar-panel" data-testid="toolbar-paper-panel">
      <PanelRow label="纸面">
        <div className="paper-swatches">
          {PAPER_PRESETS.map((preset) => (
            <Tooltip key={preset.key} title={preset.label}>
              <button
                type="button"
                className={`paper-swatch${prefs.paperKey === preset.key ? ' paper-swatch--active' : ''}`}
                style={{ background: preset.background }}
                aria-label={preset.label}
                onClick={() => onPrefsChange({ paperKey: preset.key })}
              />
            </Tooltip>
          ))}
        </div>
      </PanelRow>

      <PanelRow
        label={`纸面浓度 ${Math.round(prefs.paperOpacity * 100)}%`}
        hint="调低可以让背景的氛围透出来，但正文对比度会下降"
      >
        <Slider
          className="toolbar-panel__slider"
          min={EDITOR_PREF_LIMITS.paperOpacity[0]}
          max={EDITOR_PREF_LIMITS.paperOpacity[1]}
          step={0.02}
          value={prefs.paperOpacity}
          onChange={(value) => onPrefsChange({ paperOpacity: value })}
        />
      </PanelRow>

      <Text type="secondary" className="toolbar-panel__note">
        这些设置只影响你自己的阅读观感，不会写进正文，也不会被导出。
      </Text>
    </div>
  )
}

function LayoutPanel({
  prefs,
  onPrefsChange
}: {
  prefs: EditorPrefs
  onPrefsChange: (patch: Partial<EditorPrefs>) => void
}) {
  return (
    <div className="toolbar-panel" data-testid="toolbar-layout-panel">
      <PanelRow
        label={`行距 ${prefs.lineHeight.toFixed(1)}`}
        hint="网文平台正文多为 1.7–1.9，纸书排版约 1.5"
      >
        <Slider
          className="toolbar-panel__slider"
          min={EDITOR_PREF_LIMITS.lineHeight[0]}
          max={EDITOR_PREF_LIMITS.lineHeight[1]}
          step={0.1}
          value={prefs.lineHeight}
          onChange={(value) => onPrefsChange({ lineHeight: value })}
        />
      </PanelRow>

      <PanelRow label={`段间距 ${prefs.paragraphGap}px`} hint="「整理格式」会把它设成一行的高度">
        <Slider
          className="toolbar-panel__slider"
          min={EDITOR_PREF_LIMITS.paragraphGap[0]}
          max={EDITOR_PREF_LIMITS.paragraphGap[1]}
          step={2}
          value={prefs.paragraphGap}
          onChange={(value) => onPrefsChange({ paragraphGap: value })}
        />
      </PanelRow>

      <PanelRow label="首行缩进两字" hint="「整理格式」会把它打开；网文平台多为不缩进，纸书排版为缩进">
        <Switch
          size="small"
          checked={prefs.firstLineIndent}
          onChange={(checked) => onPrefsChange({ firstLineIndent: checked })}
        />
      </PanelRow>

      <PanelRow label="段落虚线分隔" hint="方便看清单行长度，属于辅助线">
        <Switch
          size="small"
          checked={prefs.showParagraphRules}
          onChange={(checked) => onPrefsChange({ showParagraphRules: checked })}
        />
      </PanelRow>
    </div>
  )
}

function InsertPanel({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const wrapSelection = (open: string, close: string): void => {
    if (!editor) return
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, ' ')
    if (selected.length > 0) {
      editor.chain().focus().insertContent(`${open}${selected}${close}`).run()
      return
    }
    // 没有选中内容时插入一对符号并把光标放到中间，省得用户再点一次
    editor.chain().focus().insertContent(`${open}${close}`).run()
    editor.commands.setTextSelection(editor.state.selection.from - close.length)
  }

  return (
    <div className="toolbar-panel toolbar-panel--actions" data-testid="toolbar-insert-panel">
      <Button
        size="small"
        block
        disabled={disabled}
        onClick={() => editor?.chain().focus().insertContent('<p></p>').run()}
      >
        空段落
      </Button>
      <Button size="small" block disabled={disabled} onClick={() => wrapSelection('「', '」')}>
        中文引号「」
      </Button>
      <Button size="small" block disabled={disabled} onClick={() => wrapSelection('《', '》')}>
        书名号《》
      </Button>
      <Button
        size="small"
        block
        disabled={disabled}
        onClick={() => editor?.chain().focus().insertContent(formatNow()).run()}
      >
        当前时间
      </Button>
    </div>
  )
}

function formatNow(): string {
  const now = new Date()
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
