import { contextBridge, ipcRenderer } from 'electron'
import { WINBOOK_BRIDGE_KEY, type WinbookApi } from '@shared/api'
import { IpcChannel } from '@shared/ipc-channels'

/**
 * 桥接协议版本。
 * 渲染进程可以读它来判断自己是否跑在预期版本的宿主上，
 * 避免「壳是旧的、前端是新的」这种升级期错配。
 *
 * 2：联系人示例模块被小说助手模块取代，API 形状不兼容。
 * 3：新增大纲（自由多层情节树）模块。
 * 4：新增卡片库（人物 / 物品 / 灵感统一建模）模块。
 * 5：新增全库检索（章节正文 / 卡片 / 大纲 / 书籍信息，LIKE 扫描非 FTS5）。
 * 6：导出新增整本书/整卷批量导出（exporter.book / exporter.volume）。
 * 7：新增数据库备份（backup.database）。
 * 8：新增卡片 ↔ 章节关联（cards.linkChapter / unlinkChapter / listLinks / listByChapter）。
 * 9：新增卡片 ↔ 大纲节点关联（cards.linkNode / unlinkNode / listNodeLinks / listByNode）。
 * 10：新增设定卡时间线重排（cards.setTimelineOrder）。
 */
const BRIDGE_VERSION = '10'

/**
 * preload 是主进程与渲染进程之间唯一的通道。
 *
 * 这里只暴露一份显式白名单：没有 ipcRenderer 本体、没有任意通道调用能力、
 * 没有 Node API。渲染进程即使被注入了恶意脚本，也只能调用下面这几个方法。
 *
 * 所有方法返回 IpcResponse 信封（而不是抛异常）—— 跨 contextBridge 传递
 * Error 实例语义不可靠，拆信封与抛 ApiError 的职责放在渲染进程侧。
 */
const api: WinbookApi = {
  version: BRIDGE_VERSION,

  health: {
    ping: () => ipcRenderer.invoke(IpcChannel.HealthPing),
    ready: () => ipcRenderer.invoke(IpcChannel.HealthReady)
  },

  books: {
    list: (query) => ipcRenderer.invoke(IpcChannel.BooksList, query),
    get: (input) => ipcRenderer.invoke(IpcChannel.BooksGet, input),
    create: (input) => ipcRenderer.invoke(IpcChannel.BooksCreate, input),
    update: (input) => ipcRenderer.invoke(IpcChannel.BooksUpdate, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.BooksRemove, input),
    stats: () => ipcRenderer.invoke(IpcChannel.BooksStats)
  },

  volumes: {
    list: (input) => ipcRenderer.invoke(IpcChannel.VolumesList, input),
    create: (input) => ipcRenderer.invoke(IpcChannel.VolumesCreate, input),
    update: (input) => ipcRenderer.invoke(IpcChannel.VolumesUpdate, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.VolumesRemove, input),
    reorder: (input) => ipcRenderer.invoke(IpcChannel.VolumesReorder, input)
  },

  chapters: {
    list: (query) => ipcRenderer.invoke(IpcChannel.ChaptersList, query),
    get: (input) => ipcRenderer.invoke(IpcChannel.ChaptersGet, input),
    create: (input) => ipcRenderer.invoke(IpcChannel.ChaptersCreate, input),
    update: (input) => ipcRenderer.invoke(IpcChannel.ChaptersUpdate, input),
    saveContent: (input) => ipcRenderer.invoke(IpcChannel.ChaptersSaveContent, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.ChaptersRemove, input),
    reorder: (input) => ipcRenderer.invoke(IpcChannel.ChaptersReorder, input),
    move: (input) => ipcRenderer.invoke(IpcChannel.ChaptersMove, input)
  },

  outline: {
    tree: (query) => ipcRenderer.invoke(IpcChannel.OutlineTree, query),
    create: (input) => ipcRenderer.invoke(IpcChannel.OutlineCreate, input),
    update: (input) => ipcRenderer.invoke(IpcChannel.OutlineUpdate, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.OutlineRemove, input),
    move: (input) => ipcRenderer.invoke(IpcChannel.OutlineMove, input),
    attachChapter: (input) => ipcRenderer.invoke(IpcChannel.OutlineAttachChapter, input),
    materialize: (input) => ipcRenderer.invoke(IpcChannel.OutlineMaterialize, input)
  },

  cards: {
    list: (query) => ipcRenderer.invoke(IpcChannel.CardsList, query),
    create: (input) => ipcRenderer.invoke(IpcChannel.CardsCreate, input),
    update: (input) => ipcRenderer.invoke(IpcChannel.CardsUpdate, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.CardsRemove, input),
    duplicate: (input) => ipcRenderer.invoke(IpcChannel.CardsDuplicate, input),
    linkChapter: (input) => ipcRenderer.invoke(IpcChannel.CardsLinkChapter, input),
    unlinkChapter: (input) => ipcRenderer.invoke(IpcChannel.CardsUnlinkChapter, input),
    listLinks: (input) => ipcRenderer.invoke(IpcChannel.CardsListLinks, input),
    listByChapter: (input) => ipcRenderer.invoke(IpcChannel.CardsListByChapter, input),
    linkNode: (input) => ipcRenderer.invoke(IpcChannel.CardsLinkNode, input),
    unlinkNode: (input) => ipcRenderer.invoke(IpcChannel.CardsUnlinkNode, input),
    listNodeLinks: (input) => ipcRenderer.invoke(IpcChannel.CardsListNodeLinks, input),
    listByNode: (input) => ipcRenderer.invoke(IpcChannel.CardsListByNode, input),
    setTimelineOrder: (input) => ipcRenderer.invoke(IpcChannel.CardsSetTimelineOrder, input)
  },

  search: {
    query: (input) => ipcRenderer.invoke(IpcChannel.SearchQuery, input)
  },

  sessions: {
    finish: (input) => ipcRenderer.invoke(IpcChannel.SessionsFinish, input),
    list: (query) => ipcRenderer.invoke(IpcChannel.SessionsList, query)
  },

  stats: {
    overview: () => ipcRenderer.invoke(IpcChannel.StatsOverview),
    trend: (query) => ipcRenderer.invoke(IpcChannel.StatsTrend, query),
    books: (query) => ipcRenderer.invoke(IpcChannel.StatsBooks, query),
    heatmap: (query) => ipcRenderer.invoke(IpcChannel.StatsHeatmap, query)
  },

  exporter: {
    chapter: (input) => ipcRenderer.invoke(IpcChannel.ExporterChapter, input),
    book: (input) => ipcRenderer.invoke(IpcChannel.ExporterBook, input),
    volume: (input) => ipcRenderer.invoke(IpcChannel.ExporterVolume, input)
  },

  backup: {
    database: () => ipcRenderer.invoke(IpcChannel.BackupDatabase)
  }
}

contextBridge.exposeInMainWorld(WINBOOK_BRIDGE_KEY, api)
