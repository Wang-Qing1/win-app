/**
 * IPC 通道名集中定义。
 * 主进程注册与 preload 调用都必须引用这里的常量，禁止出现裸字符串，
 * 否则改名时会静默产生「通道不存在」的运行时错误。
 */
export const IpcChannel = {
  HealthPing: 'health:ping',
  HealthReady: 'health:ready',

  /* ---------------- 书籍 ---------------- */
  BooksList: 'books:list',
  BooksGet: 'books:get',
  BooksCreate: 'books:create',
  BooksUpdate: 'books:update',
  BooksRemove: 'books:remove',
  BooksStats: 'books:stats',

  /* ---------------- 分卷 ---------------- */
  VolumesList: 'volumes:list',
  VolumesCreate: 'volumes:create',
  VolumesUpdate: 'volumes:update',
  VolumesRemove: 'volumes:remove',
  VolumesReorder: 'volumes:reorder',

  /* ---------------- 章节 ---------------- */
  ChaptersList: 'chapters:list',
  ChaptersGet: 'chapters:get',
  ChaptersCreate: 'chapters:create',
  ChaptersUpdate: 'chapters:update',
  ChaptersSaveContent: 'chapters:saveContent',
  ChaptersRemove: 'chapters:remove',
  ChaptersReorder: 'chapters:reorder',
  ChaptersMove: 'chapters:move',
  ChaptersListRevisions: 'chapters:list-revisions',
  ChaptersGetRevision: 'chapters:get-revision',
  ChaptersRestoreRevision: 'chapters:restore-revision',

  /* ---------------- 大纲（自由多层情节树） ---------------- */
  OutlineTree: 'outline:tree',
  OutlineCreate: 'outline:create',
  OutlineUpdate: 'outline:update',
  OutlineRemove: 'outline:remove',
  OutlineMove: 'outline:move',
  OutlineAttachChapter: 'outline:attachChapter',
  OutlineMaterialize: 'outline:materialize',

  /* ---------------- 卡片库（人物 / 物品 / 灵感，统一建模） ---------------- */
  CardsList: 'cards:list',
  CardsCreate: 'cards:create',
  CardsUpdate: 'cards:update',
  CardsRemove: 'cards:remove',
  CardsDuplicate: 'cards:duplicate',
  CardsLinkChapter: 'cards:link-chapter',
  CardsUnlinkChapter: 'cards:unlink-chapter',
  CardsListNodeLinks: 'cards:list-node-links',
  CardsListByNode: 'cards:list-by-node',
  CardsLinkNode: 'cards:link-node',
  CardsUnlinkNode: 'cards:unlink-node',
  CardsListLinks: 'cards:list-links',
  CardsListByChapter: 'cards:list-by-chapter',
  CardsSetTimelineOrder: 'cards:set-timeline-order',
  CardsListRelations: 'cards:list-relations',
  CardsListBookRelations: 'cards:list-book-relations',
  CardsRelate: 'cards:relate',
  CardsUnrelate: 'cards:unrelate',

  /* ---------------- 全库检索 ---------------- */
  SearchQuery: 'search:query',

  /* ---------------- 写作会话 ---------------- */
  SessionsFinish: 'sessions:finish',
  SessionsList: 'sessions:list',

  /* ---------------- 统计（只读聚合） ---------------- */
  StatsOverview: 'stats:overview',
  StatsTrend: 'stats:trend',
  StatsBooks: 'stats:books',
  StatsHeatmap: 'stats:heatmap',

  /* ---------------- 草稿导出 ---------------- */
  ExporterChapter: 'exporter:chapter',
  ExporterBook: 'exporter:book',
  ExporterVolume: 'exporter:volume',

  /* ---------------- 数据库备份 ---------------- */
  BackupDatabase: 'backup:database'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
