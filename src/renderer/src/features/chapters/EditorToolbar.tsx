import type { ReactNode } from 'react'
import { Button, Divider, Flex, Popover, Slider, Switch, Tooltip, Typography } from 'antd'
import {
  AlignLeftOutlined,
  BgColorsOutlined,
  BoldOutlined,
  FontSizeOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  PlusOutlined,
  RedoOutlined,
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
  type EditorPrefs
} from './editor-prefs'

const { Text } = Typography

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
 *   字体 / 背景 —— 影响整页观感，先调好再动笔
 *   加粗 斜体 下划线 删除线 标题 引用 列表 —— 正文里的实际格式
 *   撤销 / 重做
 *   排版 / 插入 —— 细节微调
 *
 * 所有「偏好类」的改动都走 onPrefsChange（只影响本地渲染，不进文档），
 * 所有「格式类」的改动才落到编辑器上（写进 content_html）。
 * 这条界线在界面上的体现是：前者用弹出面板里的滑杆，后者用可高亮的按钮。
 */
export function EditorToolbar({ editor, prefs, onPrefsChange, readOnly }: EditorToolbarProps) {
  const disabled = editor === null || readOnly

  return (
    <div className="editor-toolbar" data-testid="editor-toolbar">
      <Flex align="center" gap={4} wrap>
        {/* ---------------- 字体 ---------------- */}
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="字体与行距"
          content={<TypographyPanel prefs={prefs} onPrefsChange={onPrefsChange} />}
        >
          <Button size="small" type="text" icon={<FontSizeOutlined />}>
            字体
          </Button>
        </Popover>

        {/* ---------------- 背景 ---------------- */}
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="纸面背景"
          content={<PaperPanel prefs={prefs} onPrefsChange={onPrefsChange} />}
        >
          <Button size="small" type="text"           icon={<BgColorsOutlined />}
          >
            背景
          </Button>
        </Popover>

        <Divider type="vertical" />

        {/* ---------------- 文字格式 ---------------- */}
        <Tooltip title="加粗（Ctrl+B）">
          <Button
            size="small"
            type={editor?.isActive('bold') ? 'primary' : 'text'}
            icon={<BoldOutlined />}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          />
        </Tooltip>
        <Tooltip title="斜体（Ctrl+I）">
          <Button
            size="small"
            type={editor?.isActive('italic') ? 'primary' : 'text'}
            icon={<ItalicOutlined />}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          />
        </Tooltip>
        <Tooltip title="下划线（Ctrl+U）">
          <Button
            size="small"
            type={editor?.isActive('underline') ? 'primary' : 'text'}
            icon={<UnderlineOutlined />}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          />
        </Tooltip>
        <Tooltip title="删除线">
          <Button
            size="small"
            type={editor?.isActive('strike') ? 'primary' : 'text'}
            icon={<StrikethroughOutlined />}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
          />
        </Tooltip>

        <Divider type="vertical" />

        <Tooltip title="小标题">
          <Button
            size="small"
            type={editor?.isActive('heading', { level: 3 }) ? 'primary' : 'text'}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H
          </Button>
        </Tooltip>
        <Tooltip title="引用段落">
          <Button
            size="small"
            type={editor?.isActive('blockquote') ? 'primary' : 'text'}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            引
          </Button>
        </Tooltip>
        <Tooltip title="无序列表">
          <Button
            size="small"
            type={editor?.isActive('bulletList') ? 'primary' : 'text'}
            icon={<UnorderedListOutlined />}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          />
        </Tooltip>
        <Tooltip title="有序列表">
          <Button
            size="small"
            type={editor?.isActive('orderedList') ? 'primary' : 'text'}
            icon={<OrderedListOutlined />}
            disabled={disabled}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          />
        </Tooltip>

        <Divider type="vertical" />

        <Tooltip title="撤销（Ctrl+Z）">
          <Button
            size="small"
            type="text"
            icon={<UndoOutlined />}
            disabled={disabled || !editor?.can().undo()}
            onClick={() => editor?.chain().focus().undo().run()}
          />
        </Tooltip>
        <Tooltip title="重做（Ctrl+Shift+Z）">
          <Button
            size="small"
            type="text"
            icon={<RedoOutlined />}
            disabled={disabled || !editor?.can().redo()}
            onClick={() => editor?.chain().focus().redo().run()}
          />
        </Tooltip>

        <Divider type="vertical" />

        {/* ---------------- 排版 ---------------- */}
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="排版"
          content={<LayoutPanel prefs={prefs} onPrefsChange={onPrefsChange} />}
        >
          <Button size="small" type="text" icon={<AlignLeftOutlined />}>
            排版
          </Button>
        </Popover>

        {/* ---------------- 插入 ---------------- */}
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="插入"
          content={<InsertPanel editor={editor} disabled={disabled} />}
        >
          <Button size="small" type="text" icon={<PlusOutlined />}>
            插入
          </Button>
        </Popover>
      </Flex>
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

function TypographyPanel({
  prefs,
  onPrefsChange
}: {
  prefs: EditorPrefs
  onPrefsChange: (patch: Partial<EditorPrefs>) => void
}) {
  return (
    <div className="toolbar-panel" data-testid="toolbar-font-panel">
      <PanelRow label="字体">
        <Flex gap={4} wrap>
          {EDITOR_FONT_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              size="small"
              type={prefs.fontKey === preset.key ? 'primary' : 'default'}
              // 用字体本身的字形当预览，比让用户在「思源宋体」和
              // 「Noto Serif SC」之间猜哪个更好看直观得多
              style={{ fontFamily: preset.stack }}
              onClick={() => onPrefsChange({ fontKey: preset.key })}
            >
              {preset.label}
            </Button>
          ))}
        </Flex>
      </PanelRow>

      <PanelRow label={`字号 ${prefs.fontSize}px`}>
        <Slider
          className="toolbar-panel__slider"
          min={EDITOR_PREF_LIMITS.fontSize[0]}
          max={EDITOR_PREF_LIMITS.fontSize[1]}
          step={1}
          value={prefs.fontSize}
          onChange={(value) => onPrefsChange({ fontSize: value })}
        />
      </PanelRow>

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
    </div>
  )
}

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
      <PanelRow label={`段间距 ${prefs.paragraphGap}px`}>
        <Slider
          className="toolbar-panel__slider"
          min={EDITOR_PREF_LIMITS.paragraphGap[0]}
          max={EDITOR_PREF_LIMITS.paragraphGap[1]}
          step={2}
          value={prefs.paragraphGap}
          onChange={(value) => onPrefsChange({ paragraphGap: value })}
        />
      </PanelRow>

      <PanelRow label="首行缩进两字" hint="网文平台多为不缩进，纸书排版为缩进">
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
