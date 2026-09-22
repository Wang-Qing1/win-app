import type { IpcResponse } from './result'
import type {
  Book,
  BookCreateInput,
  BookIdInput,
  BookListQuery,
  BookListResult,
  BookRemovalResult,
  BookStats,
  BookUpdateInput
} from './modules/books'
import type {
  Chapter,
  ChapterCreateInput,
  ChapterIdInput,
  ChapterListItem,
  ChapterListQuery,
  ChapterMoveInput,
  ChapterReorderInput,
  ChapterRestoreInput,
  ChapterRestoreResult,
  ChapterRevision,
  ChapterRevisionIdInput,
  ChapterRevisionListInput,
  ChapterRevisionSummary,
  ChapterSaveContentInput,
  ChapterSaveResult,
  ChapterUpdateInput
} from './modules/chapters'
import type {
  Card,
  CardIdInput,
  CardListQuery,
  CardListResult,
  CardRemovalResult,
  CardCreateInput,
  CardTimelineOrderInput,
  CardUpdateInput
} from './modules/cards'
import type {
  CardChapterLink,
  CardLinkCardInput,
  CardLinkChapterInput,
  CardLinkNodeInput,
  CardLinkNodePairInput,
  CardLinkPairInput,
  CardOutlineLink,
  CardRelation,
  CardRelationBookInput,
  CardRelationEdge,
  CardRelationPairInput,
  CardRelationUnpairInput,
  OutlineCardRef,
  ChapterCardRef
} from './modules/card-links'
import type {
  OutlineAttachChapterInput,
  OutlineMaterializeInput,
  OutlineMaterializeResult,
  OutlineNode,
  OutlineNodeCreateInput,
  OutlineNodeIdInput,
  OutlineNodeMoveInput,
  OutlineNodeUpdateInput,
  OutlineTreeQueryInput,
  OutlineTreeResult
} from './modules/outline'
import type { SearchQueryInput, SearchResult } from './modules/search'
import type {
  SessionFinishInput,
  SessionListQuery,
  WritingSession
} from './modules/sessions'
import type { ExportBatchResult, ExportBookInput, ExportChapterInput, ExportChapterResult, ExportVolumeInput } from './modules/exporter'
import type { BackupDatabaseResult } from './modules/backup'
import type {
  BookProgressItem,
  BookProgressQuery,
  HeatmapResult,
  OverviewStats,
  StatsHeatmapQueryInput,
  StatsTrendQuery,
  TrendResult
} from './modules/stats'
import type {
  VolumeCreateInput,
  VolumeIdInput,
  VolumeListItem,
  VolumeReorderInput,
  VolumeUpdateInput
} from './modules/volumes'
import type {
  TrashEmptyInput,
  TrashEmptyResult,
  TrashItemInput,
  TrashItemRef,
  TrashListInput,
  TrashListResult
} from './modules/trash'

/**
 * preload 通过 contextBridge 暴露给渲染进程的 API 形状。
 *
 * 该接口被 preload 实现、被渲染进程消费，两侧共用一份定义：
 * 主进程改接口时渲染进程会直接编译失败，而不是运行时才报错。
 *
 * 注意：所有方法返回的都是 IpcResponse 信封而不是直接抛异常。
 * 跨 contextBridge 传递 Error 实例语义不可靠，统一由渲染进程的
 * api-client 负责拆信封并抛出类型化的 ApiError。
 */

export interface RuntimeInfo {
  appName: string
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  v8Version: string
  platform: string
  arch: string
  isPackaged: boolean
  locale: string
}

export interface DatabaseInfo {
  file: string
  sizeBytes: number
  journalMode: string
  schemaVersion: string | null
  bookCount: number
  chapterCount: number
}

export interface HealthStatus {
  status: 'ok'
  uptimeSeconds: number
  runtime: RuntimeInfo
  database: DatabaseInfo
}

export interface ReadinessCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ReadinessStatus {
  ready: boolean
  checks: ReadinessCheck[]
}

export interface WinbookApi {
  readonly version: string

  health: {
    ping: () => Promise<IpcResponse<HealthStatus>>
    ready: () => Promise<IpcResponse<ReadinessStatus>>
  }

  books: {
    list: (query: Partial<BookListQuery>) => Promise<IpcResponse<BookListResult>>
    get: (input: BookIdInput) => Promise<IpcResponse<Book>>
    create: (input: BookCreateInput) => Promise<IpcResponse<Book>>
    update: (input: BookUpdateInput) => Promise<IpcResponse<Book>>
    remove: (input: BookIdInput) => Promise<IpcResponse<BookRemovalResult>>
    stats: () => Promise<IpcResponse<BookStats>>
  }

  volumes: {
    /** 按书籍查分卷（含每卷的章节数与字数），顺带返回未分卷章节数 */
    list: (input: { bookId: number }) => Promise<IpcResponse<VolumeListItem[]>>
    create: (input: VolumeCreateInput) => Promise<IpcResponse<VolumeListItem>>
    update: (input: VolumeUpdateInput) => Promise<IpcResponse<VolumeListItem>>
    remove: (input: VolumeIdInput) => Promise<IpcResponse<{ id: number; detachedChapters: number }>>
    reorder: (input: VolumeReorderInput) => Promise<IpcResponse<{ bookId: number }>>
  }

  chapters: {
    list: (query: ChapterListQuery) => Promise<IpcResponse<ChapterListItem[]>>
    get: (input: ChapterIdInput) => Promise<IpcResponse<Chapter>>
    create: (input: ChapterCreateInput) => Promise<IpcResponse<ChapterListItem>>
    update: (input: ChapterUpdateInput) => Promise<IpcResponse<ChapterListItem>>
    saveContent: (input: ChapterSaveContentInput) => Promise<IpcResponse<ChapterSaveResult>>
    remove: (input: ChapterIdInput) => Promise<IpcResponse<{ id: number }>>
    reorder: (input: ChapterReorderInput) => Promise<IpcResponse<{ count: number }>>
    move: (input: ChapterMoveInput) => Promise<IpcResponse<ChapterListItem>>

    /*
     * 历史版本。列表刻意**不带正文** —— 与 chapters:list 同一个理由：
     * 一章可能留着 50 版，每版都是几十 KB 的 HTML，列表拉全量等于
     * 开一次历史面板就传几 MB。字数与增减足够让作者认出「哪一版」。
     */
    listRevisions: (input: ChapterRevisionListInput) => Promise<IpcResponse<ChapterRevisionSummary[]>>
    getRevision: (input: ChapterRevisionIdInput) => Promise<IpcResponse<ChapterRevision>>
    /** 回档。执行前会把当前正文也留一版，因此回档本身可以再回档 */
    restoreRevision: (input: ChapterRestoreInput) => Promise<IpcResponse<ChapterRestoreResult>>
  }

  outline: {
    /** 取整棵树（节点数在千级以内，一次取完比逐层懒加载简单得多） */
    tree: (query: OutlineTreeQueryInput) => Promise<IpcResponse<OutlineTreeResult>>
    create: (input: OutlineNodeCreateInput) => Promise<IpcResponse<OutlineNode>>
    update: (input: OutlineNodeUpdateInput) => Promise<IpcResponse<OutlineNode>>
    remove: (input: OutlineNodeIdInput) => Promise<IpcResponse<{ id: number; removedCount: number }>>
    /** 拖拽落点：目标父节点 + 落点下标，顺序由主进程算 */
    move: (input: OutlineNodeMoveInput) => Promise<IpcResponse<OutlineNode>>
    /** 关联 / 解除关联已有章节；chapterId 传 null 表示解除 */
    attachChapter: (input: OutlineAttachChapterInput) => Promise<IpcResponse<OutlineNode>>
    /** 落地成新章节：建章 + 关联，一步到位 */
    materialize: (input: OutlineMaterializeInput) => Promise<IpcResponse<OutlineMaterializeResult>>
  }

  cards: {
    /**
     * 卡片列表。刻意**连正文一起返回** —— 这与 chapters:list 的做法相反，
     * 原因是量级差着好几个数量级：一张卡片的正文上限 5000 字符、
     * 一页 60 张，最坏也就 300KB 的本地 IPC 载荷；换来的是点开一张卡片
     * 不用再发一次请求、也不会在切换时闪一下空表单。
     */
    list: (query: CardListQuery) => Promise<IpcResponse<CardListResult>>
    create: (input: CardCreateInput) => Promise<IpcResponse<Card>>
    update: (input: CardUpdateInput) => Promise<IpcResponse<Card>>
    remove: (input: CardIdInput) => Promise<IpcResponse<CardRemovalResult>>
    /** 复制一张卡片作为变体：标题自动加「副本」后缀并避开重名 */
    duplicate: (input: CardIdInput) => Promise<IpcResponse<Card>>

    /*
     * 与章节的关联。四个通道都**返回整份最新关联列表**而不是单个对象：
     * 界面拿到返回值直接替换本地状态即可，不必再发一次 list ——
     * 少一次往返，也少一处「点了关联、列表却没刷新」的时序问题。
     * 关联与解除都是幂等的（重复关联不报错、解除不存在的关联不报错），
     * 于是快速连点两下不会产生重复行，也不会弹出「关联已存在」。
     */
    linkChapter: (input: CardLinkPairInput) => Promise<IpcResponse<CardChapterLink[]>>
    unlinkChapter: (input: CardLinkPairInput) => Promise<IpcResponse<CardChapterLink[]>>
    /** 这张卡用在哪几章 */
    listLinks: (input: CardLinkCardInput) => Promise<IpcResponse<CardChapterLink[]>>
    /** 这一章用到了哪几张卡 */
    listByChapter: (input: CardLinkChapterInput) => Promise<IpcResponse<ChapterCardRef[]>>

    /**
     * 设定卡时间线重排。提交**整组**卡片的新顺序，返回重排后的卡片。
     *
     * 一次提交整组而不是「把 A 移到 B 后面」：后者依赖服务层当下的顺序，
     * 两端不一致时移动会错位；整组提交是幂等的。
     */
    setTimelineOrder: (
      input: CardTimelineOrderInput
    ) => Promise<IpcResponse<Card[]>>

    /* ---- 大纲节点侧（第三期）---- */

    linkNode: (input: CardLinkNodePairInput) => Promise<IpcResponse<CardOutlineLink[]>>
    unlinkNode: (input: CardLinkNodePairInput) => Promise<IpcResponse<CardOutlineLink[]>>
    /** 这张卡挂在哪些节点上 */
    listNodeLinks: (input: CardLinkCardInput) => Promise<IpcResponse<CardOutlineLink[]>>
    /** 这个节点用到了哪几张卡 */
    listByNode: (input: CardLinkNodeInput) => Promise<IpcResponse<OutlineCardRef[]>>

    /* ---- 卡片 ↔ 卡片（第三期第 3 件）----
     *
     * 关系没有方向：一条边的两头看到的是同一条边。
     * 因此建立 / 解除返回的是**被操作那一头**的列表，另一头由前端另失效一次。
     */

    /** 这张卡与哪些卡有关系 */
    listRelations: (input: CardLinkCardInput) => Promise<IpcResponse<CardRelation[]>>
    /** 这本书里所有的关系边，给关系网用 */
    listBookRelations: (input: CardRelationBookInput) => Promise<IpcResponse<CardRelationEdge[]>>
    /** 建立关系；同一对卡再建一次是**改关系名**，不会多出第二条边 */
    relate: (input: CardRelationPairInput) => Promise<IpcResponse<CardRelation[]>>
    unrelate: (input: CardRelationUnpairInput) => Promise<IpcResponse<CardRelation[]>>
  }

  search: {
    /**
     * 全库检索。一次调用跨四张表（章节正文 / 卡片 / 大纲 / 书籍信息），
     * 每组结果带上该来源的命中总数与截断标记。
     *
     * 只读，没有对应的写通道 —— 检索不产生任何副作用。
     */
    query: (input: SearchQueryInput) => Promise<IpcResponse<SearchResult>>
  }

  /**
   * 回收站。
   *
   * 删除卡片与章节时不再真的抹掉数据，只是打一个 `deleted_at` 时间戳，
   * 于是三个动作有了意义：列出来、捞回来、真的抹掉。
   *
   * 刻意**不提供** `cards.trash` / `chapters.trash` 这类分实体入口：
   * 回收站是一个混排的列表（作者找的是「我刚才误删的那个」，
   * 未必记得它是卡片还是章节），分实体就意味着界面要先把两个列表
   * 拼起来再自己排序 —— 而排序规则一分为二，时序问题随之而来。
   */
  trash: {
    list: (input: Partial<TrashListInput>) => Promise<IpcResponse<TrashListResult>>
    /** 恢复。恢复本身不产生历史版本，但会让列表 / 统计 / 关联重新取数 */
    restore: (input: TrashItemInput) => Promise<IpcResponse<TrashItemRef>>
    /** 彻底删除，不可撤销。关联与章节历史版本随外键一并消失 */
    purge: (input: TrashItemInput) => Promise<IpcResponse<TrashItemRef>>
    /** 清空回收站。kind 传 null 表示两种都清 */
    empty: (input: Partial<TrashEmptyInput>) => Promise<IpcResponse<TrashEmptyResult>>
  }

  sessions: {
    /** 结算一次写作会话，返回落库后的记录 */
    finish: (input: SessionFinishInput) => Promise<IpcResponse<WritingSession>>
    list: (query: Partial<SessionListQuery>) => Promise<IpcResponse<WritingSession[]>>
  }

  stats: {
    overview: () => Promise<IpcResponse<OverviewStats>>
    trend: (query: Partial<StatsTrendQuery>) => Promise<IpcResponse<TrendResult>>
    books: (query: Partial<BookProgressQuery>) => Promise<IpcResponse<BookProgressItem[]>>
    heatmap: (query: Partial<StatsHeatmapQueryInput>) => Promise<IpcResponse<HeatmapResult>>
  }

  exporter: {
    /** 弹出系统保存对话框，把一章正文写成 .txt / .md 草稿 */
    chapter: (input: ExportChapterInput) => Promise<IpcResponse<ExportChapterResult>>
    /** 把一本书的所有章节（含未分卷）按现行顺序拼成同一个草稿文件 */
    book: (input: ExportBookInput) => Promise<IpcResponse<ExportBatchResult>>
    /** 只拼接指定分卷下的章节 */
    volume: (input: ExportVolumeInput) => Promise<IpcResponse<ExportBatchResult>>
  }

  backup: {
    /** 弹出系统保存对话框，把当前数据库安全地备份为用户选定的一个文件（只备份，不支持从备份恢复） */
    database: () => Promise<IpcResponse<BackupDatabaseResult>>
  }
}

/** 渲染进程侧挂载点，preload 在 window 上注入 */
export const WINBOOK_BRIDGE_KEY = 'winbook' as const
