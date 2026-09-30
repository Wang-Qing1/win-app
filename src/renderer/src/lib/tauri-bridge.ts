import type { WinbookApi } from '@shared/api'
import { IpcChannel } from '@shared/ipc-channels'
import type { IpcResponse } from '@shared/result'

/**
 * Tauri 侧的桥接垫片。
 *
 * 换壳的**关键设计**在这里：渲染层只认 `window.winbook` 这一个对象，
 * 它的形状由 `@shared/api` 的 `WinbookApi` 定义、由 `api-client.ts` 拆信封。
 * 于是我们不必改 1.5 万行渲染代码，只要在新壳里**造出一个同形状的对象**
 * 就成了 —— 对外行为不变，对内从 `ipcRenderer.invoke` 换成 `invoke`。
 *
 * 一旦这个垫片装上，`window.winbook` 的每个方法仍然返回 `IpcResponse` 信封
 * （而不是抛异常），所以 `api-client.ts` 的拆信封逻辑、React Query 的错误
 * 处理、表单的字段级错误映射，全部原样继续工作。
 */

/**
 * 桥接协议版本。与 Electron 壳的 `preload/index.ts` 保持同一个值 ——
 * 它标识的是**接口形状**（有哪些模块、哪些方法），而不是实现方式。
 * 换壳不改变形状，所以版本号不动。
 *
 * 2：联系人示例模块被小说助手模块取代，API 形状不兼容。
 * 3：新增大纲（自由多层情节树）模块。
 * 4：新增卡片库（人物 / 物品 / 灵感统一建模）模块。
 * 5：新增全库检索（章节正文 / 卡片 / 大纲 / 书籍信息，LIKE 扫描非 FTS5）。
 * 6：导出新增整本书/整卷批量导出。
 * 7：新增数据库备份。
 * 8：新增卡片 ↔ 章节关联。
 * 9：新增卡片 ↔ 大纲节点关联。
 * 10：新增设定卡时间线重排。
 * 11：新增卡片 ↔ 卡片的关系。
 * 12：新增章节历史版本与回档。
 * 13：删除改为软删除，新增回收站。
 */
export const BRIDGE_VERSION = '13'

/**
 * 通道名 → 命令名。
 *
 * Electron 的通道名带冒号与驼峰（`chapters:saveContent`），而 Rust 的函数名
 * 只能是下划线小写（`chapters_save_content`）。这里做一次确定性映射，
 * **不维护第二份手写映射表** —— 手写表一定会漂移：新增一个通道时改了常量
 * 却忘了改表，症状是运行期「命令不存在」，而不是编译期报错。
 *
 * 之所以能这么映射，是因为通道名本身是受控的：全部来自 `IpcChannel` 常量，
 * 且只用「小写单词 + 冒号 + 驼峰/短横线」这一种构词法。
 */
export function toCommandName(channel: string): string {
  return channel
    .replace(/:/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

type Invoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriGlobal {
  core?: { invoke?: Invoker }
}

function resolveInvoker(): Invoker {
  const runtime = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  const invoker = runtime?.core?.invoke
  if (!invoker) {
    throw new Error(
      'Tauri 运行时未就绪：请通过 winbook 桌面应用启动，而不是用浏览器直接打开页面'
    )
  }
  return invoker
}

/**
 * 统一的命令调用。
 *
 * 入参统一包成 `{ input }`：Rust 侧命令的形参就叫 `input`，
 * 于是「有入参 / 无入参」在两边都只有一种写法，不必为无参命令特判。
 */
function call<T>(channel: string, input?: unknown): Promise<IpcResponse<T>> {
  const args = input === undefined ? {} : { input }
  return resolveInvoker()(toCommandName(channel), args) as Promise<IpcResponse<T>>
}

export function createTauriBridge(): WinbookApi {
  return {
    version: BRIDGE_VERSION,

    health: {
      ping: () => call(IpcChannel.HealthPing),
      ready: () => call(IpcChannel.HealthReady)
    },

    books: {
      list: (query) => call(IpcChannel.BooksList, query),
      get: (input) => call(IpcChannel.BooksGet, input),
      create: (input) => call(IpcChannel.BooksCreate, input),
      update: (input) => call(IpcChannel.BooksUpdate, input),
      remove: (input) => call(IpcChannel.BooksRemove, input),
      stats: () => call(IpcChannel.BooksStats)
    },

    volumes: {
      list: (input) => call(IpcChannel.VolumesList, input),
      create: (input) => call(IpcChannel.VolumesCreate, input),
      update: (input) => call(IpcChannel.VolumesUpdate, input),
      remove: (input) => call(IpcChannel.VolumesRemove, input),
      reorder: (input) => call(IpcChannel.VolumesReorder, input)
    },

    chapters: {
      list: (query) => call(IpcChannel.ChaptersList, query),
      get: (input) => call(IpcChannel.ChaptersGet, input),
      create: (input) => call(IpcChannel.ChaptersCreate, input),
      update: (input) => call(IpcChannel.ChaptersUpdate, input),
      saveContent: (input) => call(IpcChannel.ChaptersSaveContent, input),
      remove: (input) => call(IpcChannel.ChaptersRemove, input),
      reorder: (input) => call(IpcChannel.ChaptersReorder, input),
      move: (input) => call(IpcChannel.ChaptersMove, input),
      listRevisions: (input) => call(IpcChannel.ChaptersListRevisions, input),
      getRevision: (input) => call(IpcChannel.ChaptersGetRevision, input),
      restoreRevision: (input) => call(IpcChannel.ChaptersRestoreRevision, input)
    },

    outline: {
      tree: (query) => call(IpcChannel.OutlineTree, query),
      create: (input) => call(IpcChannel.OutlineCreate, input),
      update: (input) => call(IpcChannel.OutlineUpdate, input),
      remove: (input) => call(IpcChannel.OutlineRemove, input),
      move: (input) => call(IpcChannel.OutlineMove, input),
      attachChapter: (input) => call(IpcChannel.OutlineAttachChapter, input),
      materialize: (input) => call(IpcChannel.OutlineMaterialize, input)
    },

    cards: {
      list: (query) => call(IpcChannel.CardsList, query),
      create: (input) => call(IpcChannel.CardsCreate, input),
      update: (input) => call(IpcChannel.CardsUpdate, input),
      remove: (input) => call(IpcChannel.CardsRemove, input),
      duplicate: (input) => call(IpcChannel.CardsDuplicate, input),
      linkChapter: (input) => call(IpcChannel.CardsLinkChapter, input),
      unlinkChapter: (input) => call(IpcChannel.CardsUnlinkChapter, input),
      listLinks: (input) => call(IpcChannel.CardsListLinks, input),
      listByChapter: (input) => call(IpcChannel.CardsListByChapter, input),
      linkNode: (input) => call(IpcChannel.CardsLinkNode, input),
      unlinkNode: (input) => call(IpcChannel.CardsUnlinkNode, input),
      listNodeLinks: (input) => call(IpcChannel.CardsListNodeLinks, input),
      listByNode: (input) => call(IpcChannel.CardsListByNode, input),
      setTimelineOrder: (input) => call(IpcChannel.CardsSetTimelineOrder, input),
      listRelations: (input) => call(IpcChannel.CardsListRelations, input),
      listBookRelations: (input) => call(IpcChannel.CardsListBookRelations, input),
      relate: (input) => call(IpcChannel.CardsRelate, input),
      unrelate: (input) => call(IpcChannel.CardsUnrelate, input)
    },

    search: {
      query: (input) => call(IpcChannel.SearchQuery, input)
    },

    trash: {
      list: (input) => call(IpcChannel.TrashList, input),
      restore: (input) => call(IpcChannel.TrashRestore, input),
      purge: (input) => call(IpcChannel.TrashPurge, input),
      empty: (input) => call(IpcChannel.TrashEmpty, input)
    },

    sessions: {
      finish: (input) => call(IpcChannel.SessionsFinish, input),
      list: (query) => call(IpcChannel.SessionsList, query)
    },

    stats: {
      overview: () => call(IpcChannel.StatsOverview),
      trend: (query) => call(IpcChannel.StatsTrend, query),
      books: (query) => call(IpcChannel.StatsBooks, query),
      heatmap: (query) => call(IpcChannel.StatsHeatmap, query)
    },

    exporter: {
      chapter: (input) => call(IpcChannel.ExporterChapter, input),
      book: (input) => call(IpcChannel.ExporterBook, input),
      volume: (input) => call(IpcChannel.ExporterVolume, input)
    },

    backup: {
      database: () => call(IpcChannel.BackupDatabase)
    }
  }
}

/**
 * 装上桥接。
 *
 * **只在 `window.winbook` 还空着时动手** —— 于是过渡期内两种壳可以并存：
 * Electron 的 preload 先装好，这里就什么都不做；Tauri 里没人装，由这里补上。
 * 这条判断也让「同一份渲染产物同时给两种壳用」成为可能，
 * 迁移期不必维护两个分支。
 */
export function installTauriBridge(): void {
  if (typeof window === 'undefined') return
  const target = window as unknown as { winbook?: WinbookApi }
  if (target.winbook !== undefined) return
  target.winbook = createTauriBridge()
}
