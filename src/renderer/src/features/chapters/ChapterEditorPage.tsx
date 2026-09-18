import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Flex, Input, InputNumber, Select, Skeleton, Tooltip, Typography } from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloudUploadOutlined,
  CompressOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  SearchOutlined,
  UserAddOutlined
} from '@ant-design/icons'
import type { Editor } from '@tiptap/react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { CHAPTER_STATUSES, CHAPTER_STATUS_LABELS, type ChapterStatus } from '@shared/modules/chapters'
import { toUserMessage } from '../../lib/api-client'
import { formatCount, formatRelativeTime } from '../../lib/format'
import { useToast } from '../../components/Toast'
import { ChapterCatalog } from './ChapterCatalog'
import { EditorInspector } from './EditorInspector'
import { FindReplaceBar } from './FindReplaceBar'
import { NameDialog } from './NameDialog'
import { RichTextEditor, type EditorChange } from './RichTextEditor'
import {
  findTextRanges,
  mapTextRange,
  nearestRange,
  offsetOfPosition,
  paragraphIndexOfOffset,
  paragraphRange,
  positionOfOffset,
  type DocText
} from './doc-text'
import { readEditorPrefs, writeEditorPrefs, type EditorPrefs } from './editor-prefs'
import { readPlatformKey, writePlatformKey } from './platform-preview'
import { useProofread } from './use-proofread'
import { useWritingSession } from './use-writing-session'
import { useExportChapter } from './use-exporter'
import {
  useChapter,
  useChapterList,
  useCreateChapter,
  useSaveChapterContent,
  useUpdateChapter
} from './use-chapters'
import { useVolumeList } from '../books/use-volumes'
import { useBook } from '../books/use-books'

const { Text } = Typography

/** 自动保存的防抖间隔。2 秒是「感觉不到延迟」与「少写几个来回」的平衡点 */
const AUTOSAVE_MS = 2000

interface DocState {
  html: string
  text: string
  docText: DocText
  hanzi: number
  chars: number
}

interface MetaState {
  title: string
  status: ChapterStatus
  volumeId: number | null
  targetWords: number
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * 章节编辑器页面。
 *
 * 布局是三段式：左目录、中正文、右检查区，最右侧还有一条工具竖栏。
 * 这个结构直接决定了本文件里最复杂的一块逻辑 —— 自动保存。
 *
 * 自动保存有三个必须同时满足的约束：
 *   1. 打字时不能每次都写库（每 2 秒一次）；
 *   2. 切章、离开页面时必须立刻落盘，否则最后几秒的改动会丢；
 *   3. 保存失败要把内容留在待保存队列里，不能静默丢掉。
 * 为此待保存的内容用 `{ chapterId, html }` 成对记录 —— 只存 html 的话，
 * 切章瞬间的「上一章内容」会被当成「新章节内容」写进去，那是最严重的
 * 一类数据事故：把 A 章的正文覆盖到 B 章上。
 */
export function ChapterEditorPage() {
  const params = useParams<{ bookId: string; chapterId: string }>()
  const bookId = Number(params.bookId)
  const chapterId = Number(params.chapterId)

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { notifySuccess, notifyError } = useToast()

  /*
   * 「从全库检索跳过来」时带的两个参数：要定位的关键词，以及它在大致哪个
   * 偏移上。两者都需要 —— 见下方 locateTarget 效果的说明。
   */
  const locateKeyword = searchParams.get('find') ?? ''
  const locateOffset = Number(searchParams.get('at') ?? '0')

  const book = useBook(bookId)
  const chapter = useChapter(chapterId)
  const chapterList = useChapterList({ bookId, volumeId: undefined })
  const volumeList = useVolumeList(bookId)

  const saveContent = useSaveChapterContent()
  const updateChapter = useUpdateChapter()
  const createChapter = useCreateChapter()
  const exportChapter = useExportChapter()

  const [prefs, setPrefs] = useState<EditorPrefs>(readEditorPrefs)
  const [platformKey, setPlatformKey] = useState<string>(readPlatformKey)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [doc, setDoc] = useState<DocState | null>(null)
  const [revision, setRevision] = useState(0)
  const [meta, setMeta] = useState<MetaState | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [serverCounts, setServerCounts] = useState<{ hanzi: number; chars: number } | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [nameOpen, setNameOpen] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [creating, setCreating] = useState(false)

  const proofread = useProofread(doc?.docText ?? null, revision)
  const session = useWritingSession(bookId, chapterId, chapter.data?.hanziCount ?? null)

  /* ------------------------------------------------------------------ *
   * 偏好持久化
   * ------------------------------------------------------------------ */

  const patchPrefs = useCallback((patch: Partial<EditorPrefs>): void => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      writeEditorPrefs(next)
      return next
    })
  }, [])

  const changePlatform = useCallback((key: string): void => {
    setPlatformKey(key)
    writePlatformKey(key)
  }, [])

  /* ------------------------------------------------------------------ *
   * 元数据初始化
   *
   * 依赖是 chapter.data?.id 而不是 chapter.data 本身：详情查询会因为
   * 各种原因重新拉取（会话结算后的失效、窗口重新聚焦），若把整个对象
   * 放进依赖，每次重取都会把用户正在编辑的标题覆盖回服务端的旧值。
   * 只在「换了一章」时重置，才符合直觉。
   * ------------------------------------------------------------------ */

  useEffect(() => {
    const data = chapter.data
    if (!data) return
    setMeta({
      title: data.title,
      status: data.status,
      volumeId: data.volumeId,
      targetWords: data.targetWords
    })
    setSavedAt(data.updatedAt)
    setServerCounts({ hanzi: data.hanziCount, chars: data.charCount })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.data?.id])

  /* ------------------------------------------------------------------ *
   * 自动保存
   * ------------------------------------------------------------------ */

  const pendingRef = useRef<{ chapterId: number; html: string } | null>(null)
  const lastSavedRef = useRef<string>('')
  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const saveContentRef = useRef(saveContent)

  saveContentRef.current = saveContent

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    // 内容没变就不写库：光标移动、装饰重绘都可能走到这里
    if (pending.html === lastSavedRef.current) return

    if (mountedRef.current) setSaveState('saving')

    try {
      const result = await saveContentRef.current.mutateAsync({
        id: pending.chapterId,
        contentHtml: pending.html
      })
      lastSavedRef.current = pending.html
      if (!mountedRef.current) return
      setSaveState('saved')
      setSavedAt(result.updatedAt)
      // 用服务端回传的字数而不是前端自己算的：主进程是唯一的口径来源
      setServerCounts({ hanzi: result.hanziCount, chars: result.charCount })
    } catch (error) {
      if (!mountedRef.current) return
      setSaveState('error')
      notifyError(`保存失败：${toUserMessage(error)}`)
      // 放回队列。下一次编辑或离开页面时会再试一次，
      // 而不是把这段内容直接丢掉
      if (pendingRef.current === null) pendingRef.current = pending
    }
  }, [notifyError])

  const flushRef = useRef(flush)
  flushRef.current = flush

  const scheduleFlush = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void flushRef.current()
    }, AUTOSAVE_MS)
  }, [])

  /**
   * 当前这份 doc 是从哪一章来的。
   *
   * 存在的理由是一个很容易踩空的时序：路由参数 `chapterId` 变化时，
   * `doc` 里还留着**上一章**的正文，要等 TipTap 重建完成（onCreate →
   * emitChange）才会被换掉。若在那一刻就去正文里找检索关键词，
   * 找的是上一章的文本 —— 表现是「跳到新章节却高亮了不相干的地方」。
   */
  const docChapterRef = useRef<number | null>(null)

  const handleChange = useCallback(
    (change: EditorChange): void => {
      setDoc(change)
      docChapterRef.current = chapterId
      setRevision((value) => value + 1)
      pendingRef.current = { chapterId, html: change.html }
      scheduleFlush()
      // 上报字数给会话采集：它靠这个值算「这一段写了多少」
      session.reportWords(change.hanzi)
    },
    [chapterId, scheduleFlush, session]
  )

  // 切章 / 离开页面：立刻落盘。这是「最后几秒的改动不能丢」的唯一保障
  useEffect(() => {
    return () => {
      void flushRef.current()
    }
  }, [chapterId])

  /* ------------------------------------------------------------------ *
   * 元数据保存
   * ------------------------------------------------------------------ */

  const saveMeta = useCallback(async (): Promise<void> => {
    if (!meta) return
    const title = meta.title.trim()
    if (title.length === 0) {
      notifyError('章节标题不能为空')
      return
    }

    try {
      await updateChapter.mutateAsync({
        id: chapterId,
        title,
        status: meta.status,
        volumeId: meta.volumeId,
        targetWords: meta.targetWords
      })
      notifySuccess('章节信息已保存')
    } catch (error) {
      notifyError(toErrorMessage(error))
    }
  }, [chapterId, meta, notifyError, notifySuccess, updateChapter])

  /* ------------------------------------------------------------------ *
   * 目录操作
   * ------------------------------------------------------------------ */

  const goToChapter = useCallback(
    (id: number): void => {
      // 切章前先把当前章节的内容落盘，避免「切得太快丢字」
      void flushRef.current()
      void navigate(`/books/${bookId}/chapters/${id}`)
    },
    [bookId, navigate]
  )

  const handleCreateChapter = useCallback(
    async (title: string, volumeId: number | null): Promise<void> => {
      setCreating(true)
      try {
        const created = await createChapter.mutateAsync({ bookId, volumeId, title, targetWords: 0 })
        void navigate(`/books/${bookId}/chapters/${created.id}`)
      } catch (error) {
        notifyError(toErrorMessage(error))
      } finally {
        setCreating(false)
      }
    },
    [bookId, createChapter, navigate, notifyError]
  )

  /**
   * 底栏的「新建章节」：直接以「第 N 章」为名建好并跳过去。
   *
   * 命名带序号而不是留空：作者在底栏点新建，意图几乎是「接着往下写」，
   * 让他先停下来想标题是多余的打断。标题之后随时可以在上方改。
   */
  const quickCreateChapter = useCallback((): void => {
    const count = chapterList.data?.length ?? 0
    const currentVolumeId =
      chapterList.data?.find((item) => item.id === chapterId)?.volumeId ?? null
    void handleCreateChapter(`第 ${count + 1} 章`, currentVolumeId)
  }, [chapterId, chapterList.data, handleCreateChapter])

  const handleCreateVolume = useCallback(
    async (title: string): Promise<void> => {
      // 分卷的创建放在书籍详情页，那里有完整的卷管理；这里只是把用户送过去
      notifySuccess(`请先在书籍详情页创建分卷「${title}」`)
      void navigate(`/books/${bookId}`)
    },
    [bookId, navigate, notifySuccess]
  )

  /* ------------------------------------------------------------------ *
   * 正文跳转
   * ------------------------------------------------------------------ */

  const jumpToRange = useCallback(
    (start: number, end: number): void => {
      if (!editor || !doc) return
      const range = mapTextRange(doc.docText, start, end)
      if (!range) return
      editor.chain().focus().setTextSelection(range).scrollIntoView().run()
    },
    [doc, editor]
  )

  const resolveCursorParagraph = useCallback((): number | null => {
    if (!editor || !doc) return null
    const offset = offsetOfPosition(doc.docText, editor.state.selection.from)
    if (offset === null) return null
    return paragraphIndexOfOffset(doc.docText.text, offset)
  }, [doc, editor])

  const revealParagraph = useCallback(
    (index: number): void => {
      if (!editor || !doc) return
      const range = paragraphRange(doc.docText.text, index)
      if (!range) return
      const position = positionOfOffset(doc.docText, range.start)
      if (position === null) return
      editor.chain().focus().setTextSelection(position).scrollIntoView().run()
    },
    [doc, editor]
  )

  /* ------------------------------------------------------------------ *
   * 从全库检索跳过来时定位到命中处
   * ------------------------------------------------------------------ */

  /** 已经处理过的定位请求，形如 `章节id|关键词|偏移` */
  const handledLocateRef = useRef<string>('')

  /**
   * 把光标落到检索命中的那一段上。
   *
   * 这里的分工必须说清楚：**关键词负责「找得到」，偏移负责「是哪一次」**。
   *
   * 不能只信偏移 —— 主进程搜的是库里的 `content_text`，而编辑器手里是从
   * TipTap 文档算出的纯文本，两套投影的换行约定并不完全一致（`htmlToText`
   * 对列表这类嵌套块级结构插入的换行数与 `extractDocText` 不同），
   * 偏移会差上几个字符。直接拿它去 mapTextRange，会标在错误的字上 ——
   * 而这类错误极其隐蔽，用户只会觉得「定位不准」。
   *
   * 也不能只用关键词 —— 一个词在一章里出现十次时，跳过去永远落在第一次，
   * 而用户点的是第五次。
   *
   * 于是：先用关键词在自己的文本里找出全部出现位置，再取离偏移最近的那一次。
   * 偏移的漂移量是「几个字符」级别，远小于同一关键词两次命中之间的间距，
   * 所以除非那一章里两次命中挨得极近，「最近」就等于「原本那一次」。
   */
  useEffect(() => {
    if (locateKeyword.length === 0) return

    const key = `${chapterId}|${locateKeyword}|${locateOffset}`
    if (handledLocateRef.current === key) return
    if (!editor || doc === null) return
    // 正文还没换成这一章的，等 doc 变了再试（见 docChapterRef 的说明）
    if (docChapterRef.current !== chapterId) return

    /*
     * 先标记再定位：即使这一章里根本没找到该关键词，这次请求也算已消费。
     * 不标记的话，`doc` 每变一次（也就是用户每敲一个字）都要重试一遍 ——
     * 而更要紧的是，若用户之后正好打出了这个词，光标会突然跳走。
     */
    handledLocateRef.current = key

    const ranges = findTextRanges(doc.docText.text, locateKeyword)
    const target = nearestRange(ranges, locateOffset)
    if (target === null) return

    jumpToRange(target.start, target.end)
  }, [chapterId, doc, editor, jumpToRange, locateKeyword, locateOffset])

  /* ------------------------------------------------------------------ *
   * 顶栏动作
   * ------------------------------------------------------------------ */

  const insertName = useCallback(
    (name: string): void => {
      editor?.chain().focus().insertContent(name).run()
    },
    [editor]
  )

  const handleExport = useCallback(async (): Promise<void> => {
    // 导出前先落盘：用户点了「发布草稿」，期待的是磁盘上的文件和屏幕上的内容一致
    await flushRef.current()
    try {
      const result = await exportChapter.mutateAsync({ chapterId, format: 'txt' })
      if (result.canceled) return
      notifySuccess(`草稿已导出：${result.filePath ?? result.suggestedName}`)
    } catch (error) {
      notifyError(toErrorMessage(error))
    }
  }, [chapterId, exportChapter, notifyError, notifySuccess])

  // Ctrl+F 打开查找替换；Esc 关掉它
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFindOpen(true)
      }
      if (event.key === 'Escape') setFindOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  /* ------------------------------------------------------------------ *
   * 派生数据
   * ------------------------------------------------------------------ */

  const volumeOptions = useMemo(
    () => [
      { value: null as number | null, label: '未分卷' },
      ...(volumeList.data ?? []).map((volume) => ({ value: volume.id, label: volume.title }))
    ],
    [volumeList.data]
  )

  const liveHanzi = doc?.hanzi ?? serverCounts?.hanzi ?? 0
  const liveChars = doc?.chars ?? serverCounts?.chars ?? 0

  const targetPlan = useMemo(() => {
    const target = meta?.targetWords ?? 0
    if (target <= 0) return null
    const remaining = target - liveHanzi
    return { target, remaining }
  }, [liveHanzi, meta?.targetWords])

  if (chapter.isError) {
    return (
      <Flex vertical gap={16} className="page">
        <Text>章节加载失败。</Text>
        <Button onClick={() => void navigate(`/books/${bookId}`)}>返回书籍</Button>
      </Flex>
    )
  }

  const ready = chapter.data !== undefined && meta !== null

  return (
    <div className={`editor-page${focusMode ? ' editor-page--focus' : ''}`}>
      {/* ---------------- 顶栏 ---------------- */}
      <header className="editor-topbar">
        <Flex align="center" gap={8} className="editor-topbar__left">
          <Tooltip title="返回书籍详情">
            <Button
              size="small"
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => {
                void flushRef.current()
                void navigate(`/books/${bookId}`)
              }}
            />
          </Tooltip>
          <Text className="editor-topbar__book" ellipsis>
            {book.data?.title ?? '…'}
          </Text>
          <Text type="secondary">/</Text>
          <Text className="editor-topbar__chapter" ellipsis>
            {meta?.title ?? '…'}
          </Text>
        </Flex>

        <Flex align="center" gap={4}>
          <Tooltip title="查找替换（Ctrl+F）">
            <Button
              size="small"
              type="text"
              icon={<SearchOutlined />}
              onClick={() => setFindOpen((value) => !value)}
            >
              查找替换
            </Button>
          </Tooltip>
          <Tooltip title="生成中文人名，可一键插入正文">
            <Button
              size="small"
              type="text"
              icon={<UserAddOutlined />}
              onClick={() => setNameOpen(true)}
            >
              取名
            </Button>
          </Tooltip>
          <Tooltip title={focusMode ? '退出专注模式' : '专注模式：收起左右两栏，只留正文'}>
            <Button
              size="small"
              type="text"
              icon={<CompressOutlined />}
              onClick={() => setFocusMode((value) => !value)}
            >
              专注
            </Button>
          </Tooltip>
          <Tooltip title="把本章导出为 .txt 草稿文件">
            <Button
              size="small"
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={exportChapter.isPending}
              onClick={() => void handleExport()}
            >
              发布草稿
            </Button>
          </Tooltip>
        </Flex>
      </header>

      {findOpen ? (
        <FindReplaceBar
          editor={editor}
          docText={doc?.docText ?? null}
          onClose={() => setFindOpen(false)}
        />
      ) : null}

      {/* ---------------- 主体 ---------------- */}
      <div className="editor-body">
        {focusMode ? null : (
          <ChapterCatalog
            bookId={bookId}
            activeChapterId={chapterId}
            chapters={chapterList.data}
            volumes={volumeList.data}
            loading={chapterList.isPending}
            onCreateChapter={(title, volumeId) => void handleCreateChapter(title, volumeId)}
            onCreateVolume={(title) => void handleCreateVolume(title)}
            onSelectChapter={goToChapter}
            onSwitchBook={(id) => {
              void flushRef.current()
              void navigate(`/books/${id}`)
            }}
            savingTitle={creating}
          />
        )}

        <div className="editor-main">
          {!ready || meta === null ? (
            <div className="editor-main__loading">
              <Skeleton active paragraph={{ rows: 10 }} />
            </div>
          ) : (
            <>
              <div className="editor-metabar">
                <Input
                  className="editor-metabar__title"
                  variant="borderless"
                  value={meta.title}
                  placeholder="章节标题"
                  onChange={(event) =>
                    setMeta((previous) =>
                      previous === null ? previous : { ...previous, title: event.target.value }
                    )
                  }
                  onBlur={() => void saveMeta()}
                  onPressEnter={() => void saveMeta()}
                  data-testid="chapter-title-input"
                />

                <Flex align="center" gap={8} wrap className="editor-metabar__controls">
                  <Select
                    size="small"
                    className="editor-metabar__select"
                    value={meta.volumeId}
                    options={volumeOptions}
                    onChange={(value) =>
                      setMeta((previous) =>
                        previous === null ? previous : { ...previous, volumeId: value }
                      )
                    }
                    onBlur={() => void saveMeta()}
                  />
                  <Select
                    size="small"
                    className="editor-metabar__select"
                    value={meta.status}
                    options={CHAPTER_STATUSES.map((status) => ({
                      value: status,
                      label: CHAPTER_STATUS_LABELS[status]
                    }))}
                    onChange={(value) =>
                      setMeta((previous) =>
                        previous === null ? previous : { ...previous, status: value }
                      )
                    }
                  />
                  <Flex align="center" gap={4}>
                    <Text type="secondary" className="editor-metabar__label">
                      本章目标
                    </Text>
                    <InputNumber
                      size="small"
                      className="editor-metabar__number"
                      min={0}
                      step={500}
                      value={meta.targetWords}
                      onChange={(value) =>
                        setMeta((previous) =>
                          previous === null
                            ? previous
                            : { ...previous, targetWords: typeof value === 'number' ? value : 0 }
                        )
                      }
                      onBlur={() => void saveMeta()}
                    />
                    <Text type="secondary" className="editor-metabar__label">
                      字
                    </Text>
                  </Flex>
                  <Button size="small" onClick={() => void saveMeta()} loading={updateChapter.isPending}>
                    保存信息
                  </Button>
                </Flex>
              </div>

              {/*
                只有章节详情到手后才挂载编辑器。
                否则编辑器会以空内容创建，而 chapterKey 没变时它不会被重建 ——
                结果就是「打开已有章节，正文是空白的」。
              */}
              <RichTextEditor
                initialContent={chapter.data.contentHtml}
                chapterKey={chapterId}
                prefs={prefs}
                onPrefsChange={patchPrefs}
                marks={proofread.marks}
                onChange={handleChange}
                onReady={setEditor}
                onSaveShortcut={() => {
                  void flushRef.current()
                  void saveMeta()
                }}
              />
            </>
          )}
        </div>

        {focusMode ? null : (
          <EditorInspector
            bookTitle={book.data?.title ?? '未命名书籍'}
            text={doc?.text ?? ''}
            charCount={liveChars}
            proofread={proofread}
            platformKey={platformKey}
            onPlatformChange={changePlatform}
            onJump={jumpToRange}
            resolveCursorParagraph={resolveCursorParagraph}
            onRevealParagraph={revealParagraph}
          />
        )}
      </div>

      {/* ---------------- 底栏 ---------------- */}
      <footer className="editor-statusbar">
        <Button
          size="small"
          type="link"
          icon={<CloudUploadOutlined rotate={180} />}
          loading={creating}
          onClick={quickCreateChapter}
        >
          新建章节
        </Button>

        <Flex align="center" gap={16} className="editor-statusbar__stats">
          <Tooltip title="本章目标字数减去本章已写汉字数">
            <Text type="secondary" className="editor-statusbar__item">
              计划：
              {targetPlan === null
                ? '未设目标'
                : targetPlan.remaining >= 0
                  ? `剩 ${formatCount(targetPlan.remaining)}`
                  : `已超 ${formatCount(-targetPlan.remaining)}`}
            </Text>
          </Tooltip>

          <Tooltip title="标点、引号配对、中英标点混用的问题数">
            <Text
              type="secondary"
              className="editor-statusbar__item"
              data-testid="editor-proofread-count"
              data-value={proofread.result?.errorCount ?? 0}
            >
              <ExclamationCircleOutlined /> 纠错：{proofread.result?.errorCount ?? 0} 处
            </Text>
          </Tooltip>

          <Tooltip title="本章汉字数。点开可看含标点的平台口径">
            <Text
              className="editor-statusbar__item editor-statusbar__item--strong"
              data-testid="editor-hanzi"
              data-value={liveHanzi}
            >
              <EyeOutlined /> 本章：{formatCount(liveHanzi)}
              <Text type="secondary" className="editor-statusbar__sub">
                含标点 {formatCount(liveChars)}
              </Text>
            </Text>
          </Tooltip>

          <SaveIndicator state={saveState} savedAt={savedAt} />
        </Flex>
      </footer>

      <NameDialog open={nameOpen} onClose={() => setNameOpen(false)} onInsert={insertName} />
    </div>
  )
}

/**
 * 保存状态指示。
 *
 * 不显示「未保存」而显示「2 秒后自动保存」这类文案是刻意的：
 * 自动保存的意义就是让作者不必关心保存这件事。只在真的失败时
 * 用醒目样式提示 —— 其余时候它是一个「可以安心往下写」的信号。
 */
function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: string | null }) {
  if (state === 'saving') {
    return (
      <Text type="secondary" className="editor-statusbar__item">
        保存中…
      </Text>
    )
  }

  if (state === 'error') {
    return (
      <Text type="danger" className="editor-statusbar__item">
        <ExclamationCircleOutlined /> 保存失败，将自动重试
      </Text>
    )
  }

  return (
    <Text type="secondary" className="editor-statusbar__item">
      <CheckCircleOutlined /> {savedAt ? `已保存 ${formatRelativeTime(savedAt)}` : '自动保存已开启'}
    </Text>
  )
}

/** 把任意异常转成可展示文案。ApiError 的场景化前缀由调用方加 */
function toErrorMessage(error: unknown): string {
  return toUserMessage(error)
}
