import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Flex, Input, Skeleton, Tooltip, Typography } from 'antd'
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
import {
  CHAPTER_STATUS_LABELS,
  type ChapterListItem,
  type ChapterStatus
} from '@shared/modules/chapters'
import { toUserMessage } from '../../lib/api-client'
import { formatCount, formatRelativeTime } from '../../lib/format'
import { useToast } from '../../components/Toast'
import { IconButton } from '../../components/IconButton'
import { ChapterCatalog, type ChapterPatch } from './ChapterCatalog'
import type { ChapterCreateValues } from './ChapterCreateModal'
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

  /**
   * 新建一章。返回值是「有没有真的建成」，给目录栏决定关不关弹窗用 ——
   * 失败还把弹窗关掉的话，作者填好的标题与分卷会一起消失。
   */
  const handleCreateChapter = useCallback(
    async (values: ChapterCreateValues): Promise<boolean> => {
      setCreating(true)
      try {
        const created = await createChapter.mutateAsync({
          bookId,
          volumeId: values.volumeId,
          title: values.title,
          // 本章目标字数不再是用户输入项，而是建章那一刻书级规则的快照。
          // 这样导出与统计读到的仍是一个真实数字，而底栏的「计划」读的是
          // 书籍设置本身（改了书级设置，全书立刻按新标准显示）。
          targetWords: book.data?.chapterWords ?? 0
        })
        const target = `/books/${bookId}/chapters/${created.id}`
        // 状态是弹窗里选的，而 createChapter 只落默认值，所以这里补一次元数据写入
        if (values.status !== 'draft') {
          await updateChapter.mutateAsync({
            id: created.id,
            title: values.title,
            status: values.status,
            volumeId: values.volumeId,
            targetWords: book.data?.chapterWords ?? 0
          })
        }
        void navigate(target)
        return true
      } catch (error) {
        notifyError(toErrorMessage(error))
        return false
      } finally {
        setCreating(false)
      }
    },
    [book.data?.chapterWords, bookId, createChapter, navigate, notifyError, updateChapter]
  )

  const handleCreateVolume = useCallback(
    async (title: string): Promise<void> => {
      // 分卷的创建放在书籍详情页，那里有完整的卷管理；这里只是把用户送过去
      notifySuccess(`请先在书籍详情页创建分卷「${title}」`)
      void navigate(`/books/${bookId}`)
    },
    [bookId, navigate, notifySuccess]
  )

  /** 提示文案里的「移到 XX」。卷被删过就会查不到，退回一句通用说法而不是「undefined」 */
  const volumeLabel = useCallback(
    (volumeId: number | null): string => {
      if (volumeId === null) return '未分卷'
      return (volumeList.data ?? []).find((volume) => volume.id === volumeId)?.title ?? '其他分卷'
    },
    [volumeList.data]
  )

  /**
   * 目录行右键菜单：改一章的状态或所属分卷。
   *
   * 这个接口是**整体替换**（title / status / volumeId / targetWords 都得给全），
   * 而菜单只说「我改了状态」。剩下三项由这里补齐，补齐时有一处必须当心：
   * 如果改的正好是**正在编辑的那一章**，标题可能改了但还没落盘（失焦才保存），
   * 拿列表里的旧标题去补，就等于「我改了个状态，标题被打回上一次保存的值」。
   * 所以当前章一律以编辑器里的 meta 为准。
   */
  const handlePatchChapter = useCallback(
    async (target: ChapterListItem, patch: ChapterPatch): Promise<void> => {
      // 只有「正在编辑的这一章」才有更权威的本地状态
      const liveMeta = target.id === chapterId ? meta : null

      // 标题为空的兜底：作者正在重打标题时点右键，不该因此写库失败，
      // 也不该把标题清空 —— 保留原值，等他敲完自然会存
      const trimmed = (liveMeta?.title ?? target.title).trim()
      const title = trimmed.length > 0 ? trimmed : target.title

      // 这里刻意不写 `??`：volumeId 的「空」是 null（未分卷）而不是 undefined，
      // 用 `??` 会把「确实要设为未分卷」误判成「没给值」而退回旧值
      const sourceVolumeId = liveMeta === null ? target.volumeId : liveMeta.volumeId
      const nextVolumeId = patch.volumeId !== undefined ? patch.volumeId : sourceVolumeId
      const nextStatus = patch.status ?? liveMeta?.status ?? target.status

      try {
        await updateChapter.mutateAsync({
          id: target.id,
          title,
          status: nextStatus,
          volumeId: nextVolumeId,
          targetWords: liveMeta?.targetWords ?? target.targetWords
        })

        // 当前章还要把改动同步进 meta：否则编辑器手里仍攥着旧状态，
        // 下次标题失焦触发 saveMeta 时会把它原样写回去，菜单里改的就白改了
        if (liveMeta !== null) {
          setMeta((previous) =>
            previous === null
              ? previous
              : { ...previous, status: nextStatus, volumeId: nextVolumeId }
          )
        }

        notifySuccess(
          patch.status !== undefined
            ? `「${title}」已标为${CHAPTER_STATUS_LABELS[patch.status]}`
            : `「${title}」已移到${volumeLabel(nextVolumeId)}`
        )
      } catch (error) {
        notifyError(toErrorMessage(error))
      }
    },
    [chapterId, meta, notifyError, notifySuccess, updateChapter, volumeLabel]
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

  const liveHanzi = doc?.hanzi ?? serverCounts?.hanzi ?? 0
  const liveChars = doc?.chars ?? serverCounts?.chars ?? 0

  /**
   * 底栏的「计划：剩 N」。
   *
   * 口径取自**书籍**的「每章最少字数」，不是本章自己的某个字段：这是一条
   * 全书统一的规则，在新建/编辑书籍时定一次。也正因为它读的是书级设置，
   * 作者改了书籍设置之后，每一章立刻按新的标准显示 —— 若读的是建章那一刻
   * 存下来的快照，同一本书里就会新旧标准混着用，还得逐章去改。
   */
  const targetPlan = useMemo(() => {
    const target = book.data?.chapterWords ?? 0
    if (target <= 0) return null
    const remaining = target - liveHanzi
    return { target, remaining }
  }, [book.data?.chapterWords, liveHanzi])

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
          <IconButton
            label="返回书籍详情"
            icon={<ArrowLeftOutlined />}
            data-testid="editor-back"
            onClick={() => {
              void flushRef.current()
              void navigate(`/books/${bookId}`)
            }}
          />
          <Text className="editor-topbar__book" ellipsis>
            {book.data?.title ?? '…'}
          </Text>
          <Text type="secondary">/</Text>
          <Text className="editor-topbar__chapter" ellipsis>
            {meta?.title ?? '…'}
          </Text>
        </Flex>

        {/*
          四枚圆形图标按钮（用户 2026-09-20：「各个界面中的图标也要跟着改」）。
          改造前它们是四个「图标 + 文字」按钮，一共占掉 300px 宽 —— 而这一条
          顶栏的高度是写死的 46px，宽的那一排把书名与章节名挤到只剩省略号。
          文字移进提示后，标题终于有地方显示了。
        */}
        <Flex align="center" gap={4}>
          <IconButton
            label="查找替换（Ctrl+F）"
            icon={<SearchOutlined />}
            data-testid="editor-find-toggle"
            onClick={() => setFindOpen((value) => !value)}
          />
          <IconButton
            label="取名（生成中文人名，可一键插入正文）"
            icon={<UserAddOutlined />}
            data-testid="editor-name"
            onClick={() => setNameOpen(true)}
          />
          <IconButton
            label={focusMode ? '退出专注模式' : '专注模式：收起左右两栏，只留正文'}
            icon={<CompressOutlined />}
            data-testid="editor-focus-toggle"
            onClick={() => setFocusMode((value) => !value)}
          />
          <IconButton
            label="发布草稿（把本章导出为 .txt 草稿文件）"
            tone="primary"
            icon={<CloudUploadOutlined />}
            data-testid="editor-export"
            loading={exportChapter.isPending}
            onClick={() => void handleExport()}
          />
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
            chapterWords={book.data?.chapterWords ?? 0}
            onCreateChapter={(values) => handleCreateChapter(values)}
            onCreateVolume={(title) => void handleCreateVolume(title)}
            onPatchChapter={(target, patch) => void handlePatchChapter(target, patch)}
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
              {/*
                标题留在正文上方，只此一项。

                分卷、状态、目标字数原本也在这里，现在全部移到「新建章」弹窗：
                它们是在决定「要写这一章」的那一刻就想清楚的事，等进了正文
                再填，只是把选择推迟到注意力已经被正文消耗之后。而每章最少
                字数更是书籍级规则（全书统一），本来就不该逐章再填一遍。
              */}
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
        <Flex align="center" gap={16} className="editor-statusbar__stats">
          <Tooltip title="书籍设置的「每章最少字数」减去本章已写汉字数">
            <Text
              type="secondary"
              className="editor-statusbar__item"
              data-testid="editor-plan"
              data-value={targetPlan === null ? -1 : targetPlan.remaining}
            >
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
