import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { countHanzi, countNonWhitespace } from '@shared/text'
import { extractDocText, type DocText } from './doc-text'
import { fontStackOf, paperOf, type EditorPrefs } from './editor-prefs'
import { ProofreadHighlight, type ProofreadMark } from './proofread-extension'
import { EditorToolbar } from './EditorToolbar'

/**
 * 正文编辑器。
 *
 * 关于「样式不进文档」的一条实现约定：
 *   字体、字号、行距、纸面背景全部通过 CSS 变量作用在**容器**上，
 *   不写进 content_html。理由是这样导出的草稿永远是干净的纯文本，
 *   而作者在编辑器里看到的行距只是他本人的阅读偏好，不是作品的属性。
 *   若把 font-size 塞进正文，换台机器打开就会变成一堆行内样式垃圾。
 *
 * 关于富文本的边界：
 *   只开放「段落级」与「语义级」的格式（粗体、斜体、标题、引用、列表），
 *   不开放字号与颜色。网文平台接收的是纯文本，字号颜色在投稿时会被剥掉，
 *   允许设置只会造成「我明明调了，发出去却变了」的落差。
 */

export interface EditorChange {
  html: string
  text: string
  docText: DocText
  hanzi: number
  chars: number
}

interface RichTextEditorProps {
  /** 章节首次加载时的正文 HTML */
  initialContent: string
  /**
   * 章节标识。它变化时编辑器会被整体重建 ——
   * 这比「监听 tags 变化再 setContent」可靠得多：后者在切换章节的瞬间
   * 会先渲染上一章的内容再替换，视觉上闪一下，而且很容易把
   * 「用户刚敲的字」和「新章节的正文」搞混。
   */
  chapterKey: number
  prefs: EditorPrefs
  onPrefsChange: (patch: Partial<EditorPrefs>) => void
  marks: readonly ProofreadMark[]
  onChange: (change: EditorChange) => void
  onReady: (editor: Editor) => void
  /** Ctrl+S：交给页面去做元数据保存 */
  onSaveShortcut: () => void
  readOnly?: boolean
}

export function RichTextEditor({
  initialContent,
  chapterKey,
  prefs,
  onPrefsChange,
  marks,
  onChange,
  onReady,
  onSaveShortcut,
  readOnly = false
}: RichTextEditorProps) {
  // 这几个 ref 让「随渲染变化的外部输入」能在不改动编辑器实例的情况下被读到。
  // 编辑器实例在扩展里捕获了 getMarks 这个闭包，若直接捕获 marks 数组，
  // 它会永远停留在创建时的那一份。
  const marksRef = useRef<readonly ProofreadMark[]>(marks)
  marksRef.current = marks

  const changeRef = useRef(onChange)
  changeRef.current = onChange

  const readyRef = useRef(onReady)
  readyRef.current = onReady

  const saveRef = useRef(onSaveShortcut)
  saveRef.current = onSaveShortcut

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // 小说正文里不需要代码块、行内代码、链接与分割线；
          // 关掉它们能显著减少粘贴外部内容时的 schema 报错
          codeBlock: false,
          code: false,
          link: false,
          horizontalRule: false
        }),
        ProofreadHighlight.configure({ getMarks: () => marksRef.current })
      ],
      content: initialContent,
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: 'winbook-editor__content',
          // 关掉系统拼写检查：中文正文会被划满红波浪线，而它并不懂中文
          spellcheck: 'false',
          autocapitalize: 'off',
          autocomplete: 'off'
        },
        // 粘贴外部内容时先清洗一遍：Word 与网页会把大量行内样式、
        // class、甚至 script 一起带进来
        transformPastedHTML: normalizePastedHtml,
        handleKeyDown: (_view, event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            saveRef.current()
            return true
          }
          return false
        }
      },
      onCreate: ({ editor: instance }) => {
        readyRef.current(instance)
        emitChange(instance, changeRef.current)
      },
      onUpdate: ({ editor: instance, transaction }) => {
        // 只在文档真的变了时上报：光标移动、装饰重绘都不该触发自动保存
        if (!transaction.docChanged) return
        emitChange(instance, changeRef.current)
      },
      // 工具栏的高亮态、字数、装饰都需要跟着事务走。关掉它虽然更省，
      // 但工具栏的激活状态就会停留在上一次渲染的旧值上
      shouldRerenderOnTransaction: true,
      immediatelyRender: true
    },
    // 章节变化 → 重建编辑器。编辑器自己管内容，页面不参与正文状态
    [chapterKey]
  )

  /**
   * 标记变化时让视图重绘一次。
   *
   * 装饰是视图层的产物，只有派发一个事务才会被重新计算。这里用一个
   * 不带任何 step 的空事务 —— 它不改变文档、不进入撤销历史，
   * 作用仅仅是通知视图「装饰可能变了」。
   */
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr)
  }, [editor, marks])

  const handlePrefsChange = useCallback(
    (patch: Partial<EditorPrefs>) => {
      onPrefsChange(patch)
      // 字号/行距变了之后编辑器不需要重建，但要让光标保持可见
      editor?.commands.focus()
    },
    [editor, onPrefsChange]
  )

  const paper = paperOf(prefs.paperKey)

  const style = {
    '--editor-font-family': fontStackOf(prefs.fontKey),
    '--editor-font-size': `${prefs.fontSize}px`,
    '--editor-line-height': String(prefs.lineHeight),
    '--editor-paragraph-gap': `${prefs.paragraphGap}px`,
    '--editor-indent': prefs.firstLineIndent ? '2em' : '0em'
  } as CSSProperties

  return (
    <div className="winbook-editor" style={style} data-testid="chapter-editor">
      <EditorToolbar
        editor={editor}
        prefs={prefs}
        onPrefsChange={handlePrefsChange}
        readOnly={readOnly}
      />

      <div className="editor-stage">
        <div
          className={`editor-surface editor-surface--${paper.ink}${
            prefs.showParagraphRules ? ' editor-surface--rules' : ''
          }`}
          // 把墨色取向摆到 DOM 上。它决定正文该用浅色字还是深色字，
          // 而这件事只由纸面决定、与主题无关 —— 冒烟测试就靠这个属性
          // 校验「算出来的字色和纸面方向一致」，而不是靠人眼盯截图。
          // （曾经这里搞反过：素白纸配了近白色的字，正文整段看不见）
          data-paper-ink={paper.ink}
        >
          {/* 背景与纸面分成两层：背景层单独控制不透明度，
              否则调节「纸面浓度」会连正文一起变透明 */}
          <div
            className="editor-surface__wash"
            style={{ background: paper.background, opacity: prefs.paperOpacity }}
            aria-hidden="true"
          />

          {/* 这一层挂 data-testid 是为了让冒烟测试能数段落、拿正文文本，
              而不是去匹配 .ProseMirror 这类第三方内部类名 */}
          <div className="editor-column" data-testid="editor-content">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    </div>
  )
}

function emitChange(editor: Editor, emit: (change: EditorChange) => void): void {
  const docText = extractDocText(editor.state.doc)
  emit({
    html: editor.getHTML(),
    text: docText.text,
    docText,
    hanzi: countHanzi(docText.text),
    chars: countNonWhitespace(docText.text)
  })
}

/* ------------------------------------------------------------------ *
 * 粘贴清洗
 * ------------------------------------------------------------------ */

/** 允许保留的标签。其余标签会被「拆壳」——保留文字，丢掉标签本身 */
const ALLOWED_TAGS = new Set([
  'P',
  'BR',
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'S',
  'H1',
  'H2',
  'H3',
  'BLOCKQUOTE',
  'UL',
  'OL',
  'LI'
])

/**
 * 清洗粘贴进来的 HTML。
 *
 * 作者的两个高频来源是 Word 和网页：前者会带进 `class="MsoNormal"`、
 * 行内 font-family、以及成吨的 `<span style="...">`；后者还会带 `<img>`、
 * `<a>`、`<script>`。这些内容在 schema 里都没有对应节点，ProseMirror
 * 会在解析时报一堆警告，最终结果也往往不是作者想要的。
 *
 * 这里的策略是「白名单 + 拆壳」：认识的标签保留结构、剥掉全部属性；
 * 不认识的标签连同属性一起去掉外壳，保留内部的文字。
 * 特别地，`<script>`/`<style>` 的内容必须整段丢弃 —— 拆壳会把
 * JS 源码塞进正文，那就真的把一坨垃圾写进作品里了。
 */
function normalizePastedHtml(html: string): string {
  if (html.length === 0) return html

  const parsed = new DOMParser().parseFromString(html, 'text/html')

  for (const node of Array.from(parsed.body.querySelectorAll('script, style, head, title'))) {
    node.remove()
  }

  unwrapDisallowed(parsed.body)

  return parsed.body.innerHTML
}

function unwrapDisallowed(container: Element): void {
  // 先深度优先处理子节点，再处理自己 —— 反过来会在自己已经被拆掉之后
  // 继续遍历一个游离的子树，白做一遍功
  for (const child of Array.from(container.children)) {
    unwrapDisallowed(child)

    const tag = child.tagName.toUpperCase()
    if (ALLOWED_TAGS.has(tag)) {
      stripAttributes(child)
    } else {
      unwrap(child)
    }
  }
}

function stripAttributes(element: Element): void {
  // 逆向遍历：正序删除会让 attributes 这个实时集合不断左移，漏掉一半属性
  for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
    const attribute = element.attributes.item(index)
    if (attribute) element.removeAttribute(attribute.name)
  }
}

function unwrap(element: Element): void {
  const parent = element.parentNode
  if (!parent) return
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element)
  }
  parent.removeChild(element)
}
