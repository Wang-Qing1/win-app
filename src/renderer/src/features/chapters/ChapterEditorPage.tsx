import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Flex, Input, Skeleton, Tooltip, Typography } from 'antd'
import {
  ArrowLeftOutlined,
  LeftOutlined,
  CheckCircleOutlined,
  CloudUploadOutlined,
  CompressOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  HistoryOutlined,
  PlusOutlined,
  SearchOutlined,
  UserAddOutlined
} from '@ant-design/icons'
import type { Editor } from '@tiptap/react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  CHAPTER_STATUS_LABELS,
  type ChapterListItem,
  type ChapterStatus
} from '@shared/modules/chapters'
import type { VolumeListItem } from '@shared/modules/volumes'
import { toUserMessage } from '../../lib/api-client'
import { formatCompact, formatCount, formatRelativeTime, progressPercent } from '../../lib/format'
import { useConfirm, useToast } from '../../components/Toast'
import { IconButton } from '../../components/IconButton'
import { BookMenu } from '../books/BookMenu'
import { useBook } from '../books/use-books'
import {
  useCreateVolume,
  useRemoveVolume,
  useReorderVolumes,
  useUpdateVolume,
  useVolumeList
} from '../books/use-volumes'
import { ChapterCatalog, type ChapterMenuAction, type ChapterPatch, type VolumeMenuAction } from './ChapterCatalog'
import { ChapterCreateModal, type ChapterCreateValues } from './ChapterCreateModal'
import { EditorInspector } from './EditorInspector'
import { ChapterHistoryModal } from './ChapterHistoryModal'
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
import { useExportChapter, useExportVolume } from './use-exporter'
import {
  useChapter,
  useChapterList,
  useCreateChapter,
  useRemoveChapter,
  useReorderChapters,
  useSaveChapterContent,
  useUpdateChapter
} from './use-chapters'

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
 * 书籍工作台 —— 打开一本书之后的那一页，也是全应用唯一编辑正文的地方。
 *
 * 用户 2026-09-20 把「打开书籍」的落点整个改了：「新建书籍并且打开书籍之后
 * 应该是正文编辑页，不应该出现这个统计界面，而且卷和章节还分开了。打开书籍后
 * 直接就是正文编辑界面，左侧可以新建卷和章节，底部才是统计信息该出现的地方。」
 *
 * 所以这一页承担了原来两页的职责，分工按「离正文的远近」重排：
 *   - **左侧 184px**：这本书的卷与章（一棵树，卷与章在同一棵树里，不再各占
 *     一张卡片）、切书、新建卷章、以及卷章的事后修改（右键菜单）。
 *   - **中间**：正文。这一页存在的理由。
 *   - **底部 34px**：统计信息 —— 计划 / 纠错 / 本章字数，右侧补全书总量与
 *     目标进度（原先那四张概览卡的内容）。
 *
 * 路由因此有两种进入方式，都落在这一页：
 *   - `/books/:bookId/chapters/:chapterId` —— 打开指定的一章；
 *   - `/books/:bookId` —— 打开一本书。有章节时**跳到最近动过的那一章**
 *     （replace 不留历史记录），因为「打开书」在写作软件里的意思几乎总是
 *     「接着上次写」；没有章节时留在原地，显示空状态。
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
  const params = useParams<{ bookId: string; chapterId?: string }>()
  const bookId = Number(params.bookId)
  /*
   * `chapterId` 可以为空：路由 `/books/:bookId`（刚建完书、还没写第一章）
   * 也渲染这一页。用 null 而不是 NaN 当「没有章节」的表示，是因为下面所有
   * 需要章节 id 的调用（useChapter / useWritingSession / 保存）都收
   * `number | null`，NaN 会一路混进查询键与接口入参里。
   */
  const chapterId = params.chapterId === undefined ? null : Number(params.chapterId)
  const hasChapter = chapterId !== null && Number.isFinite(chapterId) && chapterId > 0

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { notifySuccess, notifyError } = useToast()
  const confirm = useConfirm()

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
  const removeChapter = useRemoveChapter()
  const reorderChapters = useReorderChapters()
  const exportChapter = useExportChapter()
  const createVolume = useCreateVolume()
  const updateVolume = useUpdateVolume()
  const removeVolume = useRemoveVolume()
  const reorderVolumes = useReorderVolumes()
  const exportVolume = useExportVolume()

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
  /**
   * 历史版本弹窗是否打开。
   *
   * 单独一个 state 而不是塞进 `InspectorView`：那个类型描述的是**右栏**
   * 里的视图，而这个弹窗与右栏无关。混在一起会让「点竖栏切换视图」
   * 与「开历史弹窗」互相覆盖对方的显隐。
   */
  const [historyOpen, setHistoryOpen] = useState(false)
  /**
   * 回档后用来强制重建编辑器的令牌。
   *
   * 编辑器自己管正文（`RichTextEditor` 只在 `chapterKey` 变化时重建），
   * 因此「服务端的正文变了」这件事它感觉不到。页码 +1 即可让它重建，
   * 用 `${chapterId}:${restoreToken}` 作 key 才不会误伤正常的切章。
   */
  const [restoreToken, setRestoreToken] = useState(0)
  const [creating, setCreating] = useState(false)
  /** 分卷弹窗的提交中态（建卷 / 改名共用，弹窗在目录栏里） */
  const [volumeSaving, setVolumeSaving] = useState(false)
  /*
   * 「新建章」弹窗由**页面**持有，不再由目录栏持有：空书打开时正文区中央的
   * 那枚「新建第一章」也要打开同一个弹窗（用户 2026-09-20：「打开书籍后直接
   * 就是正文编辑界面」），而它渲染在目录栏外面。两个入口共用一份状态，
   * 才不会出现「两个弹窗各记一份、关掉一个另一个还开着」。
   */
  const [chapterModalOpen, setChapterModalOpen] = useState(false)

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

  /**
   * 回档成功后把编辑器里的正文换成历史那一版。
   *
   * 三件事缺一不可：
   *  1. **清空待保存队列**。回档前的正文已经在服务端留成一版历史了，
   *     若此时 `pendingRef` 里还压着一段自动保存没发出去，它会在
   *     两秒后把刚刚回档掉的正文又覆盖回去 —— 表现是「点了回档，
   *     过一会儿内容自己变回来了」。
   *  2. `lastSavedRef` 同步成回档后的正文，否则下一次 flush 会认为
   *     「和上次保存的不一样」而白写一次。
   *  3. `restoreToken` +1 让编辑器重建并载入新正文。
   *
   * 详情缓存由 `useRestoreChapterRevision` 负责写回，这里只管页面状态。
   */
  const handleRestored = useCallback((contentHtml: string): void => {
    pendingRef.current = null
    lastSavedRef.current = contentHtml
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setSaveState('saved')
    setRestoreToken((value) => value + 1)
    notifySuccess('已回到所选版本')
  }, [notifySuccess])

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
      // 没有章节就没有正文可存。编辑器只在有章节时挂载，这里只是把类型收窄
      if (chapterId === null) return
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
    if (chapterId === null || !meta) return
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
   * 新建一章。返回值是「有没有真的建成」，给弹窗决定关不关 ——
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
        // 建成了才关弹窗。留在原地（这是之前的实际行为）会让作者看到
        // 「弹窗还在、后面的章节其实已经建好了」，第一反应是「没成功吧」
        // 再点一次 —— 于是建出两章同名。
        setChapterModalOpen(false)
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

  /**
   * 新建分卷。返回是否真的建成了。
   *
   * 这一段以前是「提示用户先去书籍详情页建卷，然后把他送过去」—— 那是
   * 目录栏还没有分卷管理时的临时办法。用户 2026-09-20 明确要求「左侧可以
   * 新建卷和章节」，而书籍详情页整个不存在了，所以这里必须真的建出来。
   */
  const handleCreateVolume = useCallback(
    async (title: string): Promise<boolean> => {
      setVolumeSaving(true)
      try {
        await createVolume.mutateAsync({ bookId, title, summary: '' })
        notifySuccess(`已新建分卷「${title}」`)
        return true
      } catch (error) {
        notifyError(toErrorMessage(error))
        return false
      } finally {
        setVolumeSaving(false)
      }
    },
    [bookId, createVolume, notifyError, notifySuccess]
  )

  const handleRenameVolume = useCallback(
    async (volume: VolumeListItem, title: string): Promise<boolean> => {
      setVolumeSaving(true)
      try {
        await updateVolume.mutateAsync({ id: volume.id, title, summary: volume.summary })
        notifySuccess(`分卷已改名为「${title}」`)
        return true
      } catch (error) {
        notifyError(toErrorMessage(error))
        return false
      } finally {
        setVolumeSaving(false)
      }
    },
    [notifyError, notifySuccess, updateVolume]
  )

  /**
   * 分卷行右键菜单的动作。
   *
   * 重排提交**完整的顺序数组**（见 volumes.ts 的说明）：界面上是「一次一格」，
   * 但底下必须是原子的全量提交，否则并发两次上移会互相覆盖。
   */
  const handleVolumeAction = useCallback(
    (volume: VolumeListItem, action: VolumeMenuAction): void => {
      const ids = (volumeList.data ?? []).map((item) => item.id)

      if (action === 'up' || action === 'down') {
        const index = ids.indexOf(volume.id)
        const target = index + (action === 'up' ? -1 : 1)
        if (index === -1 || target < 0 || target >= ids.length) return

        const next = [...ids]
        next[index] = ids[target]
        next[target] = volume.id

        void reorderVolumes
          .mutateAsync({ bookId, orderedIds: next })
          .catch((error: unknown) => notifyError(toErrorMessage(error)))
        return
      }

      if (action === 'export') {
        void exportVolume
          .mutateAsync({ volumeId: volume.id, format: 'txt' })
          .then((result) => {
            if (!result.canceled) notifySuccess(`已导出「${volume.title}」（${result.chapterCount} 章）`)
          })
          .catch((error: unknown) => notifyError(toErrorMessage(error)))
        return
      }

      if (action === 'remove') {
        void confirm({
          title: `删除分卷「${volume.title}」？`,
          description: `卷下的 ${volume.chapterCount} 章不会被删除，会退回「未分卷」。`,
          okText: '删除分卷',
          danger: true
        }).then((ok) => {
          if (!ok) return
          void removeVolume
            .mutateAsync({ id: volume.id })
            .then(() => notifySuccess('分卷已删除，卷下章节已退回未分卷'))
            .catch((error: unknown) => notifyError(toErrorMessage(error)))
        })
      }
    },
    [
      bookId,
      confirm,
      exportVolume,
      notifyError,
      notifySuccess,
      reorderVolumes,
      removeVolume,
      volumeList.data
    ]
  )

  /**
   * 章节行右键菜单里的上移 / 下移 / 删除。
   *
   * 顺序的最小单位是**同一个容器内**（某一卷内、或「未分卷」里），不是全书 ——
   * 跨卷重排既没有意义（卷之间已经是另一个层级），也会把两卷的章节混到一起。
   */
  const handleChapterAction = useCallback(
    (chapter: ChapterListItem, action: ChapterMenuAction): void => {
      const key = chapter.volumeId === null ? 'loose' : String(chapter.volumeId)
      const ids = (chapterList.data ?? [])
        .filter((item) => (item.volumeId === null ? 'loose' : String(item.volumeId)) === key)
        .map((item) => item.id)

      if (action === 'up' || action === 'down') {
        const index = ids.indexOf(chapter.id)
        const target = index + (action === 'up' ? -1 : 1)
        if (index === -1 || target < 0 || target >= ids.length) return

        const next = [...ids]
        next[index] = ids[target]
        next[target] = chapter.id

        void reorderChapters
          .mutateAsync({ bookId, volumeId: chapter.volumeId, orderedIds: next })
          .catch((error: unknown) => notifyError(toErrorMessage(error)))
        return
      }

      void confirm({
        title: `删除「${chapter.title}」？`,
        // 第三期第 5 件起删除只是移到回收站，文案必须跟着改：
        // 说「无法恢复」会让用户不敢删，也让他事后不会去回收站找。
        // 这一章的历史版本也一并留着，恢复之后还在。
        description: '正文与它的历史版本会一起移入回收站，之后可以在回收站里恢复。写作记录会保留。',
        okText: '移到回收站',
        danger: true
      }).then((ok) => {
        if (!ok) return
        void removeChapter
          .mutateAsync({ id: chapter.id })
          .then(() => {
            notifySuccess(`「${chapter.title}」已移到回收站`)
            /*
             * 删掉的正好是正在编辑的那一章时，要把 URL 挪走：留在
             * `/chapters/<已删 id>` 上会一直查一个不存在的章，正文区
             * 卡在错误态。挪到「这本书」的地址上，由页面自己决定去哪
             * （还有别的章 → 跳到最近写过的；没有了 → 空状态）。
             */
            if (chapter.id === chapterId) void navigate(`/books/${bookId}`)
          })
          .catch((error: unknown) => notifyError(toErrorMessage(error)))
      })
    },
    [
      bookId,
      chapterId,
      chapterList.data,
      confirm,
      navigate,
      notifyError,
      notifySuccess,
      removeChapter,
      reorderChapters
    ]
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
   * 「打开一本书」的落点
   * ------------------------------------------------------------------ */

  /**
   * 没指定章节时，应当自动打开哪一章。
   *
   * 取**最近动过的那一章**（updatedAt 最新），因为「打开一本书」在写作软件里的
   * 意思几乎总是「接着上次写」。null 表示「这本书还没有章节」——那是新书第一次
   * 被打开时的样子，此时留在原地显示空状态，不能凭空建一个空章节出来
   * （作者还没想好它叫什么）。
   *
   * `chapterList.data === undefined`（还在加载）时也返回 null：那一刻返回
   * 「没有章节」，页面会先显示空状态再跳走，闪一下。所以下面渲染时还有一个
   * 「列表还没回来就只显示骨架」的判据。
   */
  const resumeChapterId = useMemo(() => {
    if (hasChapter) return null
    const items = chapterList.data
    if (!items || items.length === 0) return null
    // 与列表排序同一口径（localeCompare），不另算一份时间戳 —— 两种口径
    // 迟早会在某一条 iso 字符串上给出不同答案
    return items.reduce((best, item) =>
      item.updatedAt.localeCompare(best.updatedAt) > 0 ? item : best
    ).id
  }, [chapterList.data, hasChapter])

  /* ------------------------------------------------------------------ *
   * 新建章弹窗：入口有两个（目录栏头部、空书中央），弹窗只有一份
   * ------------------------------------------------------------------ */

  /**
   * 新建章时默认落在哪一卷：用「当前正在编辑的那一章所属的卷」，而不是
   * 「最后一卷」。作者通常是在连续写同一卷的内容，新建时把它放进当前卷
   * 是常见的期待。当前没有章节时退回未分卷，由作者在弹窗里自行归置。
   */
  const defaultVolumeId = useMemo(() => {
    const items = chapterList.data
    if (!items || chapterId === null) return null
    return items.find((item) => item.id === chapterId)?.volumeId ?? null
  }, [chapterId, chapterList.data])

  /** 预填标题：「第 N 章」。作者连着往下写时多半就是这个，不必手打 */
  const suggestTitle = `第 ${(chapterList.data ?? []).length + 1} 章`

  /* ------------------------------------------------------------------ *
   * 底栏的书籍总量
   * ------------------------------------------------------------------ */

  // 全书汉字取「各章汉字之和」而不是书籍列表项里的聚合字段：底栏要能在
  // 删改章节后立刻反映最新进度，而列表项的聚合是缓存的
  const bookHanzi = useMemo(
    () => (chapterList.data ?? []).reduce((sum, item) => sum + item.hanziCount, 0),
    [chapterList.data]
  )

  // 目标进度用「各章汉字之和 / 书籍目标字数」。同一个口径也算一次章节列表——
  // 底栏右边那一组数字必须同时到齐，取两个来源的话会出现「章节数已更新、
  // 进度还是旧的」这种半新半旧的一帧
  const bookPercent = useMemo(
    () => progressPercent(bookHanzi, book.data?.targetWords ?? 0),
    [book.data?.targetWords, bookHanzi]
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
    // 没有章节就没有草稿可导（按钮也只在有章节时渲染，这里是类型收窄）
    if (chapterId === null) return
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
      <Flex vertical gap={16} className="page" align="flex-start">
        <Text>章节加载失败。</Text>
        <IconButton label="返回书籍" icon={<LeftOutlined />} onClick={() => void navigate(`/books/${bookId}`)} />
      </Flex>
    )
  }

  /*
   * 「打开一本书」→ 接着上次写的那一章。
   *
   * 判据是「章节列表已经回来了」而不是「有章节」：列表还在加载时
   * `resumeChapterId` 也是 null，若此刻就渲染页面，会先闪一下空状态
   * （「这本书还没有章节」+ 一枚新建入口），再跳走 —— 而作者看到的是
   * 「我的书怎么空了」。宁可就地等一下。
   *
   * replace 而不是 push：否则从「继续写作」进来再按后退，会回到
   * `/books/3`，然后又被弹回来 —— 用户会被卡在这个循环里出不去。
   */
  if (resumeChapterId !== null) {
    return <Navigate replace to={`/books/${bookId}/chapters/${resumeChapterId}`} />
  }

  const ready = chapter.data !== undefined && meta !== null
  /** 目录与正文都等这一件事：这本书的章节列表回来了没有 */
  const listReady = chapterList.data !== undefined

  /*
   * 编辑器的重建键。平时就是章节 id；回档后带上令牌，
   * 于是「同一章但正文换了一份」也能触发重建（见 handleRestored）。
   * 用字符串而不是数字 token 单独做 key，是为了让切章与回档共用一个 prop，
   * 免得 RichTextEditor 要多理解一个概念。
   */
  const restoreKey = `${chapterId ?? 0}:${restoreToken}`

  return (
    <div className={`editor-page${focusMode ? ' editor-page--focus' : ''}`}>
      {/* ---------------- 顶栏 ---------------- */}
      <header className="editor-topbar">
        <Flex align="center" gap={8} className="editor-topbar__left">
          <IconButton
            label="返回书架"
            icon={<ArrowLeftOutlined />}
            data-testid="editor-back"
            onClick={() => {
              void flushRef.current()
              /*
               * 回书架，不是回「书籍详情页」—— 那一页已经不存在了
               * （用户 2026-09-20 取消了它）。回首页那一层才是有去有回。
               */
              void navigate('/books')
            }}
          />
          <Text className="editor-topbar__book" ellipsis>
            {book.data?.title ?? '…'}
          </Text>
          {meta === null ? null : (
            <>
              <Text type="secondary">/</Text>
              <Text className="editor-topbar__chapter" ellipsis>
                {meta.title === '' ? '未命名章节' : meta.title}
              </Text>
            </>
          )}
        </Flex>

        {/*
          四枚圆形图标按钮（用户 2026-09-20：「各个界面中的图标也要跟着改」）。
          改造前它们是四个「图标 + 文字」按钮，一共占掉 300px 宽 —— 而这一条
          顶栏的高度是写死的 46px，宽的那一排把书名与章节名挤到只剩省略号。
          文字移进提示后，标题终于有地方显示了。

          第五枚是 `…` 书籍菜单（编辑信息 / 导出整本 / 删除书籍）：这是原来
          「书籍详情页」的头部操作，用户取消那一页之后它们只能落在这里 ——
          与顶栏 `…` 同一种摆法（见 BookMenu）。

          查找 / 取名 / 专注 / 发布草稿这四枚**只在有章节时出现**：空书里
          没有正文可查、可取名、可导出，摆着只是四个点了没反应的圆球。
        */}
        <Flex align="center" gap={4}>
          {hasChapter ? (
            <>
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
                {/*
                  历史版本：入口放在顶栏，弹窗里给差异对比整幅宽度。
                  理由见 ChapterHistoryModal 顶部那段注释 —— 一句话是
                  「半模态的横条让『拿旧文对照正文』这件事只做了一半」。
                  打开前先落盘，否则弹窗里列出的「当前正文」与右边一栏
                  比对的还是上一次保存时的内容，会自己跟自己不同。
                */}
              <IconButton
                label="历史版本：查看并回到之前保存的正文"
                icon={<HistoryOutlined />}
                data-testid="editor-history"
                onClick={() => {
                  void flushRef.current()
                  setHistoryOpen((value) => !value)
                }}
              />
              <IconButton
                label="发布草稿（把本章导出为 .txt 草稿文件）"
                tone="primary"
                icon={<CloudUploadOutlined />}
                data-testid="editor-export"
                loading={exportChapter.isPending}
                onClick={() => void handleExport()}
              />
            </>
          ) : null}
          {book.data === undefined ? null : (
            <BookMenu book={book.data} chapterCount={chapterList.data?.length ?? 0} />
          )}
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
            onOpenChapterModal={() => setChapterModalOpen(true)}
            onCreateVolume={handleCreateVolume}
            onRenameVolume={handleRenameVolume}
            onVolumeAction={handleVolumeAction}
            onChapterAction={handleChapterAction}
            onPatchChapter={(target, patch) => void handlePatchChapter(target, patch)}
            onSelectChapter={goToChapter}
            onSwitchBook={(id) => {
              void flushRef.current()
              void navigate(`/books/${id}`)
            }}
            savingTitle={volumeSaving}
          />
        )}

        <div className="editor-main">
          {hasChapter ? (
            !ready || meta === null ? (
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
                  chapterKey={restoreKey}
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
            )
          ) : (
            <EmptyBookState
              loading={!listReady}
              summary={book.data?.summary ?? ''}
              onCreate={() => setChapterModalOpen(true)}
            />
          )}
        </div>

        {focusMode ? null : (
          <EditorInspector
            bookId={bookId}
            chapterId={chapterId}
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
      {/*
        底栏 = 统计信息该出现的地方（用户 2026-09-20：「底部才是统计信息该出现
        的地方」）。原先这套数字长在「书籍详情页」顶部的四张概览卡上 —— 那一页
        已经取消，但它们本身有用，所以收进这条 34px 的带子里：

          - 左侧是**本章**的三项（计划 / 纠错 / 本章字数）+ 保存状态，
            只在有章节时出现；
          - 右侧是**全书**的总量与目标进度（分卷数 / 章节数 / 全书汉字 /
            目标进度），任何时候都在 —— 空书里左侧什么都没有，右侧那几项
            就是屏幕上唯一的统计事实。

        不把左侧那三项也做成图标按钮：它们是**读数**不是操作，而底栏是全程
        要瞟的带子，图标化只会让每个数字都要先猜一遍图标什么意思。
      */}
      <footer className="editor-statusbar">
        <Flex align="center" gap={16} className="editor-statusbar__stats">
          {hasChapter ? (
            <>
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
            </>
          ) : (
            <Text type="secondary" className="editor-statusbar__item">
              左侧目录可新建分卷与章节；章节写起来之后这里显示计划、纠错与本章字数。
            </Text>
          )}
        </Flex>

        {/* 全书统计。data-* 是给冒烟测试读的：这几个数字是「底部统计」的全部内容，
            只读文案的话，「全书汉字取的是缓存里的聚合字段」这类错会被漏掉 */}
        <Flex align="center" gap={14} className="editor-statusbar__book">
          <Text
            type="secondary"
            className="editor-statusbar__item"
            data-testid="editor-book-volumes"
            data-value={volumeList.data?.length ?? 0}
          >
            分卷 {volumeList.data?.length ?? 0}
          </Text>
          <Text
            type="secondary"
            className="editor-statusbar__item"
            data-testid="editor-book-chapters"
            data-value={chapterList.data?.length ?? 0}
          >
            章节 {chapterList.data?.length ?? 0}
          </Text>
          <Text
            className="editor-statusbar__item editor-statusbar__item--strong"
            data-testid="editor-book-hanzi"
            data-value={bookHanzi}
          >
            全书 {formatCount(bookHanzi)}
          </Text>
          {bookPercent === null ? (
            <Text type="secondary" className="editor-statusbar__item" data-testid="editor-book-progress">
              目标未设
            </Text>
          ) : (
            <Text
              type="secondary"
              className="editor-statusbar__item"
              data-testid="editor-book-progress"
              data-value={bookPercent}
            >
              目标 {bookPercent}%
              {book.data === undefined
                ? ''
                : `（${formatCompact(bookHanzi)} / ${formatCompact(book.data.targetWords)}）`}
            </Text>
          )}
        </Flex>
      </footer>

      <NameDialog open={nameOpen} onClose={() => setNameOpen(false)} onInsert={insertName} />

      {/*
        历史版本是弹窗（用户 2026-09-22：「历史版本对比界面做成弹窗的形式」），
        所以它挂在这里、和另外两个弹窗排在一起，而不是长在正文区里 ——
        `Modal` 自己会渲染到 body 上的浮层，写在哪儿都不影响它画在哪儿，
        但「三个弹窗在同一处」能让下一个人一眼看清这一页有几个浮层。
      */}
      {historyOpen && hasChapter && chapterId !== null ? (
        <ChapterHistoryModal
          chapterId={chapterId}
          currentText={doc?.text ?? ''}
          onRestore={handleRestored}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      <ChapterCreateModal
        open={chapterModalOpen}
        volumes={volumeList.data ?? []}
        defaultVolumeId={defaultVolumeId}
        suggestTitle={suggestTitle}
        chapterWords={book.data?.chapterWords ?? 0}
        submitting={creating}
        onSubmit={handleCreateChapter}
        onCancel={() => setChapterModalOpen(false)}
      />
    </div>
  )
}

/**
 * 空书：这本书一章都还没有。
 *
 * 用户 2026-09-20：「新建书籍并且打开书籍之后应该是正文编辑页……打开书籍后
 * 直接就是正文编辑界面，左侧可以新建卷和章节」。所以这一屏的形状是
 * **编辑器本身**（顶栏 + 左侧目录 + 底栏统计都在），只有中间那块正文区
 * 是空的 —— 而不是一张另起的「欢迎页」。
 *
 * 中央那枚入口按全应用空状态的规矩做成 40px 实底正圆 + 悬浮提示
 * （见 `checkEmptyZones`）：它是这一屏唯一有内容的地方，四周是空白、
 * 没有对齐对象，用基础规格才像「一块可以点的地方」。
 * 挂在 `data-empty-zone` / `data-empty-create` 上，冒烟按区块采。
 */
function EmptyBookState({
  loading,
  summary,
  onCreate
}: {
  loading: boolean
  summary: string
  onCreate: () => void
}) {
  if (loading) {
    return (
      <div className="editor-main__loading">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    )
  }

  return (
    <div className="editor-main__empty">
      {summary.length > 0 ? (
        <Text type="secondary" className="editor-main__empty-summary">
          {summary}
        </Text>
      ) : null}
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        data-empty-zone="editor-book"
        description={
          <Flex vertical gap={10} align="center">
            <Text type="secondary">这本书还没有章节</Text>
            <IconButton
              label="新建第一章"
              tone="primary"
              large
              icon={<PlusOutlined />}
              data-testid="editor-empty-create"
              data-empty-create="editor-book"
              tipTestId="editor-empty-create-tip"
              onClick={onCreate}
            />
          </Flex>
        }
      />
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
  /*
   * `data-value` 是给冒烟的锚点：状态文案里带着「N 分钟前」这种相对时间，
   * 断言没法对文案做相等匹配；原始状态值（saved/saving/error）才可断。
   */
  if (state === 'saving') {
    return (
      <Text type="secondary" className="editor-statusbar__item" data-testid="editor-save-state" data-value="saving">
        保存中…
      </Text>
    )
  }

  if (state === 'error') {
    return (
      <Text type="danger" className="editor-statusbar__item" data-testid="editor-save-state" data-value="error">
        <ExclamationCircleOutlined /> 保存失败，将自动重试
      </Text>
    )
  }

  return (
    <Text type="secondary" className="editor-statusbar__item" data-testid="editor-save-state" data-value="saved">
      <CheckCircleOutlined /> {savedAt ? `已保存 ${formatRelativeTime(savedAt)}` : '自动保存已开启'}
    </Text>
  )
}

/** 把任意异常转成可展示文案。ApiError 的场景化前缀由调用方加 */
function toErrorMessage(error: unknown): string {
  return toUserMessage(error)
}
