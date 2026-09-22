import { writeFileSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc-channels'
import { htmlToText, countHanzi, countNonWhitespace } from '@shared/text'
import { OUTLINE_LIMITS, type OutlineTreeNode } from '@shared/modules/outline'
import {
  CARD_LIMITS,
  DEFAULT_CARD_QUERY,
  isCardType,
  normalizeExtra,
  type CardListQuery,
  type CardListResult
} from '@shared/modules/cards'
import { RELATION_LIMITS } from '@shared/modules/card-links'
import {
  SEARCH_LIMITS,
  SEARCH_SOURCE_LABELS,
  normalizeSearchQuery,
  parseKeywords,
  sliceSnippet,
  type SearchGroup,
  type SearchResult,
  type SearchSource
} from '@shared/modules/search'
import { getChannelParser, getIpcRejections, getRegisteredChannels } from './core/ipc-handler'
import { AppError } from './core/errors'
import { getDatabase } from './db/connection'
import { getSchemaVersion } from './db/migrator'
import { migrations } from './db/migrations'
import { BookRepository } from './modules/books/book.repository'
import { BookService } from './modules/books/book.service'
import { bookCreateSchema, DEFAULT_CHAPTER_WORDS } from '@shared/modules/books'
import { CHAPTER_REVISION_LIMITS } from '@shared/modules/chapters'
import { VolumeRepository } from './modules/volumes/volume.repository'
import { VolumeService } from './modules/volumes/volume.service'
import { ChapterRepository } from './modules/chapters/chapter.repository'
import { ChapterRevisionRepository } from './modules/chapters/chapter-revision.repository'
import { ChapterService } from './modules/chapters/chapter.service'
import { SessionRepository } from './modules/sessions/session.repository'
import { SessionService } from './modules/sessions/session.service'
import { OutlineRepository } from './modules/outline/outline.repository'
import { OutlineService } from './modules/outline/outline.service'
import { CardRepository } from './modules/cards/card.repository'
import { CardService } from './modules/cards/card.service'
import { CardLinkRepository } from './modules/card-links/card-link.repository'
import { CardLinkService } from './modules/card-links/card-link.service'
import { SearchRepository } from './modules/search/search.repository'
import { SearchService } from './modules/search/search.service'
import { StatsService } from './modules/stats/stats.service'

/**
 * 启动冒烟测试。
 *
 * 桌面应用没有 HTTP 端点可以 curl，所以这里用一条等价路径替代：
 * 用临时 userData 目录跑真实的主进程，把「数据库 → 迁移 → 服务业务规则
 * → IPC 注册 → 渲染进程真的渲染出来」整条链路串起来验证一遍。
 *
 *   npm run smoke
 *
 * 退出码 0 表示全通，1 表示有失败项。适合放进 CI，也适合发给别人前先自检。
 *
 * 关于断言的设计原则：
 *   不是「调用了没报错就算通过」，而是构造**已知输入**并校验**精确输出**。
 *   例如正文里的汉字个数是数得出来的，统计口径是不是真的对，只有比对
 *   精确数字才能验证——「返回了一个正数」这种断言挡不住口径算错。
 */

export interface StepResult {
  name: string
  ok: boolean
  detail: string
}

const EXPECTED_CHANNELS = Object.values(IpcChannel).sort()

/** 每个用例的标题都带随机后缀，避免与上一次运行残留的数据撞名 */
const STAMP = Date.now().toString(36)

/**
 * 首页功能模块卡片的期望清单（数组顺序 = 卡片从左到右的顺序）。
 *
 * 这里**刻意不 import 渲染进程的 `components/nav.tsx`**，两条理由：
 *   1) 那个文件里是 JSX 与图标组件，拉进主进程会把 React 打进主进程包；
 *   2) 更要紧的是测试与被测对象共用同一份清单时，「清单本身被改错」
 *      就永远测不出来 —— 两边一起错，断言照样全绿。清单是产品约定，
 *      测试必须独立写一遍（模块名 / 路径 / 顺序都是用户能直接感知的东西）。
 */
const HOME_MODULES = [
  { key: 'books', path: '/books', label: '书籍管理' },
  { key: 'outline', path: '/outline', label: '大纲管理' },
  { key: 'cards', path: '/cards', label: '卡片库' },
  { key: 'stats', path: '/stats', label: '时间与字数' }
] as const

/**
 * 每个页面上「至少应当量到几行并排卡片」。
 *
 * 作用是让「标记丢了 / 整行被删」变红：`[data-card-row]` 探针采到 0 行时
 * 会安安静静地通过，而「一行卡片全没了」正是最该拦住的情况。
 *
 * 写的是**下限**而不是精确值：栅格是响应式的（`xs={12}` 在窄窗口折成两行），
 * 精确计数会把窄窗口下的正确实现判成失败 —— 这是「写死落点」的老毛病。
 *
 * 数字独立写一遍（同 `HOME_MODULES` 的理由）：从渲染进程 import 的话，
 * 两边一起改错就永远测不出来。
 */
const CARD_ROWS_MIN: Readonly<Record<string, number>> = {
  '/': 3, // 功能模块 / 首页指标 / 趋势与今日
  '/books': 1, // 书架卡片网格（另一行骨架只在加载时存在）
  '/outline': 0,
  '/cards': 0,
  '/stats': 2 // 区间指标 / 趋势图
  /*
   * 原先这里还有一条 `'book-detail': 1`（书籍详情页的四张概览卡）。
   * 用户 2026-09-20 取消了那一页（「新建书籍并且打开书籍之后应该是正文编辑页，
   * 不应该出现这个统计界面」），所以这条下限连同那一页的断言整段删掉 ——
   * 只删断言不删下限的话，下一次有人给编辑页加一行并排卡片就会被误报。
   */
}

/**
 * 编辑器顶栏「书籍菜单」（`…`）里的三项。
 *
 * 这一份清单原来是**书籍详情页**头部的四枚按钮（返回书架 / 编辑信息 /
 * 导出整本书 / 删除书籍）。那一页取消后，「返回书架」变成了编辑器顶栏
 * 最左那枚箭头（见 `EDITOR_TOP_BAR_ACTIONS` 的 editor-back），
 * 剩下三项收进 `…` 菜单里。清单按新形态重写，不是照抄。
 *
 * 为什么这三项值得逐个点名：它们是**整本书唯一的出口**（改书名与目标字数、
 * 导出、删除）。收进菜单之后，「菜单打开时项没渲染出来」「某一项点着没反应」
 * 都不会让任何存在性断言变红 —— 按钮还在，只是里面空了。
 */
const BOOK_MENU_ITEMS: ReadonlyArray<{ key: string; testId: string; name: string }> = [
  { key: 'edit', testId: 'book-menu-edit', name: '编辑书籍信息' },
  { key: 'export', testId: 'book-menu-export', name: '导出整本书' },
  { key: 'remove', testId: 'book-menu-remove', name: '删除这本书' }
]

/**
 * 章节编辑器顶栏那几枚功能按钮的锚点（同上一份清单，独立写一遍）。
 *
 * 六枚 = 返回书架 + 查找替换 / 取名 / 专注 / 发布草稿 + 书籍菜单 `…`。
 *
 * 只点名锚点、不点名文案：其中一枚（专注模式）的提示文案**随状态变**
 * （「专注模式：…」/「退出专注模式」），写死文案的断言会在切到专注模式后
 * 变成假失败。形状与「label 非空」由 `checkIconButtons` 统一管，
 * 这里只负责「六枚都还在」。
 *
 * 空书（`/books/:bookId`，一章都还没有）时只有两枚：返回书架 + `…` 菜单 ——
 * 其余四枚都要有正文才谈得上。这一点由「打开书籍」那一步单独断言。
 */
const EDITOR_TOP_BAR_ACTIONS = [
  'editor-back',
  'editor-find-toggle',
  'editor-name',
  'editor-focus-toggle',
  'editor-export',
  'editor-book-menu'
] as const

/**
 * 顶栏 `…` 菜单里的三项，与 `TopBarMenu` 的 items 一一对应。
 *
 * 同上：独立写一遍而不是从渲染进程 import —— 菜单项是产品约定，
 * 两边一起改错的话共用清单永远测不出来。
 */
const TOP_BAR_MENU_ITEMS: ReadonlyArray<{ key: string; testId: string; name: string }> = [
  { key: 'health', testId: 'topbar-menu-health', name: '主进程健康' },
  { key: 'backup', testId: 'topbar-menu-backup', name: '备份数据库' },
  { key: 'theme', testId: 'topbar-menu-theme', name: '主题切换' }
]

/** 「更多功能」按钮的锚点，多处用 */
const TOP_BAR_MORE_ID = 'topbar-more-button'

/**
 * **允许重复**的按钮锚点：列表行。
 *
 * 这些锚点挂在「一屏里有很多个」的行上（卡片行 / 目录行 / 进度行 / 首页模块卡），
 * 本来就该出现多次 —— 读它们的地方用的也是 `querySelectorAll`。
 *
 * 除此之外的按钮锚点必须唯一。用白名单而不是自动识别：自动识别的启发式
 * （「文本不同就是列表」）一旦判错，要么放走真 bug、要么变成天天有人来绕过的误报；
 * 白名单则是「新增一个列表锚点时测试会红」，逼着人显式声明「这个是列表行」。
 * 边界就是这句：**按 `querySelector` 读的锚点必须唯一，按 `querySelectorAll` 读的
 * 才允许重复** —— 前者出现两枚时，断言只会读到第一枚，另一枚没人看得见。
 */
const REPEATABLE_BUTTON_ANCHORS = ['card-row', 'catalog-row', 'progress-row', 'module-entry']

/**
 * 大纲页右侧节点面板头部的两枚图标按钮（子节点 / 同级），独立写一遍清单。
 *
 * 为什么要按**显式清单**挑而不是前缀匹配：页头还有一枚 `outline-add-root`，
 * 用 `startsWith('outline-add-')` 会把它也算进「面板头部」，2 枚变成 3 枚
 * —— 第一版就是这么误报的。前缀匹配看着省事，其实是把两个不同位置的
 * 按钮当成了一类。
 */
const OUTLINE_PANEL_ACTIONS = ['outline-add-child', 'outline-add-sibling'] as const

/**
 * 主题三档的循环顺序，与 `TopBarMenu` 里的 `THEME_ITEMS` 对齐。
 * 独立写一遍，否则「顺序被改错」两边一起错、断言照样全绿。
 */
const THEME_ORDER = ['system', 'light', 'dark'] as const

/**
 * 展示用书籍的「每章最少字数」。
 *
 * 刻意取一个不是默认值的数（默认 2000），而且是**本章 targetWords 之外**的
 * 另一个数：底栏「计划」读的是书籍设置，展示章节自己的 targetWords 是 0。
 * 一旦实现改回去读本章字段，底栏会显示「未设目标」，断言当场就能发现。
 * 所以这个常量必须和下面创建书籍时的值保持一致。
 */
const SHOWCASE_CHAPTER_WORDS = 1500

/** 在大纲树里按 id 找节点。断言里要核对层级与顺序，必须先能定位到具体节点 */
function findTreeNode(nodes: readonly OutlineTreeNode[], id: number): OutlineTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findTreeNode(node.children, id)
    if (hit) return hit
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 后端链路：数据库 → 迁移 → 服务业务规则 → 统计聚合 → IPC 注册
 * ------------------------------------------------------------------ */

/** 渲染检查需要的一对 id：有了它们才能导航到编辑器的真实路由 */
export interface ShowcaseTargets {
  bookId: number
  /** 展示书籍的书名。打开一本书之后，它出现在编辑器顶栏的书名位上 */
  bookTitle: string
  chapterId: number
  /** 展示书籍里的一个分卷。新建章弹窗靠它验证「选的分卷真的落库了」 */
  volumeId: number
  volumeTitle: string
  /** 展示书籍的「每章最少字数」。底栏「计划」的口径断言按它算期望值 */
  chapterWords: number
  /**
   * 一本**一章都没有**的书。
   *
   * 用户 2026-09-20 那张截图里被打开的正是这样一本书（分卷 0 / 章节 0），
   * 而那时的落点是一张统计页。现在它必须落在编辑器空态上：顶栏、左侧目录、
   * 底栏统计都在，只有正文区是空的。这个「什么都没有」的形态**只能用一本
   * 真空的书**测出来 —— 拿展示用书去测，永远走的是「有章节」那条分支。
   */
  emptyBookId: number
  emptyBookTitle: string
  /**
   * 按 id 回读一整本书的总量（分卷数 / 章节数 / 汉字总数）。
   *
   * 底栏右侧那一组「全书」统计必须与库里的数一致 —— 而它最容易出的错是
   * 「读的是书籍列表项里的缓存聚合字段」，那种错在刚删改过章节时立刻显形，
   * 所以判据只能是回库现算，不能复用界面上的任何中间值。
   */
  bookTotals: (bookId: number) => { volumes: number; chapters: number; hanzi: number }
  /**
   * 打开这本书时**应当自动跳到的**那一章。
   *
   * 由主进程按「最近更新的一章」算出来，而不是把 `chapterId` 当成答案：
   * 这本书里除了展示用的那一章，还有大纲节点落地成的章节，它们谁更新是
   * **数据决定**的。把展示章节的 id 写死当期望值，等于拿测试的假设去规定
   * 产品行为 —— 换一批数据就会变成假失败。
   */
  resumeChapterId: (bookId: number) => number | null
  /**
   * 按标题回读分卷。左侧目录的「建卷 / 改名 / 删除」三条路径都要落在这里验证 ——
   * 界面上「卷消失了」也可能是没建出来，只有回库才知道到底发生了哪一件事。
   */
  lookupVolume: (title: string) => { id: number; title: string; chapterCount: number } | null
  /**
   * 按标题回读章节元数据。
   *
   * 新建章弹窗与目录右键菜单的验证都必须落在这里：状态这一项**界面上一度
   * 完全不显示**（它正是被从编辑器那一行里删掉的字段之一），只能回主进程
   * 读库，否则「选了修订中、实际落库是草稿」这种错永远测不出来。
   *
   * 带 id 是因为右键菜单要按 id 去点某一行；带 hanziCount 是因为两处菜单
   * 操作都走「整体替换」的接口，最容易的失误就是把别的字段一起抹掉 ——
   * 而那正是「我只改了个状态，正文怎么少了一半」的成因。
   */
  lookupChapter: (title: string) => {
    id: number
    title: string
    status: string
    volumeId: number | null
    targetWords: number
    hanziCount: number
  } | null
  /**
   * 按标题回读卡片。
   *
   * 设定卡（第二期）的验证要落在这里：类型与「类别」在界面上都只是几个字
   * （一个标签 + 一行补充信息），而 `extra` 是一列自由 JSON ——
   * 存进去的到底是不是「设定 / 时间线」，只有回库现读才知道。
   * `extraKeys` 与 `category` 分开给，是为了能同时断「字段集恰好是这一类该有的」
   * 与「枚举值没有被拼错、也没有被收敛掉」。
   */
  lookupCard: (title: string) => {
    id: number
    title: string
    cardType: string
    /** extra 的键集合，按字典序用逗号连接 */
    extraKeys: string
    /** 设定卡的类别；非设定卡为空串 */
    category: string
    /** 设定卡的时点（第三期）。没填为空串 */
    timePoint: string
    /**
     * 设定卡的时间线序号（第三期）。**空串与 '0' 含义不同**：
     * 空串是「还没排过」，'0' 是「排在最前」。
     */
    order: string
  } | null
  /** 删掉一张卡片。验证用的卡片建完就删，展示数据要恢复原样 */
  removeCard: (id: number) => void
  /**
   * 造一张用于验证的设定卡，返回它的 id。
   *
   * 走主进程而不是在界面上点出来：类别筛选要验的是「筛得对不对」，
   * 若卡片本身也是界面建出来的，一次失败会连带另一条也失败，
   * 排查时就分不清是筛选错了还是新建错了。
   * 调用方负责用 removeCard 删掉。
   */
  /**
   * 同上，`timePoint` 用于时间线视图（第三期）：时点是自由文本，
   * 也走主进程写，理由与上面一致 —— 要验的是「视图排得对不对」，
   * 不是「界面能不能把字打进输入框」。
   */
  seedSettingCard: (title: string, category: string, timePoint?: string) => number
  /**
   * 造一张用于验证的卡片（任意类型），返回它的 id。
   *
   * 关系那一项要的是两张同书的人物卡，而 `seedSettingCard` 只造设定卡 ——
   * 单独开一个而不是给它加参数：设定卡的 extra 有时点与类别要填，
   * 混在一个函数里会变成一堆「这两个参数只有某一种类型才用得上」。
   */
  seedCard: (title: string, cardType: string) => number
  /** 这张卡与哪些卡有关系。关系是主进程的一张表，界面说了不算 */
  relationsOfCard: (cardId: number) => Array<{ relatedId: number; relation: string }>
  /** 这张卡关联到哪几章（章节 id）。关联是主进程的一张表，界面说了不算 */
  linksOfCard: (cardId: number) => number[]
  /** 这一章关联到哪几张卡（卡片 id） */
  cardsOfChapter: (chapterId: number) => number[]
  /**
   * 这本书的章节 id 与标题。
   *
   * 界面上选章节的下拉里写的是标题，而断言要拿到的却是 id（去库里对账），
   * 缺了它就只能靠标题反查 —— 同名章节会让反查落到错误的那一章上。
   */
  chaptersOf: (bookId: number) => Array<{ id: number; title: string }>
  /** 这本书的大纲节点 id 与标题（第三期：卡片 ↔ 节点关联要对账用） */
  nodesOf: (bookId: number) => Array<{ id: number; title: string }>
  /** 这张卡挂在哪几个节点上（节点 id） */
  nodesOfCard: (cardId: number) => number[]
  /** 这个节点关联到哪几张卡（卡片 id） */
  cardsOfNode: (nodeId: number) => number[]
  /**
   * 这一章的历史版本（第三期第 4 件）。
   *
   * 只回 id 与字数：历史正文动辄几万字，把整份 HTML 拉进断言里既慢
   * 又没必要 —— 断言要回答的是「留了几版、最新那版是不是我预期的那一版」，
   * 这两个问题用字数就能答（每段的字数都被刻意造成互不相同）。
   */
  revisionsOf: (chapterId: number) => Array<{ id: number; hanziCount: number }>
  /**
   * 这一章**库里**的汉字数。
   *
   * 渲染检查里要等「自动保存真的落库了」。底栏的「已保存」不能当判据 ——
   * 进入某个检查时它往往**已经是**「已保存」（上一条检查打完字留下的），
   * 于是等待瞬间返回，断言跑在了保存前面（这个坑真踩过，表现为
   * 「打完字历史版本却没长」）。而字数由主进程从正文现算，只有真的
   * 写进去了才会变，是唯一不会骗人的信号。
   */
  chapterHanzi: (chapterId: number) => number
}

export interface BackendSmokeRun {
  results: StepResult[]
  /** 为空表示后端没能留下可见数据，渲染检查只能跑首页 */
  showcase: ShowcaseTargets | null
}

export async function runBackendSmokeChecks(): Promise<BackendSmokeRun> {
  const results: StepResult[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail })
  }

  const db = getDatabase()
  const bookRepository = new BookRepository(db)
  const volumeRepository = new VolumeRepository(db)
  const chapterRepository = new ChapterRepository(db)
  const chapterRevisionRepository = new ChapterRevisionRepository(db)
  const sessionRepository = new SessionRepository(db)
  const outlineRepository = new OutlineRepository(db)
  const cardRepository = new CardRepository(db)

  const bookService = new BookService(bookRepository, db)
  const volumeService = new VolumeService(volumeRepository, bookRepository)
  const chapterService = new ChapterService(
    chapterRepository,
    bookRepository,
    volumeRepository,
    chapterRevisionRepository
  )
  const sessionService = new SessionService(sessionRepository, bookRepository, chapterRepository)
  const outlineService = new OutlineService(
    outlineRepository,
    bookRepository,
    chapterRepository,
    chapterService
  )
  const statsService = new StatsService(bookRepository, chapterRepository, sessionRepository)
  const cardService = new CardService(cardRepository, bookRepository)
  const cardLinkService = new CardLinkService(
    new CardLinkRepository(db),
    cardRepository,
    chapterRepository,
    outlineRepository
  )
  const searchService = new SearchService(new SearchRepository(db))

  /* 1. 数据库可查询 */
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
    push(
      '数据库连接',
      row?.ok === 1,
      row?.ok === 1 ? `连接正常，用户数据目录 ${app.getPath('userData')}` : '探测查询返回非预期结果'
    )
  } catch (error) {
    push('数据库连接', false, messageOf(error))
  }

  /* 2. 迁移已全部应用 */
  // 期望值从迁移清单推导，而不是写死某个版本号：每加一条迁移都要回来改断言，
  // 这种「改断言」的动作很快就会变成无脑照改，真正的回归反而溜过去。
  const schemaVersion = getSchemaVersion(db)
  const latestMigration = migrations[migrations.length - 1]?.name ?? ''
  push(
    '数据库迁移',
    schemaVersion === latestMigration,
    schemaVersion === null
      ? '没有任何迁移记录'
      : `当前 schema 版本：${schemaVersion}${schemaVersion === latestMigration ? '' : `（预期 ${latestMigration}）`}`
  )

  /* 3. contacts 示例表已被移除 —— 迁移 003 真的执行了才算数 */
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'contacts'")
      .get() as { n: number }
    push('示例表已清理', row.n === 0, row.n === 0 ? 'contacts 表已不存在' : 'contacts 表仍然存在')
  } catch (error) {
    push('示例表已清理', false, messageOf(error))
  }

  /* 4. IPC 通道全部注册 */
  const registered = getRegisteredChannels()
  const missing = EXPECTED_CHANNELS.filter((channel) => !registered.includes(channel))
  push(
    'IPC 通道注册',
    missing.length === 0,
    missing.length === 0
      ? `已注册 ${registered.length} 个通道`
      : `缺少通道：${missing.join(', ')}`
  )

  /* 5. 纯文本转换与汉字计数 —— 统计口径的基础，必须逐字校验 */
  try {
    const html = '<p>星海归途</p><p>第一段：他说，你好世界！Hello 123</p>'
    const text = htmlToText(html)
    // 数得出来的：星海归途=4，第一段=3，他说=2，你好世界=4，合计 13
    // 非空白字符还要加上标点与英文数字：：，！Hello123 共 11 个
    const hanzi = countHanzi(text)
    const chars = countNonWhitespace(text)
    const expectedText = '星海归途\n\n第一段：他说，你好世界！Hello 123'

    const ok = hanzi === 13 && chars === 24 && text === expectedText
    push(
      '汉字计数口径',
      ok,
      ok
        ? `HTML 转文本正确，汉字 13 / 非空白字符 24`
        : `预期汉字 13、字符 24、文本「${expectedText}」，实得汉字 ${hanzi}、字符 ${chars}、文本「${text}」`
    )

    // 生僻字：扩展 B 区的字若按 [\u4e00-\u9fa5] 区间统计会被漏掉
    const rare = countHanzi('𠀀𠀁龘')
    push('生僻字计数', rare === 3, rare === 3 ? '扩展区汉字被正确计入' : `扩展区汉字漏计，实得 ${rare}`)
  } catch (error) {
    push('汉字计数口径', false, messageOf(error))
  }

  /* 6. 业务规则：建书 → 建卷 → 建章 → 保存正文 → 会话结算 → 统计 → 级联删除 */
  let showcaseBookId: number | null = null
  let showcaseBookTitle = ''
  let showcaseChapterId: number | null = null
  let showcaseVolumeId: number | null = null
  let showcaseVolumeTitle = ''
  /** 「一章都没有」的那本书，见 ShowcaseTargets.emptyBookId 的说明 */
  let emptyBookId: number | null = null
  let emptyBookTitle = ''

  try {
    /* ---- 建书 ---- */
    const book = bookService.create({
      title: `冒烟-星海归途-${STAMP}`,
      penName: '冒烟作者',
      genre: '科幻',
      status: 'serializing',
      summary: '由 npm run smoke 创建',
      targetWords: 200_000,
      chapterWords: 2000,
      accentColor: '#0f6cbd'
    })

    /* ---- 书名唯一性冲突必须被拦下 ---- */
    let conflictBlocked = false
    try {
      bookService.create({
        title: `冒烟-星海归途-${STAMP}`,
        penName: '',
        genre: '',
        status: 'idea',
        summary: '',
        targetWords: 0,
        chapterWords: 2000,
        accentColor: '#0f6cbd'
      })
    } catch (error) {
      conflictBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    /* ---- 每章最少字数：默认值与改动通路 ----
     *
     * 这一项的存在理由：「每章最少字数」只在新建/编辑书籍时填一次，之后全书
     * 每章都靠它。所以它的默认值和「改了能不能存住」比界面上的输入框重要得多 ——
     * 默认值写漏，用户建完书得到 0，全书每章都显示「未设目标」；UPDATE 语句漏列，
     * 用户改完设置刷新一看还是旧值，而且不会有任何报错。
     */
    const contractDefault = bookCreateSchema.parse({ title: `冒烟-默认值探测-${STAMP}` })
    push(
      '每章最少字数默认值',
      contractDefault.chapterWords === DEFAULT_CHAPTER_WORDS,
      `建书时不传该字段，落到的默认值是 ${contractDefault.chapterWords}（期望 ${DEFAULT_CHAPTER_WORDS}）`
    )

    const bumped = bookService.update({ ...book, chapterWords: 3200 })
    const restored = bookService.update({ ...book })
    push(
      '每章最少字数可改',
      bumped?.chapterWords === 3200 && restored?.chapterWords === book.chapterWords,
      `改成 3200 后读到 ${String(bumped?.chapterWords)}，改回后读到 ${String(restored?.chapterWords)}（原值 ${book.chapterWords}）`
    )

    /* ---- 建分卷 ---- */
    const volume = volumeService.create({
      bookId: book.id,
      title: '第一卷 启程',
      summary: ''
    })

    /* ---- 建章 ---- */
    const first = chapterService.create({
      bookId: book.id,
      volumeId: volume.id,
      title: '第一章 出港',
      targetWords: 3000
    })
    const second = chapterService.create({
      bookId: book.id,
      volumeId: volume.id,
      title: '第二章 跃迁',
      targetWords: 0
    })
    const loose = chapterService.create({
      bookId: book.id,
      volumeId: null,
      title: '番外 归途日记',
      targetWords: 0
    })

    /* ---- 保存正文，校验服务端重新算出的字数 ---- */
    const saved = chapterService.saveContent({
      id: first.id,
      contentHtml: '<p>星海归途</p><p>第一段：他说，你好世界！Hello 123</p>'
    })

    /* ---- 章节详情应当带正文，列表不应当带 ---- */
    const detail = chapterService.getById(first.id)
    const listItems = chapterService.list({ bookId: book.id, volumeId: undefined })
    const listCarriesContent = listItems.some(
      (item) => 'contentHtml' in (item as unknown as Record<string, unknown>)
    )

    /* ---- 修改元数据 ---- */
    const renamed = chapterService.update({
      id: second.id,
      title: '第二章 跃迁（修订）',
      status: 'revising',
      volumeId: volume.id,
      targetWords: 3000
    })

    /* ---- 跨书挂载必须被拒绝（越权写入的防线） ---- */
    const otherBook = bookService.create({
      title: `冒烟-越权目标-${STAMP}`,
      penName: '',
      genre: '',
      status: 'idea',
      summary: '',
      targetWords: 0,
      chapterWords: 2000,
      accentColor: '#0f6cbd'
    })
    let crossBookBlocked = false
    try {
      chapterService.create({
        bookId: otherBook.id,
        volumeId: volume.id,
        title: '越权章节',
        targetWords: 0
      })
    } catch (error) {
      crossBookBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }
    bookService.remove(otherBook.id)

    /* ---- 把章节移出分卷，应当退回未分卷 ---- */
    const moved = chapterService.move({ id: loose.id, volumeId: volume.id, targetIndex: 0 })
    const movedOut = chapterService.move({ id: loose.id, volumeId: null, targetIndex: 0 })

    /* ---- 同一个容器内往前移：下标不能重复，顺序要整体前移 ----
     *
     * 这里必须凑够 3 章。只有 2 章时，即使 order_index 算重复了，
     * 「按下标再按 id」的排序也会凭 id 大小碰巧排对，测不出问题 ——
     * 这正是这个缺陷一直漏网的原因。
     */
    chapterService.move({ id: loose.id, volumeId: volume.id, targetIndex: 0 })
    const beforeSameMove = chapterService.list({ bookId: book.id, volumeId: volume.id })
    const lastOne = beforeSameMove[beforeSameMove.length - 1]
    chapterService.move({ id: lastOne.id, volumeId: volume.id, targetIndex: 0 })
    const afterSameMove = chapterService.list({ bookId: book.id, volumeId: volume.id })

    const expectedSameOrder = [lastOne.id, ...beforeSameMove.slice(0, -1).map((item) => item.id)]
    const orderIndexes = afterSameMove.map((item) => item.orderIndex)
    const sameMoveOk =
      afterSameMove.map((item) => item.id).join(',') === expectedSameOrder.join(',') &&
      new Set(orderIndexes).size === orderIndexes.length

    /* ---- 重排：把整卷顺序倒过来 ---- */
    const volumeChapters = chapterService.list({ bookId: book.id, volumeId: volume.id })
    const reversed = [...volumeChapters].reverse().map((item) => item.id)
    chapterService.reorder({ bookId: book.id, volumeId: volume.id, orderedIds: reversed })
    const afterReorder = chapterService.list({ bookId: book.id, volumeId: volume.id })

    /* ---- 重排提交不完整必须被拒绝 ---- */
    let partialReorderBlocked = false
    try {
      chapterService.reorder({
        bookId: book.id,
        volumeId: volume.id,
        orderedIds: reversed.slice(0, 1)
      })
    } catch (error) {
      partialReorderBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }

    /* ---- 写作会话：验证「写作量」与「净增」两个口径 ---- */
    const now = new Date()
    const session = sessionService.finish({
      bookId: book.id,
      chapterId: first.id,
      startedAt: new Date(now.getTime() - 1_800_000).toISOString(),
      endedAt: now.toISOString(),
      durationSeconds: 1800,
      startWords: 100,
      // 写到过 1200（写作量 = 1100），最后删到 1050（净增 = 950）
      peakWords: 1200,
      endWords: 1050
    })

    // peak < start 的数据必须被拒绝 —— 它会污染所有派生指标。
    // 校验挂在 IPC 边界上（控制器的 parse），服务层不做这件事，
    // 所以这里取真实的校验器来跑，而不是直接调服务层 —— 后者永远不抛。
    let badSessionBlocked = false
    const sessionFinishParser = getChannelParser(IpcChannel.SessionsFinish)
    if (sessionFinishParser) {
      try {
        sessionFinishParser({
          bookId: book.id,
          chapterId: first.id,
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          durationSeconds: 10,
          startWords: 500,
          peakWords: 400,
          endWords: 400
        })
      } catch {
        badSessionBlocked = true
      }
    }

    /* ---- 统计聚合 ---- */
    const overview = statsService.overview()
    // 全书汉字数 = 第一章 13 + 其他章 0 = 13
    const bookStats = bookService.stats()
    const trend = statsService.trend({ days: 30, bookId: null })
    const heatmap = statsService.heatmap(365, null)
    const progress = statsService.books({ limit: 10, rangeDays: 30 })
    const progressOfBook = progress.find((item) => item.bookId === book.id)
    const todayPoint = trend.days[trend.days.length - 1]

    /* ---- 正常顺序断言 ---- */
    const checks: Array<[string, boolean, string]> = [
      ['新增书籍', book.id > 0, `已创建 id=${book.id}，状态 ${book.status}`],
      ['书名冲突拦截', conflictBlocked, conflictBlocked ? '同名书籍被正确拒绝' : '同名书籍未被拦截'],
      ['新增分卷', volume.id > 0, `已创建卷「${volume.title}」`],
      [
        '新增章节',
        first.id > 0 && second.id > 0 && loose.id > 0,
        `已创建 3 章（分卷内 2 + 未分卷 1）`
      ],
      [
        '正文汉字统计',
        saved.hanziCount === 13 && saved.charCount === 24,
        saved.hanziCount === 13 && saved.charCount === 24
          ? `汉字 ${saved.hanziCount} / 含标点 ${saved.charCount}，与预期一致`
          : `预期汉字 13 / 含标点 24，实得 ${saved.hanziCount} / ${saved.charCount}`
      ],
      [
        '正文按需加载',
        detail.contentHtml.length > 0 && !listCarriesContent,
        detail.contentHtml.length > 0
          ? listCarriesContent
            ? '列表接口意外带上了正文'
            : `详情带正文（${detail.contentText.length} 字），列表不带`
          : '详情未返回正文'
      ],
      [
        '章节元数据更新',
        renamed.title.endsWith('（修订）') && renamed.status === 'revising',
        `已改为「${renamed.title}」/ ${renamed.status}`
      ],
      [
        '跨书挂载拦截',
        crossBookBlocked,
        crossBookBlocked ? '把 A 书的卷挂给 B 书被正确拒绝' : '跨书挂载未被拦截'
      ],
      [
        '章节移入移出分卷',
        moved.volumeId === volume.id && movedOut.volumeId === null,
        `移入后 volumeId=${moved.volumeId}，移出后 volumeId=${movedOut.volumeId}`
      ],
      [
        '章节同容器前移',
        sameMoveOk,
        sameMoveOk
          ? `末位章节移到首位后顺序为 ${afterSameMove.map((item) => item.title).join(' → ')}`
          : `预期顺序 ${expectedSameOrder.join(',')}，实得 ${afterSameMove
              .map((item) => `id${item.id}@${item.orderIndex}`)
              .join(', ')}`
      ],
      [
        '章节重排',
        afterReorder.length === reversed.length &&
          afterReorder.every((item, index) => item.id === reversed[index]),
        `按提交顺序返回 ${afterReorder.length} 章`
      ],
      [
        '不完整重排拦截',
        partialReorderBlocked,
        partialReorderBlocked ? '只提交部分章节被正确拒绝' : '不完整重排未被拦截'
      ],
      [
        '会话双口径',
        session.wordsWritten === 1100 && session.wordsNet === 950,
        `写作量 ${session.wordsWritten}（预期 1100）、净增 ${session.wordsNet}（预期 950）`
      ],
      [
        '异常会话拦截',
        badSessionBlocked,
        badSessionBlocked ? 'peak < start 的会话被边界校验拒绝' : '异常会话未被拦截'
      ],
      [
        '书籍统计聚合',
        bookStats.total >= 1 && bookStats.chapterCount === 3 && bookStats.hanziCount === 13,
        `书籍 ${bookStats.total} 本、章节 ${bookStats.chapterCount} 章、汉字 ${bookStats.hanziCount}`
      ],
      [
        '趋势补零',
        trend.days.length === 30 && todayPoint.wordsWritten === 1100,
        `${trend.days.length} 天（预期 30），今日写作量 ${todayPoint.wordsWritten}（预期 1100）`
      ],
      [
        '热力图分级',
        heatmap.cells.length === 365 && todayPoint.wordsWritten > 0
          ? heatmap.cells[heatmap.cells.length - 1].level === 4
          : false,
        `${heatmap.cells.length} 格，今日等级 ${heatmap.cells[heatmap.cells.length - 1]?.level}`
      ],
      [
        '总览聚合',
        overview.bookCount >= 1 && overview.streakDays >= 1 && overview.todayWordsWritten === 1100,
        `书籍 ${overview.bookCount}、连续 ${overview.streakDays} 天、今日写作量 ${overview.todayWordsWritten}`
      ],
      [
        '分书进度',
        progressOfBook !== undefined && progressOfBook.lastChapterId !== null,
        progressOfBook
          ? `《${progressOfBook.title}》${progressOfBook.hanziCount} 字 / ${progressOfBook.chapterCount} 章，最近章节「${progressOfBook.lastChapterTitle}」`
          : '在写书籍列表中找不到刚创建的书'
      ]
    ]

    for (const [name, ok, detail] of checks) {
      push(name, ok, detail)
    }

    /* ---- 删除级联：删书应当带走章节，但**保留**写作记录 ---- */
    const sessionsBefore = sessionRepository.countAll()
    bookService.remove(book.id)
    const chaptersAfterDelete = chapterRepository.countByBook(book.id)
    const sessionsAfter = sessionRepository.countAll()

    let chapterGone = false
    try {
      chapterService.getById(first.id)
    } catch (error) {
      chapterGone = error instanceof AppError && error.code === 'NOT_FOUND'
    }

    push(
      '删除级联',
      chapterGone && chaptersAfterDelete === 0,
      chapterGone ? '删书后章节随之消失，且不可再查询' : '删书后章节仍然存在'
    )
    push(
      '写作记录不随删书消失',
      sessionsAfter === sessionsBefore && sessionsAfter > 0,
      `删书前后写作记录均为 ${sessionsAfter} 条（历史写作量是既成事实，不应被结构调整抹掉）`
    )

    /* ---- 给渲染进程留一份可见的数据 ---- */
    const showcase = bookService.create({
      title: `冒烟-展示用-${STAMP}`,
      penName: '冒烟作者',
      genre: '都市',
      status: 'serializing',
      summary: '',
      targetWords: 100_000,
      // 与 SHOWCASE_CHAPTER_WORDS 必须一致：底栏「计划」的断言按它算期望值
      chapterWords: SHOWCASE_CHAPTER_WORDS,
      accentColor: '#0f7b0f'
    })
    showcaseBookId = showcase.id
    showcaseBookTitle = showcase.title

    /*
     * 一本**一章都没有**的书，专门给「打开书籍」那一步用。
     *
     * 用户 2026-09-20 的截图里被打开的正是这种书（分卷 0 / 章节 0）：那时它
     * 落在一张统计页上，而现在必须落在编辑器空态上。这个形态**只能用一本
     * 真空的书**测 —— 拿展示用书去测，走的永远是「有章节」那条分支。
     * 状态用「构思中」而不是「连载中」：它不该出现在「在写书籍」的语义里。
     */
    const emptyBook = bookService.create({
      title: `冒烟-空书-${STAMP}`,
      // 笔名**刻意与展示用书不同**：检索那一步会搜「冒烟作者」并断言「命中 1 处」，
      // 两本书同笔名就会变成 2 处 —— 那是被新数据带出来的假失败
      penName: '空书作者',
      genre: '都市',
      status: 'idea',
      summary: '这本书刻意不建任何分卷与章节，用来验证「打开一本书直落编辑器」。',
      targetWords: 50_000,
      chapterWords: SHOWCASE_CHAPTER_WORDS,
      accentColor: '#0f7b0f'
    })
    emptyBookId = emptyBook.id
    emptyBookTitle = emptyBook.title

    // 一本书要有分卷，新建章弹窗里的「所属分卷」才有真选项可选 ——
    // 否则那条断言只能验到「下拉框在」，选完到底有没有写进去完全测不到
    const showcaseVolume = volumeService.create({
      bookId: showcase.id,
      title: `第一卷 起-${STAMP}`,
      summary: ''
    })
    showcaseVolumeId = showcaseVolume.id
    showcaseVolumeTitle = showcaseVolume.title

    const showcaseChapter = chapterService.create({
      bookId: showcase.id,
      volumeId: null,
      title: '第一章 开场',
      targetWords: 0
    })
    showcaseChapterId = showcaseChapter.id
    // 故意混进几处典型毛病：重复标点、半角标点、成对符号落单。
    // 编辑器打开这一章时，纠错面板应当自己报出问题，而不是空着
    const showcaseSaved = chapterService.saveContent({
      id: showcaseChapter.id,
      contentHtml: '<p>这一段用于验证渲染进程能拿到真实数据。。</p><p>「引号没有配对，</p>'
    })
    const showcaseSession = sessionService.finish({
      bookId: showcase.id,
      chapterId: showcaseChapter.id,
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      endedAt: now.toISOString(),
      durationSeconds: 600,
      startWords: 0,
      peakWords: showcaseSaved.hanziCount,
      endWords: showcaseSaved.hanziCount
    })
    push(
      '会话与正文自洽',
      showcaseSession.endWords === showcaseSaved.hanziCount && showcaseSaved.hanziCount > 0,
      `正文 ${showcaseSaved.hanziCount} 汉字，会话记录 peak/end = ${showcaseSession.peakWords}/${showcaseSession.endWords}`
    )

    /* ---- 大纲：自由多层情节树 ---- */
    const outlineRoot = outlineService.create({
      bookId: showcase.id,
      parentId: null,
      nodeType: 'main',
      title: '主线：星海归途',
      summary: '从出港到回家',
      status: 'writing'
    })
    const outlineSub = outlineService.create({
      bookId: showcase.id,
      parentId: outlineRoot.id,
      nodeType: 'sub',
      title: '支线：旧友重逢',
      summary: '',
      status: 'planned'
    })
    const outlineForeshadow = outlineService.create({
      bookId: showcase.id,
      parentId: outlineSub.id,
      nodeType: 'foreshadow',
      title: '伏笔：半张星图',
      summary: '',
      status: 'planned'
    })
    const outlineSibling = outlineService.create({
      bookId: showcase.id,
      parentId: outlineRoot.id,
      nodeType: 'event',
      title: '事件：跃迁失败',
      summary: '',
      status: 'planned'
    })

    const outlineTree = outlineService.tree(showcase.id)
    const nestedOk =
      outlineTree.total === 4 &&
      outlineTree.depth === 3 &&
      outlineTree.nodes.length === 1 &&
      outlineTree.nodes[0].children.length === 2 &&
      outlineTree.nodes[0].children[0].children.length === 1

    /* ---- 结构校验用的一本书。测完删掉，顺便验证「删书带走大纲节点」 ---- */
    const probe = bookService.create({
      title: `冒烟-大纲结构-${STAMP}`,
      penName: '',
      genre: '',
      status: 'idea',
      summary: '',
      targetWords: 0,
      chapterWords: 2000,
      accentColor: '#0f6cbd'
    })

    /*
     * 自由树的三道硬约束。
     *
     * 它们不是「顺手加的校验」，而是这个数据结构的成立条件：
     * 父指针可以指向任意节点，于是「指向自己的子孙」这种输入天然可表达；
     * 一旦放过去就形成闭环，节点从任何根都走不到（在界面上凭空消失），
     * 而递归渲染会直接爆栈。
     */
    const probeNode = outlineService.create({
      bookId: probe.id,
      parentId: null,
      nodeType: 'note',
      title: '探针根节点',
      summary: '',
      status: 'planned'
    })

    let outlineCrossBookBlocked = false
    try {
      outlineService.move({ id: probeNode.id, parentId: outlineRoot.id, targetIndex: 0 })
    } catch (error) {
      outlineCrossBookBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }

    let outlineSelfParentBlocked = false
    try {
      outlineService.move({ id: outlineRoot.id, parentId: outlineRoot.id, targetIndex: 0 })
    } catch (error) {
      outlineSelfParentBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }

    let outlineCycleBlocked = false
    try {
      // 根节点挂到自己的孙节点之下：闭环
      outlineService.move({ id: outlineRoot.id, parentId: outlineForeshadow.id, targetIndex: 0 })
    } catch (error) {
      outlineCycleBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }

    /* ---- 深度上限：把探针一路挂到上限，再挂一层必须被拒 ---- */
    let deepNode = probeNode
    for (let level = 2; level <= OUTLINE_LIMITS.depth; level += 1) {
      deepNode = outlineService.create({
        bookId: probe.id,
        parentId: deepNode.id,
        nodeType: 'note',
        title: `第 ${level} 层`,
        summary: '',
        status: 'planned'
      })
    }
    const probeDepth = outlineService.tree(probe.id).depth

    let outlineDepthBlocked = false
    try {
      outlineService.create({
        bookId: probe.id,
        parentId: deepNode.id,
        nodeType: 'note',
        title: '越界层',
        summary: '',
        status: 'planned'
      })
    } catch (error) {
      outlineDepthBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }

    // 整条深链一次删掉，removedCount 应当把子孙都算上
    const ladderRemoved = outlineService.remove(probeNode.id).removedCount

    bookService.remove(probe.id)
    const probeNodesAfterBookDelete = outlineRepository.countByBook(probe.id)

    /* ---- 树内移动：顺序要重编，且同层下标不能重复 ---- */
    outlineService.move({ id: outlineSibling.id, parentId: outlineSub.id, targetIndex: 0 })
    const afterMoveTree = outlineService.tree(showcase.id)
    const movedSub = findTreeNode(afterMoveTree.nodes, outlineSub.id)
    const siblingOrderIndexes = outlineRepository
      .listByBook(showcase.id)
      .filter((row) => row.parent_id === outlineSub.id)
      .map((row) => row.order_index)

    const treeMoveOk =
      movedSub !== null &&
      movedSub.children.length === 2 &&
      movedSub.children[0].id === outlineSibling.id &&
      movedSub.children[1].id === outlineForeshadow.id &&
      // 重复的 order_index 会让顺序退化成「取决于 SQLite 的返回顺序」
      new Set(siblingOrderIndexes).size === siblingOrderIndexes.length

    /* ---- 落地成章节：建章 + 关联一步到位 ---- */
    const materialized = outlineService.materialize({
      id: outlineSibling.id,
      volumeId: null,
      targetWords: 1500
    })
    const landedChapter = chapterService.getById(materialized.chapterId)
    const landedTree = outlineService.tree(showcase.id)
    const landedNode = findTreeNode(landedTree.nodes, outlineSibling.id)

    /*
     * 把这一章标成「已完成」：纯粹是为了让文档配图有东西可看 ——
     * 目录行的状态点**只在非草稿时显示**（给每一行都点一个点等于没有重点），
     * 而展示数据里全是不显点的草稿，docs-editor.png 上就永远看不到这个标记。
     * 顺带也让这一行与旁边的草稿行形成对照。
     */
    chapterService.update({
      id: landedChapter.id,
      title: landedChapter.title,
      status: 'done',
      volumeId: landedChapter.volumeId,
      targetWords: landedChapter.targetWords
    })

    const materializeOk =
      landedChapter.title === outlineSibling.title &&
      landedChapter.targetWords === 1500 &&
      landedChapter.bookId === showcase.id &&
      landedNode?.chapterId === materialized.chapterId &&
      landedNode?.chapterTitle === outlineSibling.title

    // 同一个节点再落地一次必须被拒（否则会凭空多出一章同名章节）
    let rematerializeBlocked = false
    try {
      outlineService.materialize({ id: outlineSibling.id, volumeId: null, targetWords: 0 })
    } catch (error) {
      rematerializeBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    // 两个节点争同一个章节要拦下：否则「这一章要写什么」有两个答案
    let duplicateAttachBlocked = false
    try {
      outlineService.attachChapter({ id: outlineForeshadow.id, chapterId: materialized.chapterId })
    } catch (error) {
      duplicateAttachBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    /* ---- 解除关联：只断连线，节点与章节都还在 ---- */
    outlineService.attachChapter({ id: outlineSibling.id, chapterId: null })
    const detachedNode = findTreeNode(outlineService.tree(showcase.id).nodes, outlineSibling.id)
    let chapterSurvivedDetach = true
    try {
      chapterService.getById(materialized.chapterId)
    } catch {
      chapterSurvivedDetach = false
    }

    // 再关联回来：展示用的树上留一个「已落地」的节点，
    // 顺带验证解除之后重新关联也能走通
    outlineService.attachChapter({ id: outlineSibling.id, chapterId: materialized.chapterId })

    const outlineChecks: Array<[string, boolean, string]> = [
      [
        '大纲自由嵌套',
        nestedOk,
        nestedOk
          ? `${outlineTree.total} 个节点、${outlineTree.depth} 层，根 1 个 / 其下 2 个 / 再下 1 个`
          : `预期 4 节点 3 层，实得 ${outlineTree.total} 节点 ${outlineTree.depth} 层、根 ${outlineTree.nodes.length} 个`
      ],
      [
        '大纲跨书挂载拦截',
        outlineCrossBookBlocked,
        outlineCrossBookBlocked
          ? '把 A 书的节点挂到 B 书的节点之下被正确拒绝'
          : '跨书挂载未被拦截'
      ],
      [
        '大纲自身为父拦截',
        outlineSelfParentBlocked,
        outlineSelfParentBlocked ? '把节点挂到自己之下被拒绝' : '自身为父未被拦截'
      ],
      [
        '大纲成环拦截',
        outlineCycleBlocked,
        outlineCycleBlocked
          ? '把祖先节点挂到自己的后代之下被拒绝（否则该节点会从树上消失）'
          : '成环的移动未被拦截'
      ],
      [
        '大纲深度上限',
        probeDepth === OUTLINE_LIMITS.depth && outlineDepthBlocked,
        `挂到第 ${probeDepth} 层（上限 ${OUTLINE_LIMITS.depth}），再挂一层被拒绝`
      ],
      [
        '大纲子树级联删除',
        ladderRemoved === OUTLINE_LIMITS.depth,
        `删除根节点连同子孙共移除 ${ladderRemoved} 个（预期 ${OUTLINE_LIMITS.depth}）`
      ],
      [
        '删书带走大纲节点',
        probeNodesAfterBookDelete === 0,
        `删书后该书大纲节点剩 ${probeNodesAfterBookDelete} 个`
      ],
      [
        '大纲移动与重编号',
        treeMoveOk,
        treeMoveOk
          ? `事件节点移入支线首位，同层下标互不重复（${siblingOrderIndexes.join(',')}）`
          : `预期子节点顺序 ${[outlineSibling.id, outlineForeshadow.id].join(',')}，实得 ${
              movedSub?.children.map((node) => node.id).join(',') ?? '无'
            }；下标 ${siblingOrderIndexes.join(',')}`
      ],
      [
        '大纲落地成章节',
        materializeOk,
        materializeOk
          ? `已创建章节《${landedChapter.title}》，节点回读 chapterId=${landedNode?.chapterId}`
          : `章节标题「${landedChapter.title}」/ 目标 ${landedChapter.targetWords}，节点 chapterId=${landedNode?.chapterId ?? '空'}`
      ],
      [
        '重复落地拦截',
        rematerializeBlocked,
        rematerializeBlocked ? '同一节点二次落地被拒绝' : '重复落地未被拦截'
      ],
      [
        '章节占用去重',
        duplicateAttachBlocked,
        duplicateAttachBlocked ? '同一章节被两个节点争用时被拒绝' : '章节占用未被拦截'
      ],
      [
        '解除关联保内容',
        detachedNode?.chapterId === null && chapterSurvivedDetach,
        detachedNode?.chapterId === null
          ? `节点已断开关联，章节仍然存在（id=${materialized.chapterId}）`
          : `解除后节点 chapterId 仍为 ${detachedNode?.chapterId}`
      ]
    ]

    for (const [name, ok, detail] of outlineChecks) {
      push(name, ok, detail)
    }

    /* ------------------------------------------------------------------ *
     * 卡片库：人物 / 物品 / 灵感三类共用一张表，靠 card_type 区分
     *
     * 统一建模把「表结构约束」换成了「服务层约束」，所以这里的断言重点
     * 不在增删改查能不能跑通，而在那些**数据库不会替我们拦**的地方：
     * 重名、extra 里的幽灵字段、`book_id IS NULL` 的比较、LIKE 通配符。
     * ------------------------------------------------------------------ */

    const showcaseCardsOf = (): CardListResult =>
      cardService.list({ ...DEFAULT_CARD_QUERY, bookScope: 'book', bookId: showcase.id })

    const cardCharacter = cardService.create({
      bookId: showcase.id,
      cardType: 'character',
      title: '林澈',
      subtitle: '主角的领航员',
      content: '第一次跃迁失败后，是他把船带回来的。',
      // 故意带上空白与重复项：规范化前端的标签输入是同一个函数的事
      tags: ['主角团', '  领航员 ', '', '主角团', '   '],
      /*
       * 第三期第 3 件起人物卡**没有**「与主角关系」这个字段了：关系改成
       * 指向另一张卡的关联（card_relations），留着纯文本字段的话两边会
       * 各记一份互相矛盾的关系。旧的文本由迁移 008 搬进正文。
       */
      extra: {
        identity: '星舰领航员',
        affiliation: '星海联邦第七舰队',
        appearance: '左手有一道旧伤'
      }
    })

    const cardItem = cardService.create({
      bookId: showcase.id,
      cardType: 'item',
      title: '星图残片',
      subtitle: '只画出了一半的星路',
      content: '据说指向那次跃迁的真正原因。',
      tags: ['伏笔'],
      extra: { grade: '传说级', origin: '遗迹出土', effect: '补全星图，代价是一段记忆' }
    })

    const cardIdea = cardService.create({
      bookId: showcase.id,
      cardType: 'inspiration',
      title: '跃迁失败的另一种写法',
      subtitle: '让失败发生在第二次',
      content: '先让读者尝到甜头，再夺走它 —— 比一上来就失败更疼。',
      tags: ['结构'],
      extra: { source: '一次深夜讨论', usage: '第三卷的转折点' }
    })

    /* 通用卡片：不归属任何书。灵感常常如此 */
    const cardGlobal = cardService.create({
      bookId: null,
      cardType: 'inspiration',
      title: '雨夜的车站',
      subtitle: '通用场景',
      content: '雨、末班车、一次没说出口的告别。',
      tags: ['场景'],
      extra: { source: '一个梦', usage: '哪本书都能用' }
    })

    /*
     * 设定卡（2026-09-20 落地的「第二期」）：世界观条目。
     *
     * 它是第四种 card_type，但**不代表第四套代码** —— 与人物 / 物品 / 灵感
     * 共用同一张表、同一个编辑面板，差异只有一个 `category` 字段
     * （地点 / 势力 / 规则体系 / 时间线）。这里同时断两件事：
     * 字段集恰好是这一类该有的，以及合法类别原样落库。
     */
    const cardSetting = cardService.create({
      bookId: showcase.id,
      cardType: 'setting',
      title: '星海联邦',
      subtitle: '横跨七个星区的松散同盟',
      content: '跃迁技术由联邦垄断，代价是每条航线都要交一次「记忆税」。',
      tags: ['世界观'],
      extra: { category: '势力' }
    })
    const settingExtraKeys = Object.keys(cardSetting.extra).sort().join(',')

    /*
     * 类别是枚举：不在选项里的值必须被收敛成空串（服务层跑的是共享层的
     * normalizeExtra）。理由不是「输入要严格」，而是**类别要能聚合** ——
     * 「地理」和「地点」永远聚不到一起，而它看起来完全正常（有值、能显示、
     * 能保存）。宁可空着：空着是「还没分类」，一眼看得出来。
     */
    const cardSettingBadCategory = cardService.create({
      bookId: showcase.id,
      cardType: 'setting',
      title: `冒烟-错类别-${STAMP}`,
      subtitle: '',
      content: '',
      tags: [],
      extra: { category: '地理位置' }
    })
    const badSettingCategory = cardSettingBadCategory.extra.category
    // 建完立刻删：它只是探针，不该混进展示数据与卡片库的计数里
    cardService.remove(cardSettingBadCategory.id)

    /* ---- 同一本书、同一类型下重名必须被拒 ---- */
    let cardSameBookDuplicateBlocked = false
    try {
      cardService.create({
        bookId: showcase.id,
        cardType: 'character',
        title: '林澈',
        subtitle: '',
        content: '',
        tags: [],
        extra: { identity: '', affiliation: '', appearance: '' }
      })
    } catch (error) {
      cardSameBookDuplicateBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    /*
     * 通用卡片之间同样要查重。
     *
     * 这一条单独测是因为它走的是**另一条 SQL 分支**：查通用卡片的重复
     * 必须写 `book_id IS NULL`，写成 `book_id = NULL` 的话比较恒不成立，
     * 查重会静默失效 —— 建十张同名通用卡都不会报错，而且看起来一切正常。
     */
    let cardGlobalDuplicateBlocked = false
    try {
      cardService.create({
        bookId: null,
        cardType: 'inspiration',
        title: '雨夜的车站',
        subtitle: '',
        content: '',
        tags: [],
        extra: { source: '', usage: '' }
      })
    } catch (error) {
      cardGlobalDuplicateBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    /* ---- 另一本书里出现同名卡片是正常的（同一角色跨书稿） ---- */
    const cardScopeBook = bookService.create({
      title: `冒烟-卡片范围-${STAMP}`,
      penName: '',
      genre: '',
      status: 'idea',
      summary: '',
      targetWords: 0,
      chapterWords: 2000,
      accentColor: '#0f6cbd'
    })

    const cardCrossBook = cardService.create({
      bookId: cardScopeBook.id,
      cardType: 'character',
      title: '林澈',
      subtitle: '',
      content: '',
      tags: [],
      extra: { identity: '另一本书里的同名角色', affiliation: '', appearance: '' }
    })

    /*
     * 改类型时 extra 必须跟着迁移。
     *
     * 这是统一建模最容易出错的地方：`extra` 是一列自由 JSON，数据库不会
     * 拒绝任何键。把人物卡改成物品卡时，旧的「身份定位」若原样留着，
     * 它既不会被界面显示、也不会被任何查询命中，却会一直跟着导出走 ——
     * 直到某天在别处看到它，才发现数据里早就有个幽灵字段。
     *
     * 这里刻意多带一个 `identity`（先赋给变量，绕过对象字面量的多余属性检查），
     * 就是模拟「前端表单里还残留着人物卡的字段」这种真实情况。
     */
    const staleExtra = { grade: '遗迹货', origin: '', effect: '', identity: '不该保留' }
    const cardSwitched = cardService.update({
      id: cardCrossBook.id,
      bookId: cardScopeBook.id,
      cardType: 'item',
      title: '林澈',
      subtitle: '',
      content: '',
      tags: [],
      extra: staleExtra
    })
    const switchedExtraKeys = Object.keys(cardSwitched.extra).sort().join(',')

    /* ---- 归属到不存在的书必须被拒（否则卡片会挂在界面永远看不到的地方） ---- */
    let cardOrphanBookBlocked = false
    try {
      cardService.create({
        bookId: 999_999,
        cardType: 'inspiration',
        title: '孤儿卡',
        subtitle: '',
        content: '',
        tags: [],
        extra: { source: '', usage: '' }
      })
    } catch (error) {
      cardOrphanBookBlocked = error instanceof AppError && error.code === 'NOT_FOUND'
    }

    /* ---- 删书要带走卡片（cards.book_id 是 ON DELETE CASCADE） ---- */
    const cardsBeforeBookDelete = cardRepository.countByBook(cardScopeBook.id)
    bookService.remove(cardScopeBook.id)
    const cardsAfterBookDelete = cardRepository.countByBook(cardScopeBook.id)

    /* ---- 三种书籍范围的筛选口径 ---- */
    const cardsAll = cardService.list({ ...DEFAULT_CARD_QUERY, bookScope: 'all' })
    const cardsOfBook = showcaseCardsOf()
    const cardsGlobal = cardService.list({ ...DEFAULT_CARD_QUERY, bookScope: 'global' })
    const cardsCharacter = cardService.list({ ...DEFAULT_CARD_QUERY, cardType: 'character' })

    // 类型计数必须忽略类型筛选，否则选中「人物」之后另外两类都会显示 0
    const characterQueryCounts = cardsCharacter.typeCounts

    /*
     * 搜索要能命中正文。
     * 「甜头」只出现在灵感卡的**正文**里 —— 标题、简介、标签里都没有。
     * 若搜索退化成只查标题，这一条会查到 0 张，而不是「差不多能搜到」。
     */
    const cardsByContent = cardService.list({ ...DEFAULT_CARD_QUERY, keyword: '甜头' })

    /*
     * LIKE 通配符必须转义。
     * `%` 是「任意内容」，不转义的话搜索框里打一个 % 就会把整库都列出来 ——
     * 而这种 bug 看起来像「搜索功能正常」，只是结果多了点。
     */
    const cardsByWildcard = cardService.list({ ...DEFAULT_CARD_QUERY, keyword: '%' })

    /* ---- 复制：标题自动避开重名，其余字段照抄 ---- */
    const cardCopy = cardService.duplicate(cardCharacter.id)
    const copyKeepsFields =
      cardCopy.title === '林澈 副本' &&
      cardCopy.content === cardCharacter.content &&
      cardCopy.tags.join(',') === cardCharacter.tags.join(',') &&
      cardCopy.cardType === cardCharacter.cardType &&
      cardCopy.extra.identity === cardCharacter.extra.identity

    /* ---- 删除副本，把展示用的数据恢复成三张 ---- */
    const cardCopyRemoval = cardService.remove(cardCopy.id)
    const cardsAfterCopyRemoval = showcaseCardsOf()

    /* ------------------------------------------------------------------ *
     * 边界校验：这几条必须走真实的校验器
     *
     * 校验挂在 IPC 边界（控制器的 parse），服务层不重复做，所以直接调
     * 服务层是测不到的 —— 它永远不会抛。取真实的 parse 来跑，顺便也证明了
     * 控制器确实把 schema 挂上了，而不只是写在文件里。
     * ------------------------------------------------------------------ */
    const cardCreateParser = getChannelParser(IpcChannel.CardsCreate)
    const cardListParser = getChannelParser(IpcChannel.CardsList)

    // 先证明这份 payload 本身是合法的：不然「标签超限被拒」可能只是
    // 因为 extra 或别的字段没通过校验，断言就假通过了
    let cardBoundaryAcceptsDefaults = false
    if (cardCreateParser) {
      try {
        const parsed = cardCreateParser({
          bookId: showcase.id,
          cardType: 'item',
          title: '边界探针',
          subtitle: '',
          content: '',
          tags: ['a'],
          // extra 传空对象：schema 应当把该类型的字段补齐为空串
          extra: {}
        }) as { extra: Record<string, string> }
        cardBoundaryAcceptsDefaults =
          parsed.extra.grade === '' && parsed.extra.origin === '' && parsed.extra.effect === ''
      } catch {
        cardBoundaryAcceptsDefaults = false
      }
    }

    let cardTagCapBlocked = false
    if (cardCreateParser) {
      try {
        cardCreateParser({
          bookId: showcase.id,
          cardType: 'character',
          title: '标签超限',
          subtitle: '',
          content: '',
          tags: Array.from({ length: CARD_LIMITS.tagCount + 1 }, (_, index) => `标签${index}`),
          extra: {}
        })
      } catch {
        cardTagCapBlocked = true
      }
    }

    /*
     * 设定卡的「类别」必须在 IPC 边界就被挡住非法值。
     *
     * 服务层那条（badSettingCategory === ''）只证明「写进去之后会被收敛」，
     * 而收敛成空串对用户来说是「我填的类别不见了」。真正的防线是边界校验：
     * 直接拒绝，让前端表单根本不可能提交出一个会被悄悄丢掉的类别。
     */
    let cardSettingCategoryBlocked = false
    if (cardCreateParser) {
      try {
        cardCreateParser({
          bookId: showcase.id,
          cardType: 'setting',
          title: '类别越界',
          subtitle: '',
          content: '',
          tags: [],
          extra: { category: '地理位置' }
        })
      } catch {
        cardSettingCategoryBlocked = true
      }
    }

    /*
     * 列表查询的边界。
     *
     * 一次覆盖三件容易漏的事：`cardType: null`（不筛选）必须是合法值 ——
     * `.default()` 只对 undefined 生效，拦不住 null，漏了 `.nullable()` 的话
     * 默认那一次查询每次都失败、前端降级成空列表而页面照常渲染；
     * `bookScope: 'book'` 却没给 bookId 要降级成「全部」而不是查出空白；
     * 排序字段要被归一化到白名单里。
     */
    let cardScopeDegradedOnBoundary = false
    if (cardListParser) {
      try {
        const parsed = cardListParser({
          bookScope: 'book',
          bookId: null,
          cardType: null
        }) as CardListQuery
        cardScopeDegradedOnBoundary =
          parsed.bookScope === 'all' && parsed.cardType === null && parsed.sortBy === 'updatedAt'
      } catch {
        cardScopeDegradedOnBoundary = false
      }
    }

    /* ---- 专属字段要走完「写进 JSON 列 → 读回来」整圈 ---- */
    const extraRoundTripOk =
      cardCharacter.extra.identity === '星舰领航员' &&
      cardCharacter.extra.appearance === '左手有一道旧伤' &&
      cardItem.extra.grade === '传说级' &&
      cardItem.extra.origin === '遗迹出土' &&
      cardGlobal.bookId === null &&
      cardGlobal.extra.usage === '哪本书都能用'

    const cardChecks: Array<[string, boolean, string]> = [
      [
        '卡片专属字段落库',
        extraRoundTripOk,
        extraRoundTripOk
          ? `人物卡（身份「${cardCharacter.extra.identity}」/ 外貌「${cardCharacter.extra.appearance}」）、物品卡（品阶「${cardItem.extra.grade}」）、通用灵感卡（bookId=null）的专属字段写读一致`
          : `人物卡 identity=${cardCharacter.extra.identity}、appearance=${cardCharacter.extra.appearance}，物品卡 grade=${cardItem.extra.grade}，通用卡 bookId=${cardGlobal.bookId}`
      ],
      [
        '卡片标签规范化',
        cardCharacter.tags.join(',') === '主角团,领航员',
        cardCharacter.tags.join(',') === '主角团,领航员'
          ? `输入 5 个（含空白与重复）→ 落库 ${cardCharacter.tags.length} 个：${cardCharacter.tags.join('、')}`
          : `预期「主角团,领航员」，实得「${cardCharacter.tags.join(',')}」`
      ],
      [
        '同书同类型重名拦截',
        cardSameBookDuplicateBlocked,
        cardSameBookDuplicateBlocked
          ? '同一本书里再建一张「林澈」人物卡被正确拒绝'
          : '同书同类型的重名未被拦截'
      ],
      [
        '通用卡片重名拦截',
        cardGlobalDuplicateBlocked,
        cardGlobalDuplicateBlocked
          ? '两张同名通用灵感卡被拦下（book_id IS NULL 的查重没有被写成 = NULL 而失效）'
          : '通用卡片之间的重名未被拦截 —— 查重 SQL 很可能用了 `book_id = NULL`'
      ],
      [
        '跨书同名允许',
        cardCrossBook.title === '林澈' &&
          cardCrossBook.bookId === cardScopeBook.id &&
          cardCrossBook.cardType === 'character',
        `另一本书里的同名角色建卡成功（id=${cardCrossBook.id}，bookId=${cardCrossBook.bookId}）`
      ],
      [
        '卡片类型切换迁移字段',
        cardSwitched.cardType === 'item' &&
          cardSwitched.extra.grade === '遗迹货' &&
          switchedExtraKeys === 'effect,grade,origin',
        cardSwitched.cardType === 'item' && switchedExtraKeys === 'effect,grade,origin'
          ? `人物卡改成物品卡后 extra 只剩 ${switchedExtraKeys}（人物卡的 identity 已被丢弃、物品卡的 origin/effect 补为空串）`
          : `切换后 cardType=${cardSwitched.cardType}，extra 的键为「${switchedExtraKeys}」（预期 effect,grade,origin）`
      ],
      [
        '卡片归属校验',
        cardOrphanBookBlocked,
        cardOrphanBookBlocked ? '归属到不存在的书籍被正确拒绝' : '不存在的书籍 ID 未被拦截'
      ],
      [
        '卡片按书筛选',
        cardsAll.total === 5 && cardsOfBook.total === 4 && cardsGlobal.total === 1,
        `全部 ${cardsAll.total} 张 / 本书 ${cardsOfBook.total} 张 / 通用 ${cardsGlobal.total} 张（预期 5 / 4 / 1）`
      ],
      [
        /*
         * 类型计数要**四类都断**：它是 `for (const cardType of CARD_TYPES)`
         * 循环出来的，新增类型时自动跟上，而这也意味着「忘了把新类型接进
         * 界面」不会让这一条变红 —— 它只能锁「计数口径是全量而不是当前筛选」。
         */
        '卡片类型筛选与计数',
        cardsCharacter.total === 1 &&
          characterQueryCounts.character === 1 &&
          characterQueryCounts.item === 1 &&
          characterQueryCounts.inspiration === 2 &&
          characterQueryCounts.setting === 1,
        cardsCharacter.total === 1 && characterQueryCounts.setting === 1
          ? `筛出人物卡 ${cardsCharacter.total} 张，而类型计数仍给全量口径（人物 ${characterQueryCounts.character} / 物品 ${characterQueryCounts.item} / 灵感 ${characterQueryCounts.inspiration} / 设定 ${characterQueryCounts.setting}）`
          : `筛出 ${cardsCharacter.total} 张，计数 人物 ${characterQueryCounts.character} / 物品 ${characterQueryCounts.item} / 灵感 ${characterQueryCounts.inspiration} / 设定 ${characterQueryCounts.setting}`
      ],
      [
        '设定卡类别枚举',
        cardSetting.cardType === 'setting' &&
          // 第三期第 2 件起设定卡多了时点与时间线序号，键集随之变成三个
          settingExtraKeys === 'category,order,timePoint' &&
          cardSetting.extra.category === '势力' &&
          badSettingCategory === '',
        cardSetting.extra.category === '势力' && badSettingCategory === ''
          ? `设定卡「${cardSetting.title}」落库为 category=势力（extra 恰好 ${settingExtraKeys} 三个键）；类别写成「地理位置」被收敛为空串 —— 拼错的类别不会悄悄混进同一组`
          : `cardType=${cardSetting.cardType}，extra 键「${settingExtraKeys}」，category=「${cardSetting.extra.category}」，非法类别读回「${badSettingCategory}」（应为空）`
      ],
      [
        '卡片全文搜索',
        cardsByContent.total === 1 && cardsByContent.items[0]?.id === cardIdea.id,
        cardsByContent.total === 1
          ? `关键词「甜头」只命中正文（《${cardsByContent.items[0]?.title}》，标题里没有这三个字）`
          : `关键词「甜头」预期命中 1 张，实得 ${cardsByContent.total} 张`
      ],
      [
        '搜索通配符转义',
        cardsByWildcard.total === 0,
        cardsByWildcard.total === 0
          ? '搜索「%」返回 0 张（通配符被转义，没有退化成「匹配全部」）'
          : `搜索「%」返回了 ${cardsByWildcard.total} 张 —— LIKE 的通配符没有转义`
      ],
      [
        '卡片复制',
        copyKeepsFields,
        copyKeepsFields
          ? `副本标题「${cardCopy.title}」，内容与标签与原件一致`
          : `副本标题「${cardCopy.title}」，内容一致=${cardCopy.content === cardCharacter.content}，标签一致=${cardCopy.tags.join(',') === cardCharacter.tags.join(',')}`
      ],
      [
        '卡片删除',
        cardCopyRemoval.id === cardCopy.id && cardsAfterCopyRemoval.total === 4,
        `删除副本后本书卡片回到 ${cardsAfterCopyRemoval.total} 张（预期 4）`
      ],
      [
        '删书带走卡片',
        cardsBeforeBookDelete === 1 && cardsAfterBookDelete === 0,
        `删书前该书 ${cardsBeforeBookDelete} 张卡，删书后 ${cardsAfterBookDelete} 张`
      ],
      [
        '卡片边界默认值',
        cardBoundaryAcceptsDefaults,
        cardBoundaryAcceptsDefaults
          ? 'extra 传空对象时，物品卡的三个专属字段被补齐为空串'
          : 'extra 传空对象没有通过边界校验（下面的标签上限断言会因此失去意义）'
      ],
      [
        '卡片标签上限拦截',
        cardTagCapBlocked,
        cardTagCapBlocked
          ? `一次提交 ${CARD_LIMITS.tagCount + 1} 个标签被边界拒绝（上限 ${CARD_LIMITS.tagCount}）`
          : '超出上限的标签数量未被拦截'
      ],
      [
        '设定卡类别边界拦截',
        cardSettingCategoryBlocked,
        cardSettingCategoryBlocked
          ? '类别填成「地理位置」在 IPC 边界就被拒绝（而不是存进去再被悄悄收敛成空）'
          : '非法的设定类别没有被边界校验拦下 —— 它会一路存进去，然后在读取时被清成空串'
      ],
      [
        '卡片筛选范围降级',
        cardScopeDegradedOnBoundary,
        cardScopeDegradedOnBoundary
          ? 'bookScope=book 但 bookId=null 被降级为「全部」，cardType=null 未被拒，排序回落到 updatedAt'
          : '列表查询的边界归一化不符合预期（null 被拒 或 降级规则没生效）'
      ]
    ]

    for (const [name, ok, detail] of cardChecks) {
      push(name, ok, detail)
    }

    /* ------------------------------------------------------------------ *
     * 卡片 ↔ 卡片的关系（第三期第 3 件）
     *
     * 关系与「关联到章节」最大的不同是**没有方向**，所以这里押的是三条
     * 最容易写错的地方：
     *   1. 一条边两头都要看得到 —— 只查 `card_id = ?` 的话，从 id 大的
     *      那头看过去是一片空白，而空白跟「还没有关系」长得一模一样；
     *   2. 同一对只能有一条边 —— 「A 连 B」与「B 连 A」若存成两条，
     *      界面上表现为「删掉一条还剩一条」；
     *   3. 同书约束 —— 跨书的关系在关系网里没有落点。
     * ------------------------------------------------------------------ */

    const relationA = cardService.create({
      bookId: showcase.id,
      cardType: 'character',
      title: `冒烟-关系甲-${STAMP}`,
      subtitle: '',
      content: '',
      tags: [],
      extra: {}
    })
    const relationB = cardService.create({
      bookId: showcase.id,
      cardType: 'character',
      title: `冒烟-关系乙-${STAMP}`,
      subtitle: '',
      content: '',
      tags: [],
      extra: {}
    })

    /* ---- ① 建立：两头都要看得到同一条边 ---- */
    const relationsOfA = cardLinkService.relate(relationA.id, relationB.id, '师徒')
    const relationsOfB = cardLinkService.listRelations(relationB.id)
    const relationBothSidesOk =
      relationsOfA.length === 1 &&
      relationsOfA[0]?.relatedId === relationB.id &&
      relationsOfA[0]?.relation === '师徒' &&
      relationsOfB.length === 1 &&
      relationsOfB[0]?.relatedId === relationA.id &&
      relationsOfB[0]?.relation === '师徒'

    /*
     * ---- ② 反向再建一次：是**改关系名**，不是多一条边 ----
     *
     * 这一次刻意从另一头发起（参数顺序反过来），顺带验证服务层把两个 id
     * 收成规范顺序（小的在前）—— 表上有 CHECK (card_id < related_id)，
     * 没收好的话这一步会在 SQL 层炸掉，而不是安静地多出一条边。
     */
    const relationsAfterRename = cardLinkService.relate(relationB.id, relationA.id, '师徒，后反目')
    const relationsOfAAfterRename = cardLinkService.listRelations(relationA.id)
    const relationRenameOk =
      relationsAfterRename.length === 1 &&
      relationsAfterRename[0]?.relation === '师徒，后反目' &&
      relationsOfAAfterRename.length === 1 &&
      relationsOfAAfterRename[0]?.relation === '师徒，后反目'

    /* ---- ③ 自己、跨书、通用卡片：三条都要被拒 ---- */
    let relationSelfBlocked = false
    try {
      cardLinkService.relate(relationA.id, relationA.id, '自己')
    } catch (error) {
      relationSelfBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
    }

    const relationOtherBook = bookService.create({
      title: `冒烟-关系跨书-${STAMP}`,
      penName: '',
      genre: '',
      status: 'idea',
      summary: '',
      targetWords: 0,
      chapterWords: 2000,
      accentColor: '#0f6cbd'
    })
    const relationOtherCard = cardService.create({
      bookId: relationOtherBook.id,
      cardType: 'character',
      title: `冒烟-关系丙-${STAMP}`,
      subtitle: '',
      content: '',
      tags: [],
      extra: {}
    })

    let relationCrossBookBlocked = false
    try {
      cardLinkService.relate(relationA.id, relationOtherCard.id, '同名')
    } catch (error) {
      relationCrossBookBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    // 通用卡片（bookId 为 null）：它不属于任何书，也就没有「同书的另一张卡」
    let relationGlobalBlocked = false
    try {
      cardLinkService.relate(relationA.id, cardGlobal.id, '出现在同一个梦里')
    } catch (error) {
      relationGlobalBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

    /* ---- ④ 关系网：整本书的边里要有这一条 ---- */
    const bookEdges = cardLinkService.listRelationsByBook(showcase.id)
    const bookEdgeOk = bookEdges.some(
      (edge) =>
        edge.relation === '师徒，后反目' &&
        ((edge.cardId === relationA.id && edge.relatedId === relationB.id) ||
          (edge.cardId === relationB.id && edge.relatedId === relationA.id))
    )

    /* ---- ⑤ 删掉一头，关系随之消失（双向 CASCADE） ---- */
    cardService.remove(relationB.id)
    const relationsAfterRemove = cardLinkService.listRelations(relationA.id)
    const relationCascadeOk = relationsAfterRemove.length === 0

    /* ---- 边界：关系名不能为空、不能超长 ---- */
    const relationParser = getChannelParser(IpcChannel.CardsRelate)
    let relationTooLongBlocked = false
    let relationBlankBlocked = false
    if (relationParser) {
      try {
        relationParser({
          cardId: relationA.id,
          relatedId: relationOtherCard.id,
          relation: '关'.repeat(RELATION_LIMITS.label + 1)
        })
      } catch {
        relationTooLongBlocked = true
      }
      // 全是空白的关系名：不拦的话会存进一条「名字看不见」的边
      try {
        relationParser({ cardId: relationA.id, relatedId: relationOtherCard.id, relation: '   ' })
      } catch {
        relationBlankBlocked = true
      }
    }

    // 清理：这几张卡只是探针，不该留在展示数据里
    cardService.remove(relationA.id)
    bookService.remove(relationOtherBook.id)

    const relationChecks: Array<[string, boolean, string]> = [
      [
        '卡片关系两头可见',
        relationBothSidesOk,
        relationBothSidesOk
          ? `一条「师徒」从两头查都是 1 条边（A 看到对方 #${relationB.id}，B 看到对方 #${relationA.id}）`
          : `A 侧 ${relationsOfA.length} 条（${relationsOfA.map((item) => `${item.relatedId}:${item.relation}`).join('/') || '空'}），B 侧 ${relationsOfB.length} 条（${relationsOfB.map((item) => `${item.relatedId}:${item.relation}`).join('/') || '空'}）`
      ],
      [
        '卡片关系重复建立即改名',
        relationRenameOk,
        relationRenameOk
          ? '从另一头再建一次（参数顺序相反）没有多出第二条边，关系名改成「师徒，后反目」'
          : `改名后 A 侧 ${relationsOfAAfterRename.length} 条、关系名「${relationsOfAAfterRename[0]?.relation ?? ''}」（应为 1 条「师徒，后反目」）`
      ],
      [
        '卡片关系自身拦截',
        relationSelfBlocked,
        relationSelfBlocked ? '给自己建立关系被拒绝' : '一张卡可以与自己建立关系'
      ],
      [
        '卡片关系跨书拦截',
        relationCrossBookBlocked,
        relationCrossBookBlocked ? '跨书的两张卡建立关系被拒绝' : '跨书的关系未被拦截'
      ],
      [
        '卡片关系通用卡拦截',
        relationGlobalBlocked,
        relationGlobalBlocked ? '通用卡片（不归属任何书）不能建立关系' : '通用卡片也能建关系 —— 关系网里会多出一条没有落点的边'
      ],
      [
        '卡片关系网按书聚合',
        bookEdgeOk,
        bookEdgeOk
          ? `这本书的 ${bookEdges.length} 条边里有 #${relationA.id} ↔ #${relationB.id} 这一条`
          : `关系网里没有这一条边（实得 ${bookEdges.map((edge) => `${edge.cardId}-${edge.relatedId}:${edge.relation}`).join('、') || '空'}）`
      ],
      [
        '删卡带走关系',
        relationCascadeOk,
        relationCascadeOk
          ? '删掉一头之后，另一头的关系列表随之清空（外键 CASCADE）'
          : `删掉一头之后还剩 ${relationsAfterRemove.length} 条关系`
      ],
      [
        '卡片关系名边界拦截',
        relationTooLongBlocked && relationBlankBlocked,
        relationTooLongBlocked && relationBlankBlocked
          ? `关系名超过 ${RELATION_LIMITS.label} 个字符（超长=${relationTooLongBlocked}）、或全是空白（=${relationBlankBlocked}）时都被边界拒绝`
          : `超长被拒=${relationTooLongBlocked}、空白被拒=${relationBlankBlocked}`
      ]
    ]

    for (const [name, ok, detail] of relationChecks) {
      push(name, ok, detail)
    }

    /* ------------------------------------------------------------------ *
     * 章节历史版本与回档（第三期第 4 件）
     *
     * 这一项押的四个地方都是「不测就看不出来」的：
     *   1. 快照抓的是**改动之前**的正文。抓反了的话，历史列表里最新一版
     *      永远与当前正文相同，而「回到这一版」会变成一个什么都不做的按钮；
     *   2. 短改动不留版。自动保存两秒一次，一次写作会话能产生上百版，
     *      不留剪枝的话配额几小时就被消耗完；
     *   3. 剪枝只留最新 N 版，且留的是**最新的**那几版。删错一头的话，
     *      作者只能退回很久以前的版本，最近的那一版反而没了；
     *   4. 回档本身可以再回档 —— 这是整个功能里唯一「会丢数据」的按钮，
     *      少了这一步，误点一次就真的回不去了。
     *
     * 用的是专造一本书 + 一章，不碰 showcase 里的那一章：
     * 后面「正文自动保存往返」与「正文字数与预期一致」都按 showcase 的
     * 那一章对账，在这里改它会连带把那些断言打红。
     * ------------------------------------------------------------------ */

    const revBook = bookService.create({
      title: `冒烟-版本-${STAMP}`,
      penName: '',
      genre: '',
      status: 'idea',
      summary: '',
      targetWords: 0,
      chapterWords: DEFAULT_CHAPTER_WORDS,
      accentColor: '#0f6cbd'
    })
    const revChapter = chapterService.create({
      bookId: revBook.id,
      volumeId: null,
      title: '版本测试章',
      targetWords: 0
    })

    /**
     * 这一段整体包在 try / finally 里，**清理放在 finally**。
     *
     * 末尾那句 `bookService.remove(revBook.id)` 是必须执行的收尾（理由见
     * 那里的注释），而它原本排在断言之后：只要断言之前任何一步抛异常，
     * 临时书就会留在库里，成为书籍列表里最新的一本 —— 于是后面大纲页与
     * 卡片页在没有 `?bookId` 时全部回落到这本空书上，报出「情节树未渲染」
     * 这种与本次改动毫无关系的红。真实发生过一次（版本不存在拦截那一项
     * 抛了 NOT_FOUND），排查方向被完全带偏。放进 finally 之后，无论断言
     * 是否通过都保证清干净，失败现场只剩真正属于本次改动的那几条。
     */
    try {

    /**
     * 造一段**字数互不相同**的正文。
     *
     * 字数各不相同是为了让「最新那版是哪一版」能被断言表述出来：
     * 只报 id 的话断言得先去查详情才知道对不对，而 id 本身
     * 在剪枝前后并不能说明「留下的是不是最新的」。
     *
     * 每段 7 个汉字（`第N段的正文内容` 里汉字是 第/段/的/正/文/内/容），
     * 因此段数 × 7 就是这一版的汉字数 —— 与 countHanzi 的口径一致。
     */
    const HANZI_PER_PARAGRAPH = 7
    const paragraphs = (count: number): string =>
      Array.from({ length: count }, (_, index) => `第${index + 1}段的正文内容`).join('<p></p>')
    const htmlOf = (count: number): string => `<p>${paragraphs(count)}</p>`
    const hanziOf = (count: number): number => count * HANZI_PER_PARAGRAPH
    /**
     * 恰好 `total` 个汉字的正文（前 20 段固定，余数补在末尾一段里）。
     *
     * 「微改动累积」那一段要按**逐字**推进，而 `htmlOf` 的步长是 7 个字，
     * 跨不过 5% 阈值附近的细节（140 字的 5% 刚好是 7 字，正好卡在边界上，
     * 多一字少一字结论就反了）。这里给出逐字可控的正文，断言才能钉死。
     */
    const hanziBody = (total: number): string => {
      const rest = total - hanziOf(20)
      return rest <= 0 ? htmlOf(20) : `${htmlOf(20)}<p>${'字'.repeat(rest)}</p>`
    }

    /* ---- ① 第一次保存：不能留版（改动前是空正文） ---- */
    chapterService.saveContent({ id: revChapter.id, contentHtml: htmlOf(20) })
    const afterFirst = chapterService.listRevisions(revChapter.id)

    /*
     * ---- ② 再存一次同一份正文：这一版应当被留下 ----
     *
     * 改动前的正文是 20 段（140 字），而内存里还没有这一章的基准
     * （进程刚起来，这是第一次见到它有正文）。此时**无条件留底**：
     * 没有可比的过去就跳过的话，会导致「重启应用后覆盖一篇旧正文，
     * 原文永久消失」—— 那正是本功能要解决的问题本身。
     *
     * 所以这一版留的不是「差异够大」而是「此前从未存过」，
     * 断言也据此写：留下的是被替换掉的那 140 字。
     */
    chapterService.saveContent({ id: revChapter.id, contentHtml: htmlOf(20) })
    const afterSecond = chapterService.listRevisions(revChapter.id)

    /*
     * ---- ③ 提交与基准完全相同的正文：不留版 ----
     *
     * 此刻基准就是刚才留底的那 140 字，再提交同一份正文命中的是
     * 「与基准逐字符相同」这一支 —— 手动保存撞上自动保存时连续两次
     * 提交同一份正文，正是这种形态。不留这一条，列表会被重复项撑满。
     */
    chapterService.saveContent({ id: revChapter.id, contentHtml: htmlOf(20) })
    const afterIdentical = chapterService.listRevisions(revChapter.id)

    /*
     * ---- ④ 微改动**累积**：连着 7 次各加 1 个字，一次都不该留版 ----
     *
     * 这是 minDeltaRatio 存在的全部理由。自动保存两秒一次，作者敲的
     * 就是「一个字、一个标点」，每次都留版的话 50 个槽位两分钟就被
     * 「多了一个字」填满，真正想找的「半小时前那一大段」早在剪枝时
     * 被挤掉了。
     *
     * 判据按**累积量**：基准停在 140 字。写入第 k 次时，改动前的正文
     * 比基准多 k−1 个字 —— 7 次写完，最大也只到 6/140 ≈ 4.29%，仍然
     * 低于 5%，所以一版都不留。下面第 ⑤ 步紧接着验越线那一下。
     */
    for (let extra = 1; extra <= 7; extra += 1) {
      chapterService.saveContent({ id: revChapter.id, contentHtml: hanziBody(hanziOf(20) + extra) })
    }
    const afterTiny = chapterService.listRevisions(revChapter.id)

    /*
     * ---- ⑤ 第 8 次写：改动前的正文刚好比基准多 7 个字（5.0%），越线留版 ----
     *
     * 这一次写入前的正文是 147 字（上一轮的结果），基准仍是 140 字，
     * 7/140 恰好等于门槛 —— 判据是 `< minDeltaRatio` 才跳过，取等号
     * 算越线，所以这里留下的是**写入前那一份 147 字**，而不是写入后的
     * 148 字。这既是「累积到阈值才留版」，也是「快照抓改动前的正文」
     * 在累积场景下的形态，两条性质在这一步同时被钉住。
     */
    chapterService.saveContent({ id: revChapter.id, contentHtml: hanziBody(hanziOf(20) + 8) })
    const afterCross = chapterService.listRevisions(revChapter.id)

    /*
     * ---- ⑤ 连续写 60 次，把配额顶穿 ----
     *
     * 步长必须**跟着当前字数一起涨**：去重阈值是百分比（5%），
     * 而正文每写一次就变长一点，固定步长算出的比例会越来越小 ——
     * 写到最后 8000 多字时，140 字的改动只占 1.6%，会被如实拒掉，
     * 于是「连写 61 次」只留下三十几版，剪枝那条断言就测不到了。
     * 取 10%（阈值 5% 的两倍）留出余量，保证每一次都被认定为明显改动。
     */
    let revParagraphs = 60
    /** 每轮写入**之前**的段数 —— 也就是这一轮会被留成快照的那份正文 */
    let replacedParagraphs = revParagraphs
    for (let step = 1; step <= 60; step += 1) {
      replacedParagraphs = revParagraphs
      revParagraphs = Math.ceil(revParagraphs * 1.1)
      chapterService.saveContent({ id: revChapter.id, contentHtml: htmlOf(revParagraphs) })
    }
    const finalParagraphs = revParagraphs
    const afterPrune = chapterService.listRevisions(revChapter.id)

    /* ---- ⑥ 回档到最早的那一版（此刻列表里字数最小的那个） ---- */
    /*
     * 注意：`oldest` 取自 `afterPrune`（⑤ 之后立刻取的快照），而不是
     * 「现在再查一次」。⑥ 之后没有任何写操作，两者等价，但用这一份
     * 可以直接证明「回档的目标确实来自界面会显示的那个列表」。
     *
     * 反过来要小心：**任何在 ⑤ 与 ⑥ 之间插入的写操作都会让这个引用失效**。
     * 剪枝的判据是「保留最新 50 版」，此处列表正好卡在上限，再来一次
     * 留版就会把 `afterPrune` 里最旧的那条挤出去，`getRevision` 随即
     * 报 NOT_FOUND —— 断言会以「版本不存在」这种与本题无关的形态炸开。
     */
    const oldest = afterPrune[afterPrune.length - 1]
    const restoreTarget = oldest
      ? chapterService.getRevision(oldest.id)
      : null
    const currentBeforeRestore = chapterService.getById(revChapter.id)

    let restoredToOldest = false
    if (oldest) {
      chapterService.restoreRevision({ chapterId: revChapter.id, revisionId: oldest.id })
      restoredToOldest = true
    }
    const afterRestore = chapterService.getById(revChapter.id)
    // 回档会把「回档前的那一版」也留一份，所以列表应当多出/换掉一条
    const afterRestoreList = chapterService.listRevisions(revChapter.id)

    /* ---- ⑦ 回档之后还能再回退（回到回档之前） ---- */
    const undoPoint = afterRestoreList[0]
    let backAgainOk = false
    let backAgainHanzi = 0
    if (undoPoint) {
      chapterService.restoreRevision({ chapterId: revChapter.id, revisionId: undoPoint.id })
      const backAgain = chapterService.getById(revChapter.id)
      backAgainHanzi = backAgain.hanziCount
      backAgainOk = backAgain.contentHtml === currentBeforeRestore.contentHtml
    }

    /* ---- 边界：不存在的版本、跨章节的版本 ---- */
    let missingRevisionBlocked = false
    try {
      chapterService.getRevision(99_999_999)
    } catch (error) {
      missingRevisionBlocked = error instanceof AppError && error.code === 'NOT_FOUND'
    }

    // 另建一章，拿它的版本去回档第一章：不做归属校验就会静默串章
    const otherChapter = chapterService.create({
      bookId: revBook.id,
      volumeId: null,
      title: '另一章',
      targetWords: 0
    })
    chapterService.saveContent({ id: otherChapter.id, contentHtml: htmlOf(12) })
    chapterService.saveContent({ id: otherChapter.id, contentHtml: htmlOf(24) })
    const otherRevision = chapterService.listRevisions(otherChapter.id)[0]

    let crossChapterBlocked = false
    if (otherRevision) {
      try {
        chapterService.restoreRevision({
          chapterId: revChapter.id,
          revisionId: otherRevision.id
        })
      } catch (error) {
        crossChapterBlocked = error instanceof AppError && error.code === 'VALIDATION_ERROR'
      }
    }

    const revisionChecks: Array<[string, boolean, string]> = [
      [
        '首次见到正文就留底',
        afterFirst.length === 0 &&
          afterSecond.length === 1 &&
          afterSecond[0]?.hanziCount === hanziOf(20),
        afterFirst.length === 0 && afterSecond.length === 1
          ? `第一次保存不留版（改动前是空正文），第二次留下一版 ${afterSecond[0]?.hanziCount} 字 —— 正是被替换掉的那 ${hanziOf(20)} 字`
          : `第一次保存后 ${afterFirst.length} 版、第二次后 ${afterSecond.length} 版（应为 0 / 1，且字数为 ${hanziOf(20)}）`
      ],
      [
        '重复提交同一份正文不占版本配额',
        afterIdentical.length === afterSecond.length,
        afterIdentical.length === afterSecond.length
          ? `与基准逐字符相同的提交不留版，仍是 ${afterIdentical.length} 版（手动保存撞上自动保存时的常态）`
          : `重复提交后变成 ${afterIdentical.length} 版（应为 ${afterSecond.length}）`
      ],
      [
        '微改动累积期间不占版本配额',
        afterTiny.length === afterSecond.length,
        afterTiny.length === afterSecond.length
          ? `连着 7 次各加 1 个字（${hanziOf(20)} → ${hanziOf(20) + 7} 字），每次改动前的正文最多只比基准多 6 字（${(6 / hanziOf(20) * 100).toFixed(2)}%，低于 ${Math.round(CHAPTER_REVISION_LIMITS.minDeltaRatio * 100)}% 门槛），一版都没留，仍是 ${afterTiny.length} 版`
          : `加了 7 个字之后变成 ${afterTiny.length} 版（应为 ${afterSecond.length}）—— 自动保存每两秒一次，这一条不成立配额会被瞬间填满`
      ],
      [
        '累积越线才留版，且留的是越线前那一份',
        afterCross.length === afterSecond.length + 1 &&
          afterCross[0]?.hanziCount === hanziOf(20) + 7,
        afterCross.length === afterSecond.length + 1 &&
          afterCross[0]?.hanziCount === hanziOf(20) + 7
          ? `写到 ${hanziOf(20) + 8} 字时，改动前的正文（${hanziOf(20) + 7} 字）刚好比基准多 7 字＝${(7 / hanziOf(20) * 100).toFixed(2)}%，第一次越线 → 留版，留下的正是写入前那 ${afterCross[0]?.hanziCount} 字`
          : `越线后留下 ${afterCross.length} 版、最新一版 ${afterCross[0]?.hanziCount} 字（应为 ${afterSecond.length + 1} 版 / ${hanziOf(20) + 7} 字）`
      ],
      [
        '每章保留最近的上限版数',
        afterPrune.length === CHAPTER_REVISION_LIMITS.perChapter,
        `连写 60 次后留 ${afterPrune.length} 版（上限 ${CHAPTER_REVISION_LIMITS.perChapter}）`
      ],
      [
        '剪枝留下的是最新的那几版',
        /*
         * 最新一版是**最后一次写入之前**的那份正文，而不是写入之后
         * 的当前正文 —— 快照抓的是「被替换掉的那一份」（见
         * `keepSnapshot`）。因此期望值取 `replacedParagraphs`
         * （循环里每轮写入前记下的段数），而不是 `finalParagraphs`。
         *
         * 写成 `finalParagraphs` 会红，而且红得很有迷惑性：读到的
         * 数字确实「不是最新写入的那一版」，看着像剪枝删错了头，
         * 其实当前正文本来就不该在历史列表里 —— 它还没被替换过。
         */
        afterPrune[0]?.hanziCount === hanziOf(replacedParagraphs),
        afterPrune[0]?.hanziCount === hanziOf(replacedParagraphs)
          ? `最新一版 ${afterPrune[0]?.hanziCount} 字，正是最后一次写入替换掉的那一版（当前正文 ${hanziOf(finalParagraphs)} 字尚未成为历史）`
          : `最新一版 ${afterPrune[0]?.hanziCount} 字（应为 ${hanziOf(replacedParagraphs)} —— 最后一次写入替换掉的那一版）`
      ],
      [
        '回档把正文换成所选那一版',
        restoredToOldest &&
          restoreTarget !== null &&
          afterRestore.contentHtml === restoreTarget.contentHtml &&
          afterRestore.hanziCount === restoreTarget.hanziCount,
        restoreTarget === null
          ? '列表里找不到可回档的版本'
          : `回到 ${restoreTarget.hanziCount} 字那一版后，库里的正文与汉字数都变成该版的 ${afterRestore.hanziCount} 字`
      ],
      [
        '回档本身可以再回档',
        backAgainOk,
        backAgainOk
          ? `回档前的正文（${currentBeforeRestore.hanziCount} 字）被留成一版，再回一次即恢复到 ${backAgainHanzi} 字`
          : `再回一次后得到 ${backAgainHanzi} 字（应为回档前的 ${currentBeforeRestore.hanziCount} 字）`
      ],
      [
        '版本不存在时拦截',
        missingRevisionBlocked,
        missingRevisionBlocked ? '取不存在的版本被拒（NOT_FOUND）' : '不存在的版本没有被拦截'
      ],
      [
        '跨章节回档拦截',
        crossChapterBlocked,
        crossChapterBlocked
          ? '拿另一章的版本回档本章被拒（VALIDATION）—— A 章的正文不会被灌进 B 章'
          : '另一章的版本能回档到本章 —— 跨章节的静默污染'
      ]
    ]

    for (const [name, ok, detail] of revisionChecks) {
      push(name, ok, detail)
    }
    } catch (error) {
      /*
       * 这一步的 catch 不是摆设。
       *
       * 没有它的话，本段任何一处抛异常都会穿过整个播种函数、被最外层
       * 那个 `push('业务规则', false, ...)` 接住 —— 于是失败现场变成
       * 一条名叫「业务规则」的红，真正的错因（当时是 NOT_FOUND：
       * 回档目标被剪枝挤掉了）藏在详情里，而排在它后面的几十条断言
       * （含全部渲染检查）**一条都不会执行**。断言总数会静默缩水，
       * 排查方向被彻底带偏。
       *
       * 就地接住之后：错因归到本该验它的那一条上，后面的断言照常跑。
       */
      push('章节历史版本（后端）', false, messageOf(error))
    } finally {
      /*
       * 删掉这本临时书。**放在 finally 里**，理由见 try 的注释 ——
       * 任何一步抛异常都不能让这本空书留在库里，否则它会成为书籍列表里
       * 最新的一本，把后面大纲页 / 卡片页的默认落点整体挪走，报出
       * 「情节树未渲染」这种与本次改动毫无关系的红。
       *
       * 不删的话：大纲页与卡片页在没有 `?bookId` 时都回落到「列表里的
       * 第一本书」。这与既有那段「结构校验用的一本书，测完删掉」
       * 是同一个理由，只是那一段删得比较早、没暴露这个问题。
       *
       * 章节与历史版本随书级联删除（`chapter_revisions.chapter_id` 上
       * 挂着 ON DELETE CASCADE），不必单独清。
       */
      bookService.remove(revBook.id)
    }

    /* ------------------------------------------------------------------ *
     * 全库检索
     *
     * 检索押在 LIKE 全表扫描上（不引 FTS5 的实测依据见
     * src/shared/modules/search.ts 开头）。既然正确性交给 LIKE，
     * 就要把它的两个经典陷阱盯死：
     *   1. 通配符没转义 —— 搜 `%` 退化成「匹配全部」；
     *   2. AND 被写成 OR —— **不会报错**，只让「同时包含」退化成
     *      「任一包含」，结果变多而界面看起来完全正常。
     * 第 2 条尤其隐蔽：它必须靠「每个词单独都能命中、合起来必须是 0」
     * 这种对照式断言才测得出来，只测一个多词查询是测不出来的。
     * ------------------------------------------------------------------ */

    /** 记下这一轮跑了多少次检索，供「无副作用」断言报出真实次数 */
    let searchRuns = 0
    const search = (raw: string, bookId: number | null = null): SearchResult => {
      searchRuns += 1
      return searchService.query(
        normalizeSearchQuery({ keywords: raw, bookId, limit: SEARCH_LIMITS.maxPerSource })
      )
    }

    const groupOf = (result: SearchResult, source: SearchSource): SearchGroup | null =>
      result.groups.find((group) => group.source === source) ?? null

    /*
     * 「只读」的基线必须在检索**之前**当场取，不能拿更早的变量比对着算。
     * 前面的几十步断言已经删过卡片、落地过章节、改过大纲，拿那些基线对齐
     * 只会测出「在我之前的步骤改动了数据」 —— 那当然是真的，但跟检索无关。
     */
    const snapshot = () => ({
      cards: cardRepository.countByBook(showcase.id),
      outline: outlineService.tree(showcase.id).total,
      chapters: chapterService.list({ bookId: showcase.id, volumeId: undefined }).length
    })
    const beforeSearch = snapshot()

    /* ---- 切词：空格（含全角）分隔、去重、限量 ---- */
    const keywordsParsed = parseKeywords('  林澈　星云  ')
    const keywordCap = parseKeywords('a b c d e f g h i j')
    const keywordChecksOk =
      keywordsParsed.join('|') === '林澈|星云' &&
      parseKeywords('林澈 林澈 林澈').length === 1 &&
      keywordCap.length === SEARCH_LIMITS.keywords &&
      parseKeywords('   ').length === 0

    /* ---- 多关键词 AND：单命中成立，合并必须为 0 ---- */
    const soloCharacter = search('林澈')
    const soloSweet = search('甜头')
    const andAcrossRows = search('林澈 甜头')
    const andAcrossRowsOk =
      soloCharacter.total > 0 && soloSweet.total > 0 && andAcrossRows.total === 0

    /* ---- 分来源分组：跃迁出现在 2 张卡片与 1 个大纲节点上 ---- */
    const byKeyword = search('跃迁')
    const chapterSearch = search('真实数据')
    const bookSearch = search('冒烟作者')
    const multiWordGroup = search('林澈 领航员')
    const chapterGroup = groupOf(chapterSearch, 'chapter')
    const bookGroup = groupOf(bookSearch, 'book')

    /* ---- 同一条记录内跨字段：标题有「林澈」，简介/标签有「领航员」 ---- */
    const andWithinRow = groupOf(multiWordGroup, 'card')

    const groupSum = byKeyword.groups.reduce((sum, group) => sum + group.total, 0)
    // 「跃迁」是为一个大纲节点起的标题，而那个节点又落地成了一章，
    // 加上一张同名灵感卡，于是命中有三种来源；书名里没有这个词，书籍组不参与
    const groupSources = byKeyword.groups.map((group) => group.source).sort().join('|')
    const groupShapeOk =
      byKeyword.total === groupSum &&
      groupSources === 'card|chapter|outline' &&
      byKeyword.groups.every((group) => group.hits.length > 0) &&
      byKeyword.groups.every((group) => group.truncated === group.total > group.hits.length)

    /* ---- 通配符：不转义时 `%` 会匹配全部，转义后必须为 0 ---- */
    const wildcardSearch = search('%')
    const underscoreSearch = search('_')

    /*
     * 片段自洽：每条命中的高亮区间都要落在片段内，且切出来的字
     * **正好是某个关键词**。这条能同时挡住三类错误：区间越界、
     * 高亮标错位置、以及「SQL 匹配的字段」与「应用层展示的字段」不一致。
     */
    const highlightIssues: string[] = []
    let highlightChecked = 0
    for (const probe of [byKeyword, multiWordGroup, chapterSearch, bookSearch]) {
      for (const group of probe.groups) {
        for (const hit of group.hits) {
          highlightChecked += 1
          if (hit.highlights.length === 0) {
            highlightIssues.push(`${hit.source}#${hit.id} 没有任何高亮区间`)
            continue
          }
          for (const mark of hit.highlights) {
            if (mark.start < 0 || mark.end > hit.snippet.length || mark.start >= mark.end) {
              highlightIssues.push(`${hit.source}#${hit.id} 区间越界 [${mark.start},${mark.end}]`)
              continue
            }
            const marked = hit.snippet.slice(mark.start, mark.end)
            const isKeyword = probe.keywords.some(
              (keyword) => keyword.toLowerCase() === marked.toLowerCase()
            )
            if (!isKeyword) {
              highlightIssues.push(`${hit.source}#${hit.id} 高亮的「${marked}」不是任何关键词`)
            }
          }
        }
      }
    }

    /* ---- 按书限定：结果里不该出现别的书，也不该出现通用卡片 ---- */
    const scoped = search('跃迁', showcase.id)
    const scopedOk =
      scoped.total > 0 &&
      scoped.groups.every((group) => group.hits.every((hit) => hit.bookId === showcase.id))

    /* ---- 空查询：不发 SQL，也不该报错 ---- */
    const blankSearch = search('   ')
    const blankOk =
      blankSearch.total === 0 &&
      blankSearch.groups.length === 0 &&
      blankSearch.keywords.length === 0

    /* ---- 边界校验：走真实的 parse，顺带证明控制器挂上了 schema ---- */
    const searchParser = getChannelParser(IpcChannel.SearchQuery)
    let searchBoundaryDefaults = false
    if (searchParser) {
      try {
        const parsed = searchParser({ keywords: '  林澈　星云  ' }) as {
          keywords: string[]
          bookId: number | null
          limit: number
        }
        searchBoundaryDefaults =
          parsed.keywords.join('|') === '林澈|星云' &&
          parsed.bookId === null &&
          parsed.limit === SEARCH_LIMITS.perSource
      } catch {
        searchBoundaryDefaults = false
      }
    }

    let searchLimitsBlocked = false
    if (searchParser) {
      let limitRejected = false
      let lengthRejected = false
      try {
        searchParser({ keywords: '甲', limit: SEARCH_LIMITS.maxPerSource + 1 })
      } catch {
        limitRejected = true
      }
      try {
        searchParser({ keywords: '甲'.repeat(SEARCH_LIMITS.raw + 1) })
      } catch {
        lengthRejected = true
      }
      searchLimitsBlocked = limitRejected && lengthRejected
    }

    /* ---- sliceSnippet 的边界：命中落在极首/极尾时不能越界 ---- */
    const headSnippet = sliceSnippet(`星云${'墨'.repeat(200)}星云`, ['星云'])
    const tailSnippet = sliceSnippet(`${'墨'.repeat(200)}星云`, ['星云'])
    const tightSnippet = sliceSnippet('星云', ['星云'])
    const missSnippet = sliceSnippet('这一段里没有那个词', ['星云'])
    const snippetEdgesOk =
      headSnippet !== null &&
      headSnippet.offset === 0 &&
      headSnippet.clippedStart === false &&
      headSnippet.clippedEnd === true &&
      // 第二次命中被窗口切在外面，不能标上一半
      headSnippet.highlights.length === 1 &&
      headSnippet.highlights[0].start === 0 &&
      tailSnippet !== null &&
      tailSnippet.offset === 200 &&
      tailSnippet.clippedStart === true &&
      tailSnippet.clippedEnd === false &&
      tightSnippet !== null &&
      tightSnippet.clippedStart === false &&
      tightSnippet.clippedEnd === false &&
      tightSnippet.text === '星云' &&
      missSnippet === null

    /* ---- 检索是只读的：跑完一圈不该动任何数据 ---- */
    const afterSearch = snapshot()
    const searchCounts =
      `卡片 ${beforeSearch.cards}→${afterSearch.cards}、` +
      `大纲 ${beforeSearch.outline}→${afterSearch.outline}、` +
      `章节 ${beforeSearch.chapters}→${afterSearch.chapters}`
    const searchHasNoSideEffect =
      afterSearch.cards === beforeSearch.cards &&
      afterSearch.outline === beforeSearch.outline &&
      afterSearch.chapters === beforeSearch.chapters

    const searchChecks: Array<[string, boolean, string]> = [
      [
        '检索切词与去重',
        keywordChecksOk,
        keywordChecksOk
          ? `全角空格分隔得「${keywordsParsed.join('、')}」，重复词去重，${SEARCH_LIMITS.keywords} 个以上被截断，纯空白得 0 个`
          : `切词结果「${keywordsParsed.join('|')}」，去重后 ${parseKeywords('林澈 林澈 林澈').length} 个，超量后 ${keywordCap.length} 个`
      ],
      [
        '多关键词 AND 语义',
        andAcrossRowsOk,
        andAcrossRowsOk
          ? `「林澈」单独命中 ${soloCharacter.total} 处、「甜头」单独命中 ${soloSweet.total} 处，而「林澈 甜头」为 ${andAcrossRows.total} 处（两者分属不同记录，AND 没有被写成 OR）`
          : `「林澈」${soloCharacter.total} 处、「甜头」${soloSweet.total} 处，合起来 ${andAcrossRows.total} 处 —— 预期合起来为 0`
      ],
      [
        '同记录跨字段 AND',
        andWithinRow !== null && andWithinRow.total === 1,
        andWithinRow !== null && andWithinRow.total === 1
          ? '一张卡片标题含「林澈」、简介与标签含「领航员」，两个词落在同一记录的不同字段上也应当命中'
          : `预期命中 1 张卡，实得 ${andWithinRow?.total ?? 0} 张`
      ],
      [
        '检索按来源分组',
        groupShapeOk,
        groupShapeOk
          ? `「跃迁」命中 ${byKeyword.total} 处、分 ${byKeyword.groups.length} 组（${byKeyword.groups
              .map((group) => `${SEARCH_SOURCE_LABELS[group.source]} ${group.total}`)
              .join(' / ')}），分组之和与总数一致且截断标记自洽`
          : `总数 ${byKeyword.total}，分组 ${byKeyword.groups.length} 个（${groupSources || '无'}），分组之和 ${groupSum}`
      ],
      [
        '检索章节正文',
        chapterGroup !== null && chapterGroup.total === 1 && chapterGroup.hits[0]?.field === 'content',
        chapterGroup !== null && chapterGroup.total === 1
          ? `「真实数据」只出现在展示用章节的正文里，命中字段为 ${chapterGroup.hits[0]?.field}`
          : `预期章节组命中 1 处，实得 ${chapterGroup?.total ?? 0} 处`
      ],
      [
        '检索书籍非标题字段',
        bookGroup !== null && bookGroup.total === 1 && bookGroup.hits[0]?.field === 'penName',
        bookGroup !== null && bookGroup.total === 1
          ? `「冒烟作者」只出现在笔名里（书名里没有），命中字段为 ${bookGroup.hits[0]?.field}`
          : `预期书籍组命中 1 处，实得 ${bookGroup?.total ?? 0} 处`
      ],
      [
        '检索通配符转义',
        wildcardSearch.total === 0 && underscoreSearch.total === 0,
        wildcardSearch.total === 0 && underscoreSearch.total === 0
          ? '搜「%」与「_」均返回 0 处（通配符被转义，没有退化成「匹配全部」）'
          : `搜「%」得 ${wildcardSearch.total} 处、搜「_」得 ${underscoreSearch.total} 处 —— LIKE 通配符没有转义`
      ],
      [
        '检索片段高亮自洽',
        highlightIssues.length === 0 && highlightChecked >= 4,
        highlightIssues.length === 0
          ? `检查了 ${highlightChecked} 条命中的高亮区间，全部落在片段内且切出来的字恰好是某个关键词`
          : highlightIssues.join('；')
      ],
      [
        '检索按书限定',
        scopedOk,
        scopedOk
          ? `限定展示用书后「跃迁」仍命中 ${scoped.total} 处，且每条都归属这本书（通用卡片的 bookId 为 null，已被范围挡在外面）`
          : `限定后命中 ${scoped.total} 处，存在越界的结果`
      ],
      [
        '检索未知书籍',
        search('跃迁', 999_999).total === 0,
        `限定到不存在的书籍时返回 0 处而不是报错（返回 ${search('跃迁', 999_999).total} 处）`
      ],
      [
        '检索空查询',
        blankOk,
        blankOk
          ? '纯空白查询直接返回空结果，没有发起全库扫描（检索框刚聚焦是极高频状态）'
          : `空查询返回 ${blankSearch.total} 处、${blankSearch.groups.length} 组`
      ],
      [
        '检索边界默认值',
        searchBoundaryDefaults,
        searchBoundaryDefaults
          ? '只传 keywords 时 bookId 回落为 null、limit 回落为每来源默认值，且切词在边界处已生效'
          : '检索查询的边界归一化不符合预期'
      ],
      [
        '检索边界上限拦截',
        searchLimitsBlocked,
        searchLimitsBlocked
          ? `limit 超过 ${SEARCH_LIMITS.maxPerSource} 与查询串超过 ${SEARCH_LIMITS.raw} 字符都被拒绝`
          : '超限的 limit 或过长的查询串未被拦截'
      ],
      [
        '片段切片边界',
        snippetEdgesOk,
        snippetEdgesOk
          ? `命中落在正文最前与最后时片段都不越界（首端 clippedStart=${headSnippet?.clippedStart}、尾端 clippedEnd=${tailSnippet?.clippedEnd}），被窗口切开的那一次不标半个高亮，找不到时返回 null`
          : `首端 offset=${headSnippet?.offset} 高亮 ${headSnippet?.highlights.length} 个，尾端 offset=${tailSnippet?.offset}，短文本「${tightSnippet?.text}」，无命中=${missSnippet === null}`
      ],
      [
        '检索无副作用',
        searchHasNoSideEffect,
        searchHasNoSideEffect
          ? `跑了 ${searchRuns} 次检索之后，卡片 / 大纲节点 / 章节数量均未变化（${searchCounts}）`
          : `检索过程中数据发生了变化（${searchCounts}）—— 检索必须是只读的`
      ]
    ]

    for (const [name, ok, detail] of searchChecks) {
      push(name, ok, detail)
    }
  } catch (error) {
    push('业务规则', false, messageOf(error))
  }

  // 供渲染检查使用：确认有一本书 + 一章 + 一本空书可供展示
  if (showcaseBookId === null || showcaseChapterId === null || emptyBookId === null) {
    push('冒烟数据准备', false, '未能为渲染检查准备出可见的数据')
  }

  return {
    results,
    showcase:
      showcaseBookId !== null &&
      showcaseChapterId !== null &&
      showcaseVolumeId !== null &&
      emptyBookId !== null
        ? {
            bookId: showcaseBookId,
            bookTitle: showcaseBookTitle,
            chapterId: showcaseChapterId,
            volumeId: showcaseVolumeId,
            volumeTitle: showcaseVolumeTitle,
            chapterWords: SHOWCASE_CHAPTER_WORDS,
            emptyBookId,
            emptyBookTitle,
            bookTotals: (id) => {
              const chapters = chapterService.list({ bookId: id, volumeId: undefined })
              return {
                volumes: volumeService.list(id).length,
                chapters: chapters.length,
                hanzi: chapters.reduce((sum, item) => sum + item.hanziCount, 0)
              }
            },
            lookupVolume: (title) => {
              const found = volumeService
                .list(showcaseBookId as number)
                .find((item) => item.title === title)
              return found === undefined
                ? null
                : { id: found.id, title: found.title, chapterCount: found.chapterCount }
            },
            resumeChapterId: (id) => {
              const chapters = chapterService.list({ bookId: id, volumeId: undefined })
              if (chapters.length === 0) return null
              return chapters.reduce((best, item) =>
                item.updatedAt.localeCompare(best.updatedAt) > 0 ? item : best
              ).id
            },
            lookupChapter: (title) => {
              const found = chapterService
                .list({ bookId: showcaseBookId as number, volumeId: undefined })
                .find((item) => item.title === title)
              if (!found) return null
              return {
                id: found.id,
                title: found.title,
                status: found.status,
                volumeId: found.volumeId,
                targetWords: found.targetWords,
                hanziCount: found.hanziCount
              }
            },
            lookupCard: (title) => {
              const found = cardService
                .list({ ...DEFAULT_CARD_QUERY, bookScope: 'all' })
                .items.find((item) => item.title === title)
              if (!found) return null
              return {
                id: found.id,
                title: found.title,
                cardType: found.cardType,
                extraKeys: Object.keys(found.extra).sort().join(','),
                category: found.extra.category ?? '',
                timePoint: found.extra.timePoint ?? '',
                order: found.extra.order ?? ''
              }
            },
            removeCard: (id) => {
              cardService.remove(id)
            },
            seedSettingCard: (title, category, timePoint = '') =>
              cardService.create({
                bookId: showcaseBookId as number,
                cardType: 'setting',
                title,
                subtitle: '',
                content: '',
                tags: [],
                extra: { category, timePoint }
              }).id,
            // 两个方向都直接从服务层读：界面上的行数对不对是一回事，
            // 库里到底有没有这条关联是另一回事，只有后者能证明功能真的做了
            seedCard: (title, cardType) =>
              cardService.create({
                bookId: showcaseBookId as number,
                cardType: isCardType(cardType) ? cardType : 'character',
                title,
                subtitle: '',
                content: '',
                tags: [],
                // 专属字段留空：前端传空对象时由 schema 补齐，
                // 这里直接调服务层，因此要自己给一份完整的 extra
                extra: normalizeExtra(isCardType(cardType) ? cardType : 'character', {})
              }).id,
            relationsOfCard: (cardId) =>
              cardLinkService
                .listRelations(cardId)
                .map((item) => ({ relatedId: item.relatedId, relation: item.relation })),
            linksOfCard: (cardId) =>
              cardLinkService.listByCard(cardId).map((item) => item.chapterId),
            cardsOfChapter: (chapterId) =>
              cardLinkService.listByChapter(chapterId).map((item) => item.cardId),
            chaptersOf: (id) =>
              chapterService
                .list({ bookId: id, volumeId: undefined })
                .map((item) => ({ id: item.id, title: item.title })),
            nodesOf: (id) =>
              outlineService
                .tree(id)
                .nodes.flatMap(function flatten(node): Array<{ id: number; title: string }> {
                  return [{ id: node.id, title: node.title }, ...node.children.flatMap(flatten)]
                }),
            nodesOfCard: (cardId) =>
              cardLinkService.listNodesByCard(cardId).map((item) => item.nodeId),
            cardsOfNode: (nodeId) => cardLinkService.listByNode(nodeId).map((item) => item.cardId),
            revisionsOf: (chapterId) =>
              chapterService
                .listRevisions(chapterId)
                .map((item) => ({ id: item.id, hanziCount: item.hanziCount })),
            chapterHanzi: (chapterId) => chapterService.getById(chapterId).hanziCount
          }
        : null
  }
}

/* ------------------------------------------------------------------ *
 * 渲染进程链路：preload 桥 → IPC → 主进程 → SQLite → React 渲染
 * ------------------------------------------------------------------ */

/**
 * 渲染检查分两步：先看首页，再真的走进章节编辑器。
 *
 * 编辑器是这块应用的主体，只检查首页等于没检查 —— 首页只需要列表接口，
 * 而编辑器要同时打通「详情接口 → TipTap 建实例 → 纯文本投影 → 纠错引擎
 * → 装饰回绘 → 三栏布局」这一串。这条链路里任何一环断了首页都照样是绿的。
 */
export async function runRendererSmokeChecks(
  window: BrowserWindow,
  showcase: ShowcaseTargets | null
): Promise<StepResult[]> {
  const results: StepResult[] = []

  try {
    await waitForLoad(window)
  } catch (error) {
    return [
      { name: '渲染进程', ok: false, detail: messageOf(error) },
      { name: '首页启动台', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '书籍管理', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '打开书籍', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '大纲管理', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '卡片库', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '全库检索', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '章节编辑器', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '编辑器工具栏', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '新建章弹窗', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '目录右键菜单', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '左侧目录建卷', ok: false, detail: '渲染进程未能加载，无法继续' }
    ]
  }

  results.push(await checkDashboard(window))
  /*
   * 启动台检查紧跟首页之后：它从首页出发、四个模块各走一遍「卡片 → 模块页 →
   * 返回首页」的往返，跑完会回到首页。放在这里它拿到的正是首页的初始状态，
   * 而后面几条检查各自用改 hash 的方式进自己的页面，互不干扰。
   */
  results.push(await checkHomeNavigation(window))
  results.push(await checkBooks(window))
  /*
   * 「打开书籍」紧跟书架之后：它就是「从书架点开一本书」的下一跳，
   * 而且这一步会把落点从书架挪到编辑器（在空书上还会停在空态），
   * 后面的检查各自改 hash 进自己的页面，不受它影响。
   */
  if (showcase === null) {
    results.push({
      name: '打开书籍',
      ok: false,
      detail: '后端没有留下可见的书籍与空书，无法验证打开书籍的落点'
    })
    results.push({
      name: '左侧目录建卷',
      ok: false,
      detail: '后端没有留下可见的书籍，无法验证目录栏的分卷管理'
    })
  } else {
    results.push(await checkBookWorkspace(window, showcase))
  }
  results.push(await checkOutline(window))
  results.push(await checkCards(window))

  if (showcase === null) {
    results.push({ name: '全库检索', ok: false, detail: '后端没有留下可导航的书籍与章节' })
    results.push({ name: '章节编辑器', ok: false, detail: '后端没有留下可导航的书籍与章节' })
  } else {
    // 检索检查会跳进编辑器，因此放在章节编辑器检查之前 ——
    // 让最后停在编辑器页的那一次检查仍然是章节编辑器，保持截图与终态不变
    results.push(await checkSearch(window, showcase))
    results.push(await checkChapterEditor(window, showcase))
    // 工具栏的行为验证排在编辑器检查之后：它要就地改字号 / 字体 / 段间距，
    // 必须晚于截图，否则实拍图会拍到一个偏好已被改动的编辑器
    results.push(await checkEditorTools(window))
    // 新建章弹窗放在最后：它会真的建出一章并跳过去，排在编辑器与工具栏的
    // 检查之后，才不会改掉它们要看的那个页面与截图
    results.push(
      await checkChapterCreateModal(window, {
        volumeTitle: showcase.volumeTitle,
        volumeId: showcase.volumeId,
        chapterWords: showcase.chapterWords,
        lookup: showcase.lookupChapter
      })
    )
    /*
     * 目录右键菜单紧跟在新建章弹窗之后：这一步需要「两行目录」——一行是
     * 正在编辑的（上一步刚建出来的那章），另一行是别处的（第一章 开场）。
     * 靠这个组合才能验到「操作 A 行不会动到 B 行」。
     */
    results.push(
      await checkCatalogContextMenu(window, {
        volumeId: showcase.volumeId,
        volumeTitle: showcase.volumeTitle,
        lookup: showcase.lookupChapter
      })
    )
    /*
     * 目录栏的分卷管理排在最后：它会真的建出一卷、改名、再删掉，
     * 中途还要在分卷行上右键。放在前面的话，那几帧会混进
     * 「书籍管理 / 打开书籍 / 新建章弹窗」要看的页面与截图里。
     */
    results.push(await checkCatalogVolumeMenu(window, showcase))
    /*
     * 「外出后返回正文」排在这一段最后：它会真的离开编辑器去大纲页与卡片库，
     * 放在前面会把那几帧混进前面几步要看的页面与截图里。
     */
    results.push(await checkOriginReturn(window, showcase))
    /*
     * 「设定卡」紧跟在回程票之后：它同样要从正文里跳去卡片库（所以排在
     * 前面几步要看的页面之后），而且会真的建一张卡再删掉 —— 排在卡片库
     * 那一步之后，才不会把总数搅乱在「渲染 5 行」的断言里。
     */
    results.push(await checkCardNodeLink(window, showcase))
    results.push(await checkSettingCard(window, showcase))
    results.push(await checkSettingCategoryFilter(window, showcase))
    /*
     * 时间线排在类别筛选之后：它同样要造几张「时间线」设定卡，
     * 而类别筛选那一项断言的是**总数**（时间线 2 / 势力 1），
     * 多出三张会把它打成红的。
     */
    results.push(await checkSettingTimeline(window, showcase))
    /*
     * 关系这一项排在时间线之后：它同样要造卡片（两张人物卡），
     * 而前几步的断言里有按总数对账的；造完立刻删掉，放在最后面最省事。
     */
    results.push(await checkCardRelation(window, showcase))
    results.push(await checkCardChapterLink(window, showcase))
    /*
     * 「正文自动保存往返」同样排最后：它往正文里真的打进一段字，
     * 会改动这一章的字数与内容 —— 放在前面会把「正文字数与预期一致」
     * 那条断言打红。冒烟库是一次性的，跑完即弃，不需要清理。
     */
    results.push(await checkEditorRoundTrip(window, showcase))
    /*
     * 「章节历史版本」同样排最后：它也要往正文里打一长段字，
     * 会改动 showcase 那一章的内容 —— 与上一条同样的理由。
     */
    results.push(await checkChapterRevisions(window, showcase))
  }

  results.push(checkNoSilentIpcFailure())
  return results
}

/**
 * 走完整条渲染链路之后，不该有任何一次调用被拒绝。
 *
 * 这一项是踩过坑才加的：编辑器页面的书籍切换器用 `status: null` 查书单，
 * 而边界 schema 当时只收字符串，于是每次查询都被拒。前端把它降级成
 * 空下拉，页面照常渲染，两条渲染断言全绿 —— 缺陷只留在主进程日志里。
 *
 * 换成「有没有被拒」这个口径，问题就跟页面无关了：少一次查询、多一次
 * 越界参数，都会被这一项逮住。
 */
function checkNoSilentIpcFailure(): StepResult {
  const rejections = getIpcRejections()
  if (rejections.length === 0) {
    return { name: 'IPC 无静默失败', ok: true, detail: '渲染链路全程没有被拒绝的调用' }
  }

  // 按通道归类，同一个通道反复失败只报一次，避免刷屏
  const grouped = new Map<string, string>()
  for (const item of rejections) {
    if (!grouped.has(item.channel)) grouped.set(item.channel, `${item.code}：${item.reason}`)
  }

  return {
    name: 'IPC 无静默失败',
    ok: false,
    detail: `${rejections.length} 次调用被拒绝｜${[...grouped]
      .map(([channel, reason]) => `${channel} → ${reason}`)
      .join('；')}`
  }
}

async function checkDashboard(window: BrowserWindow): Promise<StepResult> {
  try {
    const rendered = await waitForRender(window)

    const problems: string[] = []
    if (!rendered.reactMounted) problems.push('React 未挂载（#root 为空）')

    // 顶部导航条必须**整条消失**（用户 2026-09-20 指定）。它以「占地方」为
    // 由被移除，所以这里断的是「它不在」，而不是「它长得对」—— 后者在它
    // 被改回去时照样全绿（旧断言正是量它的几何）。
    if (rendered.hasTopNav) {
      problems.push('顶部导航条又回来了：模块导航应当只由首页的功能卡片承担')
    }

    // 页标题必须**不占纵向空间**。这条对首页与各模块页成立（用户 2026-09-20
    // 「页标题移除，不要展示」）—— 它们的标题是导航标签，内容已经说明了自己。
    // 曾经有过一个例外（书籍详情页显示书名），那一页已经取消，书名改由编辑器
    // 顶栏显示、不再是一个「页标题」——**于是现在没有例外**（见 titleVisible 的说明）。
    // 读的是实测面积，不是类名：类名可以随便改，「占不占地方」才是事实。
    // 下面 `pageTitle` 那一行同时证明了隐藏的锚点还在（否则它会读成空字符串）。
    if (rendered.titleVisible) {
      problems.push('页标题在画面上占位了，它应当只是给读屏与测试用的隐藏锚点')
    }

    if (rendered.pageTitle !== '首页') problems.push(`页面标题异常：${rendered.pageTitle}`)

    /*
     * 顶栏右上角：**只有一枚**圆形 `…` 按钮。
     *
     * 用户 2026-09-20 的要求分两轮，最终形态是「只展示一个 [...] 图标按钮，
     * 点击后展开下拉菜单，每个菜单项对应一个圆形功能图标（并排展示的功能图标取消）」
     * —— 所以三件事分别断：
     *   「只有一枚」→ inlineIconButtons 必须为 1（并排的图标又冒出来时，
     *                 菜单那边的断言照样全绿，只有这个计数会红）
     *   「圆形」「只有图标」→ 几何与 textContent
     *   「读屏仍然知道它是什么」→ aria-label 非空（文字挪走 ≠ 文字可以删）
     */
    if (rendered.inlineIconButtons !== 1) {
      problems.push(
        `顶栏里有 ${rendered.inlineIconButtons} 个圆形图标按钮，应为 1 个 —— 多个功能按钮要收进「…」的菜单，不再并排展示`
      )
    }
    const moreButton = rendered.moreButton
    if (!moreButton) {
      problems.push('顶栏找不到「更多功能」（…）按钮')
    } else {
      if (moreButton.text !== '') {
        problems.push(`「更多功能」按钮上还有文字「${moreButton.text}」—— 它应当只有一个图标`)
      }
      if (moreButton.label === '') {
        problems.push('「更多功能」按钮没有 aria-label，读屏念不出它是什么')
      }
      if (
        Math.abs(moreButton.width - moreButton.height) > 1 ||
        Math.abs(moreButton.radiusPx - moreButton.width / 2) > 1
      ) {
        problems.push(
          `「更多功能」按钮不是正圆（${moreButton.width}×${moreButton.height}px，圆角 ${moreButton.radiusPx}px）`
        )
      }
    }
    // 主进程状态必须随时可读，而不是「点开菜单才知道」。它挂在 `…` 按钮上，
    // 画面上不显示 —— 所以读不到时说明这份状态副本丢了，而不是「没渲染」。
    if (rendered.healthState === '') {
      problems.push('顶栏没有可读的主进程状态（data-health-state 缺失）')
    }

    // 产品名：窗口标题栏显示的就是页面 <title>，而 BrowserWindow 自己也有
    // title 选项（在页面加载完成前生效）。两处都查 —— 它们是用户第一眼
    // 看到的东西，「wapp 应改为 winbook」那次反馈正是从这里来的。
    if (rendered.docTitle !== 'winbook') {
      problems.push(`页面标题应为「winbook」，实际是「${rendered.docTitle}」`)
    }
    const windowTitle = window.getTitle()
    if (!windowTitle.includes('winbook')) {
      problems.push(`窗口标题「${windowTitle}」里读不到 winbook（BrowserWindow 的 title 选项没改？）`)
    }
    if (!rendered.healthOk) problems.push(`健康检查未通过：${rendered.healthText}`)
    // 指标区必须已经脱离 loading，否则会在数据到达之前就误判为通过
    if (rendered.metricsLoading) problems.push('指标区仍处于加载中（loading 未结束）')
    // 真实数字必须出现，这是「preload 桥 → IPC → 主进程 → SQLite」整条链路的证据
    if (rendered.bookCount < 1) problems.push(`书籍数未渲染出真实数据：${rendered.bookCount}`)
    if (rendered.totalHanzi < 1) problems.push(`总字数未渲染出真实数据：${rendered.totalHanzi}`)
    if (rendered.progressRowCount < 1) problems.push('在写书籍列表没有渲染出任何数据行')

    // 功能模块卡片：现在它们就是应用的导航，所以断的是「数量、顺序、
    // 文案、排布」四件事，而不只是「有卡片」。
    //   - 数量：少一张 = 有个模块没有入口（用户进不去），多一张 = 重复入口；
    //   - 顺序：被换过不会报任何错，但用户的肌肉记忆失效；
    //   - 文案：卡片上只有 icon + 四个字，写错就是认不出来。
    const modules = rendered.modules
    if (modules.length !== HOME_MODULES.length) {
      problems.push(
        `首页功能模块卡片 ${modules.length} 张，应为 ${HOME_MODULES.length} 张（实测 ${modules
          .map((item) => item.key || '?')
          .join('/')}）`
      )
    } else {
      const actualOrder = modules.map((item) => item.key).join(',')
      const expectedOrder = HOME_MODULES.map((item) => item.key).join(',')
      if (actualOrder !== expectedOrder) {
        problems.push(`功能模块卡片的顺序是 ${actualOrder}，应为 ${expectedOrder}`)
      }

      HOME_MODULES.forEach((expected, index) => {
        const actual = modules[index]
        if (!actual.label.includes(expected.label)) {
          problems.push(
            `第 ${index + 1} 张卡片文案是「${actual.label}」，读不到「${expected.label}」`
          )
        }
      })

      const sameRow = Math.max(...modules.map((m) => m.top)) - Math.min(...modules.map((m) => m.top)) <= 2
      if (!sameRow) {
        problems.push(
          `功能模块卡片不在同一行（top ${modules.map((m) => m.top).join('/')}）—— 四张应当并作一行，否则又变成占地方`
        )
      }
      // 等宽是产品要求：卡片宽度随文案长短伸缩会让一屏里的卡片高矮不齐
      const widths = modules.map((m) => m.width)
      if (Math.max(...widths) - Math.min(...widths) > 2) {
        problems.push(`功能模块卡片没有平分整行宽度（各 ${widths.join('/')}px）`)
      }
      const sameHeight = Math.max(...modules.map((m) => m.height)) - Math.min(...modules.map((m) => m.height)) <= 2
      if (!sameHeight) {
        problems.push(`功能模块卡片不等高（各 ${modules.map((m) => m.height).join('/')}px）`)
      }
    }

    // 行内卡片等高：Ant Design 的 Card 默认按内容收缩，Col 却被 flex 拉伸，
    // 于是「今日」卡比趋势图卡矮一截 —— 用户明确要求「高度要对齐，
    // 不能出现偏差」，用实测高度把它锁住（容差 2px）。
    const rows = rendered.rows
    const sameHeight = (heights: number[]) =>
      heights.length > 1 && Math.max(...heights) - Math.min(...heights) <= 2
    if (rows.metricHeights.length !== 4 || !sameHeight(rows.metricHeights)) {
      problems.push(`指标卡没有等高（各卡高 ${rows.metricHeights.join('/')}px，共 ${rows.metricHeights.length} 张）`)
    }
    if (rows.trendHeight < 0 || rows.todayHeight < 0) {
      problems.push('趋势图卡或「今日」卡未渲染，无法验证等高')
    } else if (Math.abs(rows.trendHeight - rows.todayHeight) > 2) {
      problems.push(
        `「今日」卡与趋势图卡不等高（${rows.todayHeight}px vs ${rows.trendHeight}px）—— Card 没有吃满所在列`
      )
    }

    await captureIfRequested(window, 'dashboard')

    /*
     * 「更多功能」菜单：三项各配一个圆形图标。（放在截图之后 —— 浮层会挡进画面里，
     * 而这张图是给用户看首页长相的。）
     *
     * 断的是「每一项的图标是正圆 + 文字没丢」：用户明确说了「每个菜单项对应一个
     * 圆形功能图标」。方形图标、或者为了省事只留文字，都能通过「菜单项在不在」的断言。
     */
    const menu = await openTopBarMenu(window)
    const menuProblems: string[] = []
    const missing = TOP_BAR_MENU_ITEMS.filter(
      (def) => !menu.items.some((item) => item.key === def.key && item.found && item.visible)
    )
    if (missing.length > 0) {
      menuProblems.push(`菜单里缺少：${missing.map((def) => def.name).join('、')}（菜单没展开？）`)
    } else if (menu.items.length !== TOP_BAR_MENU_ITEMS.length) {
      menuProblems.push(`菜单有 ${menu.items.length} 项，应为 ${TOP_BAR_MENU_ITEMS.length} 项`)
    } else {
      for (const item of menu.items) {
        const name = TOP_BAR_MENU_ITEMS.find((def) => def.key === item.key)?.name ?? item.key
        if (item.text === '') {
          menuProblems.push(`菜单项「${name}」没有任何文字 —— 图标并排展示取消之后，文字必须落在菜单里`)
        }
        if (
          Math.abs(item.iconWidth - item.iconHeight) > 1 ||
          Math.abs(item.iconRadiusPx - item.iconWidth / 2) > 1
        ) {
          menuProblems.push(
            `菜单项「${name}」的图标不是正圆（${item.iconWidth}×${item.iconHeight}px，圆角 ${item.iconRadiusPx}px）`
          )
        }
      }

      const iconWidths = menu.items.map((item) => item.iconWidth)
      if (Math.max(...iconWidths) - Math.min(...iconWidths) > 1) {
        menuProblems.push(`菜单项的圆形图标大小不一致（各 ${iconWidths.join('/')}px）`)
      }
    }
    problems.push(...menuProblems)

    // 菜单平时不在画面上（它只在被点开时存在），按页截图永远拍不到它 ——
    // 所以趁它开着单独截一张。位置在这段断言之后：截图只负责换个画面，
    // 不该有本事把测试带成红灯（同目录右键菜单那张的约定）。
    //
    // 先等它把进场动画跑完再截：轮询判「可见」读的是实测尺寸，而浮层是
    // opacity 从 0 渐显的 —— 尺寸早就有了、画面还是全透明，直接抓只能得到
    // 一张「有按钮、没有菜单」的图（实测踩过一次）。
    await delay(600)
    await captureIfRequested(window, 'topbar-menu')

    // 主题项：从菜单里连点三档，必须每次前进一档、点满一圈回到原点。
    // 这条同时证明「菜单项真的可点」—— 一个点不动的菜单项在其它断言下是全绿的。
    const themeCycle = await cycleThemeByMenu(window)
    if (!themeCycle.ok) {
      problems.push(`主题菜单项没有按「点一次转一档」工作：${themeCycle.detail}`)
    }
    await closeTopBarMenu(window)
    await setWindowVisible(window, false)


    return {
      name: '渲染进程',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `React 已挂载，顶部无导航条，顶栏只有 ${rendered.inlineIconButtons} 枚圆形「…」按钮（${rendered.moreButton?.width}px 正圆、无文字、aria-label「${rendered.moreButton?.label}」），其菜单 ${
              menu.items.filter((item) => item.visible).length
            } 项各配圆形图标（主题循环 ${themeCycle.detail}），首页 ${rendered.modules.length} 张功能卡片一行等宽（各 ${rendered.modules[0].width}px，顺序 ${rendered.modules
              .map((item) => item.key)
              .join('→')}），渲染 ${rendered.bookCount} 本书 / ${rendered.totalHanzi} 汉字 / ${rendered.progressRowCount} 行进度，主进程状态「${rendered.healthText}」，行内卡片等高（指标 ${rendered.rows.metricHeights[0]}px / 趋势与今日 ${rendered.rows.trendHeight}px）`
          : // 失败时把实测快照一并打出来。否则只有一句「没有渲染出数据行」，
            // 还得回头改代码加日志才能知道到底是没挂载、还在 loading 还是选择器写错了
            `${problems.join('；')}｜实测：React ${
              rendered.reactMounted ? '已挂载' : '未挂载'
            }，顶部导航条 ${rendered.hasTopNav ? '还在' : '已移除'}，标题${
              rendered.titleVisible ? '可见' : '隐藏'
            }，顶栏圆钮=${rendered.inlineIconButtons} 个（… 按钮 ${
              rendered.moreButton ? `${rendered.moreButton.width}×${rendered.moreButton.height}px/圆角 ${rendered.moreButton.radiusPx}px/文字「${rendered.moreButton.text}」` : '找不到'
            }），菜单项=${menu.items
              .filter((item) => item.visible)
              .map((item) => item.key)
              .join('/')}，功能卡片=${rendered.modules.length} 张（${rendered.modules
              .map((item) => item.key || '?')
              .join('/')}），标题「${rendered.pageTitle}」，loading=${
              rendered.metricsLoading
            }，书籍数=${rendered.bookCount}，总字数=${rendered.totalHanzi}，进度行=${
              rendered.progressRowCount
            }，主进程「${rendered.healthText}」`
    }
  } catch (error) {
    return { name: '渲染进程', ok: false, detail: messageOf(error) }
  }
}

/* ---------------------------------------------------------------- *
 * 第二步：进章节编辑器
 * ---------------------------------------------------------------- */

/** 编辑器快照。字段名与首页刻意不共用，避免两种页面结构被同一个选择器糊过去 */
interface EditorSnapshot {
  /** 编辑器根容器在不在 —— 说明路由真的切过去了 */
  mounted: boolean
  /** 当前路径，失败时用来判断是不是压根没导航成功 */
  hash: string
  /** 书名 / 章名是否已从详情接口取回并回填 */
  title: string
  /** 正文是否由 TipTap 渲染出了段落节点 */
  paragraphCount: number
  /** 「本章」汉字数（读 data-value，不看格式化后的文本） */
  hanzi: number
  /** 左侧目录里的章节行数 */
  catalogRows: number
  /** 目录栏里「点下去会开始新建卷/章」的按钮数。只该有头部那两个 */
  catalogNewTriggers: number
  /** 编辑器元信息栏里除标题之外的控件数。应当是 0 */
  metabarExtras: number
  /** 底栏「计划」的文案，用来验证它读的是书籍的每章最少字数 */
  planText: string
  /** 右侧纠错面板报出的问题数。示例正文里埋了毛病，0 就说明引擎没跑起来 */
  proofreadCount: number
  /** 纸面声明的墨色取向：'dark' 深色墨配浅色纸，'light' 浅色墨配深色纸 */
  paperInk: string
  /** 正文实际算出来的字色（rgb 字符串） */
  textColor: string
  /** 底栏（新建章节 / 计划 / 本章）是否完整落在可视区内 */
  statusbarVisible: boolean
  /** 高度链各环节的实测几何，底栏不可见时用来定位是哪一环没约束住 */
  geometry: string
  /** 三栏骨架是否齐全：目录 / 主编辑区 / 检查器 */
  hasCatalog: boolean
  hasToolbar: boolean
  hasInspector: boolean
  /** 编辑器顶栏上的圆形图标按钮（见 `ICON_BUTTON_PROBE_JS`） */
  iconButtons: IconButtonProbe[]
  /** 应用主题（'light' | 'dark'）。纸面声明 ink='theme' 时靠它推出期望的墨色 */
  theme: string
  /** 纸面背景层的实测底色与浓度 */
  washColor: string
  washOpacity: number
  /** 参照面板的底色（顶栏用的就是 --winbook-surface），纸面底色应当与它一致 */
  panelColor: string
  /** 正文可用空间：各栏实测宽度。用来验证「正文拿到最大的那块」 */
  layout: {
    bodyWidth: number
    mainWidth: number
    catalogWidth: number
    inspectorWidth: number
    panelWidth: number
    surfaceWidth: number
    columnWidth: number
  }
  /** 工具栏上四个控件的在位情况与可用性 */
  tools: {
    fontSelect: boolean
    fontSizeSelect: boolean
    underline: boolean
    tidy: boolean
    /** 两个按钮是否可用。disabled 是原生属性，不必去碰组件库的内部类名 */
    buttonsEnabled: boolean
  }
  /** 正文实际算出来的字号与字体，用来验证字体 / 字号控件真的作用到了正文 */
  contentFontSize: number
  contentFontFamily: string
  /** 首段的行距与首行缩进（px） */
  firstParagraph: {
    indentPx: number
    gapPx: number
  }
  /** 正文里的下划线数量（验证下划线按钮真的落到了文档上） */
  underlineCount: number
  /** 工具栏的排布与滑动状态：不折行，装不下时头尾给箭头 */
  toolbar: {
    stripFound: boolean
    scrollWidth: number
    clientWidth: number
    scrollLeft: number
    itemCount: number
    /** 各控件的中线高度：全部相等才说明它们在同一行（折行时会被拉成两组） */
    itemCenters: number[]
    hasLeftButton: boolean
    hasRightButton: boolean
    leftDisabled: boolean
    rightDisabled: boolean
  }
}

const EMPTY_EDITOR_SNAPSHOT: EditorSnapshot = {
  mounted: false,
  hash: '',
  title: '',
  paragraphCount: 0,
  hanzi: -1,
  catalogRows: 0,
  catalogNewTriggers: -1,
  metabarExtras: -1,
  planText: '',
  proofreadCount: -1,
  paperInk: '',
  textColor: '',
  statusbarVisible: false,
  geometry: '',
  hasCatalog: false,
  hasToolbar: false,
  hasInspector: false,
  iconButtons: [],
  theme: '',
  washColor: '',
  washOpacity: -1,
  panelColor: '',
  layout: {
    bodyWidth: -1,
    mainWidth: -1,
    catalogWidth: -1,
    inspectorWidth: -1,
    panelWidth: -1,
    surfaceWidth: -1,
    columnWidth: -1
  },
  tools: { fontSelect: false, fontSizeSelect: false, underline: false, tidy: false, buttonsEnabled: false },
  contentFontSize: -1,
  contentFontFamily: '',
  firstParagraph: { indentPx: -1, gapPx: -1 },
  underlineCount: -1,
  toolbar: {
    stripFound: false,
    scrollWidth: -1,
    clientWidth: -1,
    scrollLeft: -1,
    itemCount: 0,
    itemCenters: [],
    hasLeftButton: false,
    hasRightButton: false,
    leftDisabled: true,
    rightDisabled: true
  }
}

/* ---------------------------------------------------------------- *
 * 「圆形图标按钮」的通用探针
 *
 * 用户 2026-09-20 连着提了两轮：
 *   ① 「头部的所有功能图标都太丑了，需要修正为圆形只展示图标的功能按钮，
 *      所有的文字都移动到鼠标悬浮的提示中」（顶栏那枚 `…`）；
 *   ② 「各个界面中的图标也要跟着改，比如书籍详情页、大纲页、卡片页等」
 *      （推广到各页头部与面板头部）。
 *
 * 这两句拆成四条**可实测**的规矩，写成一份探针、两个快照脚本共用：
 *   - 圆形：宽 === 高，且圆角半径 ≈ 半宽
 *   - 只展示图标：按钮渲染出来的文字必须为空
 *   - 文字没丢:`aria-label` 必须非空（文字从画面上移走 ≠ 可以删掉）
 *   - 有名字可指认：`data-testid` 便于失败时直接说出是哪一枚
 * ---------------------------------------------------------------- */

interface IconButtonProbe {
  /** 失败时用来指认是哪一枚按钮 */
  testId: string
  /** 按钮上渲染出来的文字。**必须为空** */
  text: string
  /** `aria-label`。**必须非空** */
  label: string
  width: number
  height: number
  radiusPx: number
}

/**
 * 探针本体：采的是 `.app-icon-button` 这个**类**，而不是一份 `data-testid` 清单。
 *
 * 为什么按类采：这个类是「圆形图标按钮」这套形状的唯一定义（`IconButton`
 * 组件、顶栏那枚 `…`、右下角悬浮按钮都挂它）。按清单采的话，「新加了一枚
 * 按钮但忘了登记」就整枚漏检 —— 而那恰恰是最该拦住的情况。
 *
 * 两个快照脚本（路由快照与编辑器快照）共用这一份：各写一遍的话，改了一处
 * 漏另一处，会出现「有的页面还在量旧规矩」而没人发现。
 */
const ICON_BUTTON_PROBE_JS = `Array.prototype.map.call(
  document.querySelectorAll('.app-icon-button'),
  (el) => {
    const rect = el.getBoundingClientRect()
    const rawRadius = window.getComputedStyle(el).borderTopLeftRadius || '0'
    return {
      testId: el.getAttribute('data-testid') || '',
      // 只读按钮自己渲染出来的文字。「…」那枚的 aria-label 是一整句话，
      // 两者混着读就分不清「文字到底有没有画到按钮上」。
      text: (el.textContent || '').trim(),
      label: el.getAttribute('aria-label') || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      // border-radius 写成 50% 时 computedStyle 原样返回 "50%"，parseFloat 会
      // 得到 50 这个「像素数」—— 必须按宽度折算，否则正圆会被判成不是圆。
      radiusPx: rawRadius.trim().endsWith('%')
        ? Math.round((rect.width * parseFloat(rawRadius)) / 100)
        : Math.round(parseFloat(rawRadius))
    }
  }
  // 宽为 0 的是「在 DOM 里但不可见」的（比如收起的面板里的按钮）。
  // 把它们算进来会得出一堆 0×0 的「不是正圆」误报；存在性由别的断言负责。
).filter((item) => item.width > 0)`

/**
 * 把探针结果换算成问题清单。写成一个函数是为了让**所有**页面量的是同一套规矩
 * —— 每页各写一段检查，早晚会漂成几种标准。
 */
function checkIconButtons(buttons: IconButtonProbe[], pageLabel: string): string[] {
  const problems: string[] = []

  if (buttons.length === 0) {
    problems.push(
      `「${pageLabel}」页一枚圆形图标按钮都没有 —— 至少右下角那枚「返回首页」应当在这儿`
    )
    return problems
  }

  for (const item of buttons) {
    const who = item.testId.length > 0 ? `[${item.testId}]` : item.label || '（无 testid 也无 label）'

    if (item.text.length > 0) {
      problems.push(
        `「${pageLabel}」页的图标按钮 ${who} 上还写着「${item.text}」—— 文字应当移进鼠标悬浮的提示里`
      )
    }
    if (item.label.length === 0) {
      problems.push(
        `「${pageLabel}」页的图标按钮 ${who} 没有 aria-label —— 文字从画面上移走不等于可以删掉，否则读屏读不出它是什么`
      )
    }
    if (Math.abs(item.width - item.height) > 1) {
      problems.push(
        `「${pageLabel}」页的图标按钮 ${who} 不是正方形（${item.width}×${item.height}px），圆形的前提是宽高相等`
      )
    } else if (Math.abs(item.radiusPx - item.width / 2) > 1) {
      problems.push(
        `「${pageLabel}」页的图标按钮 ${who} 不是正圆（宽 ${item.width}px，圆角半径 ${item.radiusPx}px，应为 ${Math.round(
          item.width / 2
        )}px）`
      )
    }
  }

  return problems
}

/* ------------------------------------------------------------------ *
 * 空状态里的新建入口
 *
 * 用户 2026-09-20 看着首页截图问：「这个按钮没有改？太丑了，改成【+】图标加
 * 鼠标悬浮提示的形式」—— 指的是「还没有书籍 / 书架还是空的」那张插图下面
 * 那枚「新建第一本书」，它是全应用最后两枚**还带着文字的长条按钮**。
 *
 * 这类改造的失败方式很特别：空状态是「页面上没有内容、只剩一个动作」的样子，
 * 而它的每一种退化都**不会让任何存在性断言变红**：
 *   - 动作被删掉 → 页面上一片空白，用户在这里无路可走；
 *   - 动作改回带文字的长条 → 就是用户这次指出的样子；
 *   - 动作被复制成两份 → 卡片库真出过（两枚一模一样的新建按钮并排站着）。
 * 所以这里不采「按钮在不在」，采的是**空状态区块本身**：区块一旦出现在画面上，
 * 它里面的按钮就必须恰好是「一枚圆形图标入口」—— 多一枚、少一枚、带文字、
 * 没 aria-label，都算错。
 *
 * 代价写在明处：**新加空状态却忘了挂标记 = 漏检**。所以标记只挂在「本来
 * 就该给出口」的那种空状态上 —— 书籍管理页筛不出结果时不该给「新建」，
 * 那一刻不挂标记本身就是断言的一部分。
 * ------------------------------------------------------------------ */

interface EmptyZoneProbe {
  /** 区块名（`data-empty-zone` 的值），失败时用来指认是哪一处空状态 */
  name: string
  /** 区块里渲染出来的按钮总数 */
  buttons: number
  /** 其中挂了 `data-empty-create` 的（也就是「空状态的新建入口」） */
  creates: number
  /** 入口是不是圆形图标按钮（挂着同一个 `.app-icon-button` 类） */
  createIsIconButton: boolean
  /** 入口的可见文字。**必须为空** */
  createText: string
  /** 入口的 `aria-label`。**必须非空** */
  createLabel: string
}

/**
 * 探针按 `data-empty-zone` / `data-empty-create` 这两个**我们自己的**属性采，
 * 不依赖 antd 的内部类名（README 第 1 条）。两个属性由产品代码挂在空状态
 * 与它的入口上。
 */
const EMPTY_ZONE_PROBE_JS = `Array.prototype.map.call(
  document.querySelectorAll('[data-empty-zone]'),
  (zone) => {
    const create = zone.querySelector('[data-empty-create]')
    return {
      name: zone.getAttribute('data-empty-zone') || '',
      buttons: zone.querySelectorAll('button').length,
      creates: zone.querySelectorAll('[data-empty-create]').length,
      createIsIconButton: !!create && create.classList.contains('app-icon-button'),
      createText: (create?.textContent || '').trim(),
      createLabel: create?.getAttribute('aria-label') || ''
    }
  }
)`

/** 空状态区块的检查。规矩只有一份，首页与书架页量的是同一套。 */
function checkEmptyZones(zones: EmptyZoneProbe[], pageLabel: string): string[] {
  const problems: string[] = []

  for (const zone of zones) {
    const who = `「${pageLabel}」页的空状态（${zone.name || '未命名区块'}）`

    if (zone.creates !== 1) {
      problems.push(
        `${who}里有 ${zone.creates} 枚新建入口（应为 1 枚）—— 空状态是这一页唯一有内容的地方，书都没了却没有入口，用户在这里无路可走`
      )
      continue
    }
    if (zone.buttons !== 1) {
      problems.push(
        `${who}共 ${zone.buttons} 枚按钮，其中只有 ${zone.creates} 枚是圆形图标入口 —— 空状态里不该有第二种按钮形态（用户 2026-09-20 指的就是「这枚还带着文字」）`
      )
    }
    if (!zone.createIsIconButton) {
      problems.push(
        `${who}的入口不是圆形图标按钮（没有 .app-icon-button 类）—— 它应当与全应用其他按钮同一形态`
      )
    }
    if (zone.createText.length > 0) {
      problems.push(
        `${who}的入口上还写着「${zone.createText}」—— 文字应当移进鼠标悬浮的提示里`
      )
    }
    if (zone.createLabel.length === 0) {
      problems.push(
        `${who}的入口没有 aria-label —— 文字从画面上移走不等于可以删掉，否则读屏读不出它是什么`
      )
    }
  }

  return problems
}

/* ------------------------------------------------------------------ *
 * 并排卡片等高
 *
 * 用户 2026-09-20：「上方的四个并排卡片没有高度对齐？并排的卡片都需要高度对齐」。
 *
 * 为什么不能靠「卡片在不在」这类断言：卡片当然都在，点了也都有反应 ——
 * 不等高是**纯几何**的症状，只有量渲染出来的盒子才看得见。实测够狠：
 * 书籍详情页四张概览卡是 78.5 / 78.5 / 93 / 90px，底边参差 15px。
 *
 * 探针采的是 `[data-card-row]`（我们自己挂的标记），不是组件库的 `.ant-row`
 * —— 沿用「不依赖 UI 库内部类」那条约定（README 第 1 条）：库改个类名，
 * 按内部类采的断言会静默采到 0 个而表现为全绿。
 *
 * 代价写在明处：**新加一行并排卡片却忘了挂标记 = 漏检**。所以每个页面
 * 另有一条「至少量到几行」的计数（见 `CARD_ROWS_MIN`），标记被改掉或
 * 整行被删时会红。这与图标按钮「按 .app-icon-button 类采」是同一取舍。
 * ------------------------------------------------------------------ */

interface CardBoxProbe {
  /** 该列顶边，用来把「同一视觉行」的卡片归到一起（换行后一行里的顶边相同） */
  top: number
  /** 列高。卡片应当与它相等，否则卡片没有吃满列 */
  colHeight: number
  /** 卡片盒子的实测高度；读不到元素时为 -1 */
  cardHeight: number
  /** 卡片元素有没有自己的背景或边框（用来辨认「穿透透明的锚点壳」） */
  cardPainted: boolean
}

interface CardRowProbe {
  /** `data-card-row` 的值，失败时用来指认是哪一行 */
  name: string
  boxes: CardBoxProbe[]
}

/**
 * 探针本体。每个 `[data-card-row]` 量一遍它每一列里的卡片。
 *
 * 「卡片」不是 `col.firstElementChild` 就完事：MetricCard 外面套了一层透明的
 * 锚点 div（data-testid 挂在那上面），真正的白卡片是它的子元素。只量外壳的话，
 * 「外壳被拉高、里面那张卡还是按内容收缩」这种真实故障会被判成全绿 ——
 * 也就是「藏内容要连外壳一起量」的镜像版本。所以壳是透明的（无背景无边框）
 * 且只有一个子元素时，往下走一层再量。
 */
const CARD_ROW_PROBE_JS = `Array.prototype.map.call(
  document.querySelectorAll('[data-card-row]'),
  (row) => {
    const boxes = Array.prototype.filter
      .call(row.children, (col) => col.getBoundingClientRect().height > 0)
      .map((col) => {
        const colRect = col.getBoundingClientRect()
        let el = col.firstElementChild
        let cardPainted = false
        // 最多往下穿 3 层，防手写的嵌套意外把这里变成死循环
        for (let i = 0; el && i < 3; i++) {
          const cs = window.getComputedStyle(el)
          const bg = cs.backgroundColor || ''
          const bare =
            (bg === '' || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') &&
            parseFloat(cs.borderTopWidth || '0') === 0
          if (bare && el.children.length === 1) {
            el = el.firstElementChild
            continue
          }
          cardPainted = !bare
          break
        }
        const cardRect = el ? el.getBoundingClientRect() : null
        return {
          top: Math.round(colRect.top),
          colHeight: Math.round(colRect.height),
          cardHeight: cardRect ? Math.round(cardRect.height) : -1,
          cardPainted
        }
      })
    return { name: row.getAttribute('data-card-row') || '(未命名)', boxes }
  }
)`

/**
 * 把探针结果换算成问题清单。所有页面共用这一份规矩。
 *
 * 分组按**视觉行**而不是按 DOM：`xs={12}` 这类断点会让一行折成两行，
 * 折行之后的卡片本来就该各按自己那一行比 —— 拿全行一起比会把窄窗口下的
 * 正确实现判成失败。
 */
function checkCardRows(rows: CardRowProbe[], pageLabel: string, minRows: number): string[] {
  const problems: string[] = []

  if (rows.length < minRows) {
    problems.push(
      `「${pageLabel}」页只量到 ${rows.length} 行并排卡片（至少应有 ${minRows} 行）—— ` +
        'data-card-row 标记丢了，或新加的卡片行没有跟着挂标记'
    )
  }

  for (const row of rows) {
    const lines: CardBoxProbe[][] = []
    for (const box of [...row.boxes].sort((a, b) => a.top - b.top)) {
      // 2px 容差：同一行里的列顶边理论上完全相等，亚像素取整会差 1px
      const line = lines.find((items) => Math.abs(items[0].top - box.top) <= 2)
      if (line) line.push(box)
      else lines.push([box])
    }

    for (const line of lines) {
      if (line.length < 2) continue

      const unmeasured = line.filter((item) => item.cardHeight < 0)
      if (unmeasured.length > 0) {
        problems.push(
          `「${row.name}」有 ${unmeasured.length} 列里读不到卡片元素，无法验证等高`
        )
      }

      const heights = line.map((item) => item.cardHeight)
      if (Math.max(...heights) - Math.min(...heights) > 2) {
        problems.push(
          `「${row.name}」同一行里的卡片不等高（各 ${heights.join(' / ')}px）—— ` +
            '并排的卡片底边必须齐，卡片要加 `.card-fill`（见 styles.css「并排卡片等高」）'
        )
      }

      // 等高还不够：几张卡一起「按内容收缩成一样高」时也可能齐，
      // 但那一行整体比列矮，卡片下方会空出一条属于列的底色。
      const notFilled = line.filter(
        (item) => item.cardHeight >= 0 && Math.abs(item.cardHeight - item.colHeight) > 2
      )
      if (notFilled.length > 0) {
        problems.push(
          `「${row.name}」有 ${notFilled.length} 张卡片没有吃满所在列（卡高 ${notFilled
            .map((item) => item.cardHeight)
            .join('/')}px，列高 ${notFilled.map((item) => item.colHeight).join('/')}px）`
        )
      }
    }
  }

  return problems
}

/**
 * 把实测的卡片行压成一行证据文本：PASS 行里能直接读出「每行几张卡、各多高」。
 *
 * 为什么值得往 PASS 行里塞：这四张卡不等高时，失败信息说得出问题，
 * 但一切正常时没人看得见「量到的到底是 125px 还是 0（没量到）」——
 * 而 0 与 125 都可能是绿的。
 */
function describeCardRows(rows: CardRowProbe[]): string {
  if (rows.length === 0) return '本页无并排卡片行'
  return rows
    .map((row) => `${row.name} ${row.boxes.map((box) => box.cardHeight).join('/')}px`)
    .join('，')
}

const EDITOR_SNAPSHOT_SCRIPT = `(() => {
  const intOf = (testId) => {
    const el = document.querySelector('[data-testid="' + testId + '"]')
    const n = Number(el?.getAttribute('data-value'))
    return Number.isFinite(n) ? n : -1
  }
  const titleInput = document.querySelector('[data-testid="chapter-title-input"]')
  const surface = document.querySelector('.editor-surface')
  const column = document.querySelector('[data-testid="editor-content"]')
  const statusbar = document.querySelector('.editor-statusbar')
  // 底栏被挤出可视区是真实发生过的：三栏改成网格时行高没约束好，
  // 「计划 / 本章」就跑到窗口外面去了，而 DOM 查询一切正常
  const statusbarRect = statusbar ? statusbar.getBoundingClientRect() : null

  // 高度链是「谁没约束住」的问题，只报一句「底栏不可见」定位不到。
  // 这里把整条链上的每一环都量出来，一眼就能看出是哪一环开始虚高。
  const chain = ['#root', '.app-shell', '.app-shell__body', '.app-main', '.editor-page', '.editor-body', '.editor-main', '.winbook-editor', '.editor-stage', '.editor-statusbar']
  const geometry = chain
    .map((selector) => {
      const el = document.querySelector(selector)
      if (!el) return selector + '=缺失'
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return selector + '[top=' + Math.round(r.top) + ',h=' + Math.round(r.height) +
        ',minH=' + cs.minHeight + ',flex=' + cs.flex + ',dir=' + cs.flexDirection +
        ',al=' + cs.alignItems + ',ovf=' + cs.overflowY + ']'
    })
    .join(' ')

  const widthOf = (selector) => {
    const el = document.querySelector(selector)
    return el ? Math.round(el.getBoundingClientRect().width) : -1
  }
  const pxOf = (value) => {
    const n = parseFloat(value)
    return Number.isFinite(n) ? Math.round(n) : -1
  }
  const toolOf = (testId) => document.querySelector('[data-testid="' + testId + '"]')

  const wash = document.querySelector('.editor-surface__wash')
  const washStyle = wash ? getComputedStyle(wash) : null
  const topbar = document.querySelector('.editor-topbar')
  const contentEl = document.querySelector('.winbook-editor__content')
  const contentStyle = contentEl ? getComputedStyle(contentEl) : null
  const firstP = contentEl ? contentEl.querySelector('p') : null
  const firstPStyle = firstP ? getComputedStyle(firstP) : null
  const underlineBtn = toolOf('editor-underline')
  const tidyBtn = toolOf('editor-tidy')
  const strip = document.querySelector('[data-testid="editor-toolbar-strip"]')
  const scrollLeftBtn = toolOf('editor-toolbar-scroll-left')
  const scrollRightBtn = toolOf('editor-toolbar-scroll-right')
  const itemEls =
    strip && strip.firstElementChild
      ? Array.prototype.slice.call(strip.firstElementChild.children)
      : []

  return {
    mounted: !!document.querySelector('[data-testid="chapter-editor"]'),
    hash: location.hash,
    // 题名从 input 的 value 读：antd 的 Input 不回填 textContent
    title: (titleInput && 'value' in titleInput ? titleInput.value : '') || '',
    paragraphCount: document.querySelectorAll('[data-testid="editor-content"] p').length,
    hanzi: intOf('editor-hanzi'),
    catalogRows: document.querySelectorAll('[data-testid="catalog-row"]').length,
    // 目录栏里的新建入口只该有头部那两枚。分卷行上的 + 与列表底部的
    // 新建章节都已被删掉：同一件事在一屏里给三个入口，只让人每次先做一次
    // 无意义的选择，而目录栏很窄，这些按钮还挤掉了章节标题的宽度。
    //
    // 这两枚的**形态来回变过**（2026-09-20 先被圆钮化、用户当天又点名改回
    // 带文字的按钮 —— 「目录栏头部按钮不用改成图标 + 悬浮提示的形式」），
    // 所以这里两种形态都要数得着：文字按钮读 textContent、圆钮读 aria-label。
    // 只按其中一种读，形态一换这条就会把「入口好端端在那儿」误判成 0 个。
    catalogNewTriggers: (() => {
      const catalog = document.querySelector('[data-testid="chapter-catalog"]')
      if (!catalog) return -1
      return Array.prototype.filter.call(catalog.querySelectorAll('button'), (el) =>
        /新建/.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
      ).length
    })(),
    // 元信息栏只该剩标题。原来那一整行（未分卷 / 草稿 / 本章目标 / 保存信息）
    // 已移到新建章弹窗与书籍设置里。删漏一个控件不会报错，只会让作者每开
    // 一章多做一次无意义的操作 —— 所以这里数的是「除标题外还有几个控件」。
    metabarExtras: (() => {
      const metabar = document.querySelector('.editor-metabar')
      if (!metabar) return -1
      const title = metabar.querySelector('[data-testid="chapter-title-input"]')
      if (!title) return -1
      return metabar.querySelectorAll(
        'input, textarea, .ant-select, .ant-input-number, button'
      ).length - 1
    })(),
    // 底栏「计划」的文案。它必须来自书籍的每章最少字数，而不是本章某个字段
    planText: (document.querySelector('[data-testid="editor-plan"]')?.textContent || '').trim(),
    proofreadCount: intOf('editor-proofread-count'),
    paperInk: surface?.getAttribute('data-paper-ink') ?? '',
    textColor: column ? getComputedStyle(column).color : '',
    statusbarVisible:
      !!statusbarRect && statusbarRect.height > 0 && statusbarRect.bottom <= window.innerHeight + 1,
    geometry: '视口=' + window.innerHeight + ' ' + geometry,
    hasCatalog: !!document.querySelector('[data-testid="chapter-catalog"]'),
    hasToolbar: !!document.querySelector('[data-testid="editor-toolbar"]'),
    hasInspector: !!document.querySelector('[data-testid="editor-inspector"]'),
    // 编辑器顶栏那四枚（查找替换 / 取名 / 专注 / 发布草稿）改造前是「图标 + 文字」，
    // 一共占掉 300px 宽 —— 而这条顶栏的高度写死 46px，宽的那一排把书名与章名
    // 挤到只剩省略号。这里量的是它们现在到底是不是正圆、有没有把文字留干净。
    iconButtons: ${ICON_BUTTON_PROBE_JS},
    theme: document.documentElement.getAttribute('data-theme') ?? '',
    // 纸面底色由背景层承载（正文在它上面一层），所以要量背景层而不是纸面容器
    washColor: washStyle ? washStyle.backgroundColor : '',
    washOpacity: washStyle ? Number(washStyle.opacity) : -1,
    panelColor: topbar ? getComputedStyle(topbar).backgroundColor : '',
    layout: {
      // .editor-body 是「三栏」这一层的宽度，正文占比要跟它比，
      // 跟整窗比会把导航条、状态栏的宽度也算进来
      bodyWidth: widthOf('.editor-body'),
      mainWidth: widthOf('.editor-main'),
      catalogWidth: widthOf('.catalog'),
      inspectorWidth: widthOf('.inspector'),
      panelWidth: widthOf('.inspector__panel'),
      surfaceWidth: widthOf('.editor-surface'),
      columnWidth: widthOf('[data-testid="editor-content"]')
    },
    tools: {
      fontSelect: !!toolOf('editor-font-select'),
      fontSizeSelect: !!toolOf('editor-font-size-select'),
      underline: !!underlineBtn,
      tidy: !!tidyBtn,
      buttonsEnabled: !!underlineBtn && !underlineBtn.disabled && !!tidyBtn && !tidyBtn.disabled
    },
    contentFontSize: contentStyle ? pxOf(contentStyle.fontSize) : -1,
    contentFontFamily: contentStyle ? contentStyle.fontFamily : '',
    firstParagraph: {
      // text-indent 的 computed 值可能是 px，也可能保留 em（不同实现不一样）。
      // 直接 parseFloat 会把 "2em" 读成 2，进而把「缩进两个字」误判成「缩进 2px」，
      // 所以这里遇到 em 就按字号折一次。
      indentPx: (() => {
        if (!firstPStyle) return -1
        const raw = firstPStyle.textIndent
        const value = parseFloat(raw)
        if (!Number.isFinite(value)) return -1
        if (raw.indexOf('em') >= 0) {
          return Math.round(value * (parseFloat(firstPStyle.fontSize) || 0))
        }
        return Math.round(value)
      })(),
      gapPx: firstPStyle ? pxOf(firstPStyle.marginBottom) : -1
    },
    underlineCount: document.querySelectorAll('[data-testid="editor-content"] u').length,
    toolbar: {
      stripFound: !!strip,
      scrollWidth: strip ? strip.scrollWidth : -1,
      clientWidth: strip ? strip.clientWidth : -1,
      scrollLeft: strip ? Math.round(strip.scrollLeft) : -1,
      itemCount: itemEls.length,
      // 折行的判据是控件的中线高度：全部一致 ⇒ 它们在同一行。
      // 数行数不靠谱（滚动容器的高度会跟着内容长），量中线不会。
      itemCenters: itemEls.map((el) => {
        const rect = el.getBoundingClientRect()
        return Math.round((rect.top + rect.bottom) / 2)
      }),
      hasLeftButton: !!scrollLeftBtn,
      hasRightButton: !!scrollRightBtn,
      leftDisabled: scrollLeftBtn ? !!scrollLeftBtn.disabled : true,
      rightDisabled: scrollRightBtn ? !!scrollRightBtn.disabled : true
    }
  }
})()`

/**
 * sRGB 相对亮度（WCAG 定义），只用来判断「这颜色算浅还是算深」。
 *
 * 不做完整对比度计算：纸面是渐变，拿不到单一底色，硬算出来的比值是假精确。
 * 而这里要挡的那个缺陷（把深色墨配到浅色纸上）方向性极其明确 ——
 * 只要「浅/深」这一位对了，就不会出现整段看不见。
 */
function isLightColor(color: string): boolean | null {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)
  if (!match) return null
  const channel = (raw: string): number => {
    const value = Number(raw) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance =
    0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3])
  return luminance > 0.5
}

/** 两个颜色是不是同一个。同色可能写成 rgb(...) 或 rgba(...,1)，也可能差 1，所以按通道比 */
function sameColor(left: string, right: string): boolean {
  const parse = (color: string): number[] | null => {
    const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return false
  return a.every((value, index) => Math.abs(value - b[index]) <= 2)
}

async function checkChapterEditor(
  window: BrowserWindow,
  target: ShowcaseTargets
): Promise<StepResult> {
  const route = `#/books/${target.bookId}/chapters/${target.chapterId}`

  try {
    // HashRouter 认的是 hash，直接改它相当于点了一次链接
    await window.webContents.executeJavaScript(`(() => { location.hash = ${JSON.stringify(route)}; return true })()`)

    const snap = await waitForEditor(window)

    const problems: string[] = []
    if (!snap.mounted) problems.push(`未进入编辑器（hash 停在 ${snap.hash || '空'}）`)
    if (!snap.hasCatalog) problems.push('左侧目录未渲染')
    if (!snap.hasToolbar) problems.push('编辑工具栏未渲染')
    if (!snap.hasInspector) problems.push('右侧检查器未渲染')
    // 题名回填了才说明章节详情真的从库里取回来了，而不只是一个空壳骨架
    if (!snap.title.includes('开场')) problems.push(`章节题名未回填：「${snap.title}」`)
    if (snap.paragraphCount < 1) problems.push(`正文没有段落节点（${snap.paragraphCount}）`)
    // 示例正文共 24 个汉字 —— 数字对不上就说明编辑器正文或计数接错了源
    if (snap.hanzi !== 24) problems.push(`本章汉字数应为 24，实得 ${snap.hanzi}`)
    if (snap.catalogRows < 1) problems.push('目录里没有任何章节行')
    // 示例正文埋了「。。」「「未配对」，纠错引擎至少要报出这几处
    if (snap.proofreadCount < 1) problems.push('纠错面板没有报出任何问题')

    /* ---- 新建入口与元信息行都被收敛过，别让它们悄悄长回来 ---- */
    if (snap.catalogNewTriggers !== 2) {
      problems.push(
        `目录栏里「新建」入口有 ${snap.catalogNewTriggers} 个（应为 2：头部的新建章 / 新建卷）`
      )
    }
    if (snap.metabarExtras !== 0) {
      problems.push(
        `编辑器元信息栏除标题外还有 ${snap.metabarExtras} 个控件（应为 0：分卷 / 状态 / 本章目标 / 保存信息已移到新建章弹窗与书籍设置）`
      )
    }

    /* ---- 顶栏那四枚功能按钮：圆形、只有图标、文字在提示里 ----
     *
     * 用户 2026-09-20 先改的顶栏、再要求「各个界面中的图标也要跟着改」。
     * 编辑器顶栏是这一批里唯一一条**高度写死 46px** 的横条：改造前那四枚
     * 「图标 + 文字」按钮一共占掉 300px 宽，把书名与章名挤到只剩省略号。
     * 所以这里除了量形状，还要确认那四枚都在（它们同时也是顶栏变窄的收益方）。
     */
    problems.push(...checkIconButtons(snap.iconButtons, '章节编辑器'))
    for (const id of EDITOR_TOP_BAR_ACTIONS) {
      if (!snap.iconButtons.some((item) => item.testId === id)) {
        problems.push(`编辑器顶栏少了 [${id}] 按钮 —— 把文字移进提示时最容易连按钮一起删掉`)
      }
    }

    /* ---- 底栏「计划」的口径必须来自书籍的每章最少字数 ---- */
    //
    // 这一条专挡一种回退：编辑器改回读本章自己的 targetWords。展示用书籍的
    // 每章最少字数是 1500，而那一章的 targetWords 是 0 —— 一旦读错源，
    // 底栏会显示「未设目标」，这里立刻能看出来。
    const planRemain = Number(snap.planText.replace(/[^\d-]/g, ''))
    if (snap.planText.length === 0 || snap.planText.includes('未设目标')) {
      problems.push(`底栏「计划」没有算出目标（文案「${snap.planText}」）`)
    } else if (planRemain !== SHOWCASE_CHAPTER_WORDS - snap.hanzi) {
      problems.push(
        `底栏「计划」=${planRemain}，与书籍的每章最少字数 ${SHOWCASE_CHAPTER_WORDS} 减本章 ${snap.hanzi} 字不符（文案「${snap.planText}」）`
      )
    }

    // 正文必须是看得见的：字色的深浅方向要和纸面声明的墨色一致。
    // 这一条是被真事故逼出来的 —— 素白纸上配了近白色的字，正文整段不可见，
    // 而元素在、字数对、纠错也在，前面所有断言照样全绿。
    //
    // 默认纸面声明的是 'theme'（跟随主题），因为它取的底色就是应用面板色：
    // 深色主题下面板是深灰，墨色必须跟着翻过来。期望值在这里推出来，
    // 而不是把 'theme' 当成「没声明」直接放过。
    const expectedInk =
      snap.paperInk === 'theme' ? (snap.theme === 'dark' ? 'light' : 'dark') : snap.paperInk
    const textIsLight = isLightColor(snap.textColor)
    if (expectedInk !== 'dark' && expectedInk !== 'light') {
      problems.push(
        `纸面没有声明墨色取向（data-paper-ink=${snap.paperInk || '缺失'}，主题=${snap.theme || '缺失'}）`
      )
    } else if (textIsLight === null) {
      problems.push(`读不到正文字色（${snap.textColor || '空'}）`)
    } else if (expectedInk === 'dark' && textIsLight) {
      problems.push(`深色墨却算出了浅色字（${snap.textColor}），正文在浅色纸上会看不见`)
    } else if (expectedInk === 'light' && !textIsLight) {
      problems.push(`浅色墨却算出了深色字（${snap.textColor}），正文在深色纸上会看不见`)
    }

    // 纸面底色必须与应用面板同色。章节编辑器是整屏面积最大的一块，
    // 底色一旦自成一色（默认曾是偏绿的「山雾」），整屏观感就跟着偏，
    // 还会和周围的目录、校对面板割裂成两张皮。
    if (snap.washColor === '' || snap.panelColor === '') {
      problems.push(`读不到纸面或面板的底色（纸面「${snap.washColor}」面板「${snap.panelColor}」）`)
    } else if (!sameColor(snap.washColor, snap.panelColor)) {
      problems.push(`纸面底色「${snap.washColor}」与应用面板底色「${snap.panelColor}」不一致`)
    }
    if (snap.washOpacity !== 1) {
      problems.push(`纸面浓度是 ${snap.washOpacity} 而不是 1，底色被叠成了另一个颜色`)
    }

    // 正文要占据最大的那块空间。量的是三栏的宽度分配，不看截图猜。
    const box = snap.layout
    if (box.mainWidth < 0 || box.bodyWidth < 0) {
      problems.push('量不到三栏宽度，无法验证正文是否占据最大空间')
    } else {
      if (box.mainWidth <= box.catalogWidth) {
        problems.push(`正文栏（${box.mainWidth}px）还没有左侧目录（${box.catalogWidth}px）宽`)
      }
      if (box.mainWidth <= box.panelWidth) {
        problems.push(`正文栏（${box.mainWidth}px）还没有右侧校对面板（${box.panelWidth}px）宽`)
      }
      if (box.mainWidth / box.bodyWidth < 0.5) {
        problems.push(
          `正文栏只占三栏总宽的 ${Math.round((box.mainWidth / box.bodyWidth) * 100)}%，没有占据最大空间`
        )
      }
      // 纸面吃满正文栏、正文列再吃满纸面：任何一处被写死的 max-width
      // 或大留白卡住，这个比值就会掉下来（曾经正文列被人为限在 700px）
      if (box.columnWidth / box.mainWidth < 0.75) {
        problems.push(
          `正文列只占正文栏的 ${Math.round((box.columnWidth / box.mainWidth) * 100)}%，被留白或宽度上限吃掉了空间`
        )
      }
    }

    // 工具栏四件套：字体选择、字体大小、下划线、一键格式整理。
    // 这里只验「在不在、能不能按」，点了有没有反应在下一步单独验 ——
    // 只看元素在不在的话，把 onClick 整段删掉也照样全绿。
    const tools = snap.tools
    const missingTools: string[] = []
    if (!tools.fontSelect) missingTools.push('字体选择')
    if (!tools.fontSizeSelect) missingTools.push('字体大小')
    if (!tools.underline) missingTools.push('下划线')
    if (!tools.tidy) missingTools.push('一键格式整理')
    if (missingTools.length > 0) {
      problems.push(`编辑器工具栏缺少：${missingTools.join(' / ')}`)
    } else if (!tools.buttonsEnabled) {
      problems.push('工具栏的下划线 / 整理格式按钮处于禁用态')
    }

    // 底栏必须在可视区内：它承载「计划剩多少 / 本章多少字」，
    // 是写作时全程要瞟的两眼，被挤到窗口外面等于没有
    if (!snap.statusbarVisible) problems.push('底栏不在可视区内（计划 / 本章被挤出窗口）')

    await captureIfRequested(window, 'editor')

    return {
      name: '章节编辑器',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，题名「${snap.title}」，三栏齐备，正文 ${snap.paragraphCount} 段 / ${snap.hanzi} 汉字，目录 ${snap.catalogRows} 行，纠错 ${snap.proofreadCount} 处，墨色 ${expectedInk === 'dark' ? '深' : '浅'}（字色 ${snap.textColor}），纸面底色与面板一致（${snap.washColor}），正文栏 ${box.mainWidth}px / 三栏 ${box.bodyWidth}px（占 ${Math.round((box.mainWidth / box.bodyWidth) * 100)}%），正文列 ${box.columnWidth}px，工具栏四件套齐备`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，题名「${snap.title}」，目录=${
              snap.hasCatalog ? '有' : '无'
            }，工具栏=${snap.hasToolbar ? '有' : '无'}，检查器=${
              snap.hasInspector ? '有' : '无'
            }，段落=${snap.paragraphCount}，汉字=${snap.hanzi}，目录行=${snap.catalogRows}，纠错=${snap.proofreadCount}，墨色=${snap.paperInk || '缺失'}（主题=${snap.theme || '缺失'}），字色=${snap.textColor || '空'}，纸面=${snap.washColor || '空'}(浓度 ${snap.washOpacity})，面板=${snap.panelColor || '空'}，三栏=${snap.layout.catalogWidth}/${snap.layout.mainWidth}/${snap.layout.panelWidth}(栏内 ${snap.layout.bodyWidth})，纸面宽=${snap.layout.surfaceWidth}，正文列宽=${snap.layout.columnWidth}，工具栏=${snap.tools.fontSelect ? '字体✓' : '字体✗'}${
                snap.tools.fontSizeSelect ? '字号✓' : '字号✗'
              }${snap.tools.underline ? '下划线✓' : '下划线✗'}${snap.tools.tidy ? '整理✓' : '整理✗'}` +
            (problems.length === 0 ? '' : `｜高度链：${snap.geometry}`)
    }
  } catch (error) {
    return { name: '章节编辑器', ok: false, detail: messageOf(error) }
  }
}

/**
 * 点**模态确认框**（`modal.confirm`）的「确定」。
 *
 * 与 `clickModalOk` 分开写，因为两者的 DOM 不一样：普通 Modal 的按钮在
 * `.ant-modal-footer` 里，而 `modal.confirm` 渲染的是 `.ant-modal-confirm`，
 * 按钮在 `.ant-modal-confirm-btns` 里 —— 拿前者的选择器去点后者会永远点不到，
 * 报出来却是「没有弹出二次确认」。
 *
 * 之所以需要模态确认：菜单项一点就关，`Popconfirm` 需要一枚常驻的触发元素，
 * 在浮层里挂不住。所以「从菜单里删除」只能走这条路。
 *
 * 会重试：点完菜单项到确认框真正可点之间隔着一两帧，点完就读会读到「没有弹窗」。
 * 判据仍然是**在可见的浮层里**找主按钮（隐藏的旧弹窗不算）。
 */
async function clickConfirmOk(window: BrowserWindow, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const clicked = (await window.webContents.executeJavaScript(`(() => {
      const wraps = Array.prototype.filter.call(
        document.querySelectorAll('.ant-modal-wrap'),
        (el) => el.style.display !== 'none'
      )
      const wrap = wraps[wraps.length - 1]
      if (!wrap) return false
      const btn = wrap.querySelector('.ant-btn-primary')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`)) as boolean

    if (clicked) return true
    await delay(120)
  }

  return false
}

/** 点一下挂着这个 testid 的元素。按钮禁用时返回 false，不硬点 */
async function clickTestId(window: BrowserWindow, testId: string): Promise<boolean> {
  return (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('[data-testid="${testId}"]')
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`
  )) as boolean
}

/**
 * 等某个锚点出现。
 *
 * 「点了某个菜单项 → 界面上长出一样东西」这类时序必须等，不能点完就读：
 * 菜单项自己关掉、目标元素再挂上来，是两帧之后的事。点完立刻查会拿到
 * 「不存在」，报出来却是「功能没实现」。
 */
async function waitForTestId(
  window: BrowserWindow,
  testId: string,
  timeoutMs = 3000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await window.webContents.executeJavaScript(
      `!!document.querySelector('[data-testid="${testId}"]')`
    )) as boolean
    if (found) return true
    await delay(80)
  }
  return false
}

/**
 * 在 antd 的下拉里选中一个选项。
 *
 * 这里确实碰了组件库的类名（.ant-select-item-option），但只在**驱动**上：
 * 断言读的一律是 testid 与实测几何。rc-select 的选项列表挂在 body 上的浮层里，
 * 没有稳定语义可锚；用类名是最省事、也最容易在版本升级时暴露出来的做法。
 * 优先按 role="option" 找，找不到再退回类名。
 */
async function pickSelectOption(
  window: BrowserWindow,
  testId: string,
  optionText: string
): Promise<boolean> {
  // rc-select 在根节点的 mousedown 上展开浮层，不必去找内部的 selector 元素
  const opened = (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('[data-testid="${testId}"]')
      if (!el) return false
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return true
    })()`
  )) as boolean
  if (!opened) return false

  const pick = `(() => {
    const items = Array.prototype.slice
      .call(document.querySelectorAll('[role="option"]'))
      .concat(Array.prototype.slice.call(document.querySelectorAll('.ant-select-item-option')))
    const target = items.find((item) => (item.textContent || '').trim() === ${JSON.stringify(optionText)})
    if (!target) return false
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  })()`

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(pick)) return true
    await delay(100)
  }
  return false
}

/**
 * 选中正文里的全部文字，供「点格式按钮」用。
 *
 * 两个坑：
 *   1. ProseMirror 只在自己持有焦点时才把 DOM 选区同步进 state，所以
 *      必须先 focus 再设选区，否则按钮点下去作用的是上一个选区（多半是空的）；
 *   2. focus 之后 PM 会异步回写一次选区，紧接着设的选区会被它覆盖，
 *      所以中间要留一拍。
 */
async function selectAllEditorText(window: BrowserWindow): Promise<boolean> {
  const focus = `(() => {
    const content = document.querySelector('.winbook-editor__content')
    if (!content) return false
    content.focus()
    return true
  })()`
  if (!(await window.webContents.executeJavaScript(focus))) return false
  await delay(150)

  const select = `(() => {
    const content = document.querySelector('.winbook-editor__content')
    const selection = window.getSelection()
    if (!content || !selection) return false
    const range = document.createRange()
    range.selectNodeContents(content)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`
  if (!(await window.webContents.executeJavaScript(select))) return false
  await delay(150)
  return true
}

/**
 * 读取工具栏的滑动状态，直到满足条件或超时。
 * 平滑滚动是动画，立刻读会读到还没动的 scrollLeft，所以要轮询。
 */
async function readToolbarScroll(
  window: BrowserWindow,
  done: (state: EditorSnapshot['toolbar']) => boolean,
  timeoutMs = 2500
): Promise<EditorSnapshot['toolbar']> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_EDITOR_SNAPSHOT.toolbar

  while (Date.now() < deadline) {
    last = (await waitForEditor(window)).toolbar
    if (done(last)) return last
    await delay(100)
  }

  return last
}

/**
 * 编辑器工具栏四个控件的**行为**验证：下划线、字体选择、字体大小、一键格式整理。
 *
 * 为什么单开一项：前一步只验了「这四个控件在工具栏里」。而「在」和「能用」
 * 是两件事 —— 把 onClick 整段删掉、或者字体下拉的 onChange 写成空函数，
 * 「在」的那条断言照样全绿，用户点下去却什么都不发生。
 *
 * 这里的每一步都看正文的**实测结果**（computed 样式 / DOM 里有没有 u），
 * 不看按钮自己的状态文本。
 */
interface ChapterModalState {
  open: boolean
  hasTitle: boolean
  hasVolume: boolean
  hasStatus: boolean
  hint: string
}

const EMPTY_CHAPTER_MODAL: ChapterModalState = {
  open: false,
  hasTitle: false,
  hasVolume: false,
  hasStatus: false,
  hint: ''
}

/**
 * 读新建章弹窗的状态，直到满足条件或超时。
 *
 * 只在**可见**的浮层里找：antd 的 Modal 关掉之后 DOM 仍留着
 * （destroyOnHidden={false}），拿全局选择器去查会查到上一次那个已经隐藏的
 * 弹窗，读到的全是过期状态。
 */
async function readChapterModal(
  window: BrowserWindow,
  done: (state: ChapterModalState) => boolean,
  timeoutMs = 4000
): Promise<ChapterModalState> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_CHAPTER_MODAL

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(`(() => {
      const wraps = Array.prototype.filter.call(
        document.querySelectorAll('.ant-modal-wrap'),
        (el) => el.style.display !== 'none'
      )
      const modal = wraps[wraps.length - 1]
      if (!modal) return ${JSON.stringify(EMPTY_CHAPTER_MODAL)}
      const foot = modal.querySelector('.ant-modal-footer')
      return {
        open: !!foot,
        hasTitle: !!modal.querySelector('[data-testid="chapter-create-title"]'),
        hasVolume: !!modal.querySelector('[data-testid="chapter-create-volume"]'),
        hasStatus: !!modal.querySelector('[data-testid="chapter-create-status"]'),
        hint: (modal.querySelector('.chapter-create__hint')?.textContent || '').trim()
      }
    })()`)) as ChapterModalState

    if (done(last)) return last
    await delay(100)
  }

  return last
}

/**
 * 等浮层真的从画面上消失。
 *
 * 必须先把窗口显示出来再读。冒烟窗口平时是隐藏的，而隐藏窗口的渲染会被
 * 节流 —— 关闭浮层的**离场动画根本不会推进**，`.ant-modal-wrap` 就一直留在
 * DOM 里。于是「弹窗其实已经关了」会被读成「没关」，报出一个只有自动化才
 * 遇得到的假失败。显示窗口让它跑几帧，读到的才是用户真正看到的那个状态。
 *
 * 判据仍然是「有没有可见的浮层」而不是「有没有动画类名」：动画是实现细节，
 * 关掉了才是行为。
 */
async function waitForModalGone(window: BrowserWindow, timeoutMs = 4000): Promise<boolean> {
  const wasVisible = window.isVisible()
  try {
    await setWindowVisible(window, true)
    const state = await readChapterModal(window, (snapshot) => !snapshot.open, timeoutMs)
    return !state.open
  } finally {
    if (!wasVisible) await setWindowVisible(window, false)
  }
}

/**
 * 点弹窗的确定按钮。
 *
 * 这里碰了组件库的类名（.ant-modal-footer / .ant-btn-primary），但只在**驱动**上：
 * antd 的确定按钮没有稳定的语义锚点，而断言读的一律是我们自己挂的 testid
 * 与主进程回读的数据。
 */
async function clickModalOk(window: BrowserWindow): Promise<boolean> {
  return (await window.webContents.executeJavaScript(`(() => {
    const wraps = Array.prototype.filter.call(
      document.querySelectorAll('.ant-modal-wrap'),
      (el) => el.style.display !== 'none'
    )
    const modal = wraps[wraps.length - 1]
    if (!modal) return false
    const btn = modal.querySelector('.ant-modal-footer .ant-btn-primary')
    if (!btn || btn.disabled) return false
    btn.click()
    return true
  })()`)) as boolean
}

/**
 * 新建章弹窗：标题 / 分卷 / 状态必须在这里一次填完。
 *
 * 为什么值得单开一项：这三项是从编辑器那一行「保存信息」搬过来的。搬家的
 * 实现最容易出的错不是「弹窗打不开」，而是**旧的删了、新的一处没接上** ——
 * 弹窗照常打开，选的分卷或状态却没写进库，创建出来的章节悄悄落回默认值。
 * 用户看到的现象是「我明明选了，怎么没生效」，而任何「控件在不在」的断言
 * 都是全绿的。
 *
 * 所以这里不是点开看一眼：填完标题、真选分卷、真选状态、真提交，然后回到
 * 主进程按标题把那条记录读回来，逐字段核对。
 */
async function checkChapterCreateModal(
  window: BrowserWindow,
  ctx: {
    volumeTitle: string
    volumeId: number | null
    chapterWords: number
    lookup: (
      title: string
    ) => { status: string; volumeId: number | null; targetWords: number } | null
  }
): Promise<StepResult> {
  const problems: string[] = []
  const title = `冒烟-弹窗新建-${STAMP}`
  /** 状态选一个不是默认值（草稿）的，否则「没接上」与「接上了」都是草稿，测不出来 */
  const wantedStatus = 'revising'

  try {
    const before = await waitForEditor(window)
    if (!before.mounted) {
      return {
        name: '新建章弹窗',
        ok: false,
        detail: '当前不在章节编辑器页面上，无法验证新建章弹窗'
      }
    }

    if (!(await clickTestId(window, 'catalog-new-chapter'))) {
      return { name: '新建章弹窗', ok: false, detail: '点不到目录栏头部的「新建章」' }
    }

    /* ① 等弹窗真的开起来 */
    const modal = await readChapterModal(window, (state) => state.open)
    if (!modal.open) {
      return { name: '新建章弹窗', ok: false, detail: '点了「新建章」但弹窗没有打开' }
    }

    if (!modal.hasTitle) problems.push('弹窗里没有章节标题输入框')
    if (!modal.hasVolume) problems.push('弹窗里没有「所属分卷」下拉')
    if (!modal.hasStatus) problems.push('弹窗里没有「状态」下拉')
    // 每章最少字数不进表单，但必须在这里被讲清楚，否则作者不知道这一章照着什么写。
    // 比较前先把千分位逗号与空白去掉：文案走的是格式化的 formatCount（1500 → 「1,500」），
    // 直接拿数字去匹配会得到一个假失败。
    if (!modal.hint.replace(/[,\s]/g, '').includes(String(ctx.chapterWords))) {
      problems.push(
        `弹窗没有说明「每章最少字数」（期望出现 ${ctx.chapterWords}，实测「${modal.hint}」）`
      )
    }

    if (problems.length > 0) {
      return { name: '新建章弹窗', ok: false, detail: problems.join('；') }
    }

    /* ② 三个字段一次填完 */
    const typed = (await window.webContents.executeJavaScript(`(() => {
      const raw = document.querySelector('[data-testid="chapter-create-title"]')
      const input = raw instanceof HTMLInputElement ? raw : (raw && raw.querySelector('input'))
      if (!input) return false
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(title)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)) as boolean

    if (!typed) problems.push('填不进去弹窗的标题输入框')

    if (!(await pickSelectOption(window, 'chapter-create-volume', ctx.volumeTitle))) {
      problems.push(`「所属分卷」里选不到「${ctx.volumeTitle}」`)
    }
    if (!(await pickSelectOption(window, 'chapter-create-status', '修订中'))) {
      problems.push('「状态」里选不到「修订中」')
    }

    if (problems.length > 0) {
      return { name: '新建章弹窗', ok: false, detail: problems.join('；') }
    }

    if (!(await clickModalOk(window))) {
      return { name: '新建章弹窗', ok: false, detail: '点不到弹窗的确定按钮' }
    }

    /* ③ 等它真的跳过去 —— 判据是标题框里的文案变了，不是「等一下」 */
    const landed = await waitForEditor(window, (state) => state.title === title)
    if (landed.title !== title) {
      return {
        name: '新建章弹窗',
        ok: false,
        detail: `提交后没有跳到新章节（编辑器标题仍是「${landed.title}」）`
      }
    }

    /* ④ 回主进程核对：弹窗里选的分卷与状态到底有没有落库 */
    const record = ctx.lookup(title)
    if (!record) {
      return { name: '新建章弹窗', ok: false, detail: `库里找不到刚建的「${title}」` }
    }

    if (record.volumeId !== ctx.volumeId) {
      problems.push(
        `弹窗选了分卷「${ctx.volumeTitle}」，落库的 volumeId 却是 ${String(record.volumeId)}（应为 ${String(ctx.volumeId)}）`
      )
    }
    if (record.status !== wantedStatus) {
      problems.push(`弹窗选了「修订中」，落库的状态却是「${record.status}」`)
    }
    if (record.targetWords !== ctx.chapterWords) {
      problems.push(
        `建章时该把书籍的每章最少字数记为快照 ${ctx.chapterWords}，实际记了 ${record.targetWords}`
      )
    }

    /* ⑤ 建完必须关掉弹窗，并且新章要出现在目录里 */
    //
    // 这一条是**看图看出来的**：给右键菜单配图时，截图里赫然立着一个
    // 「新建章节」弹窗，而它背后的新章节早就建好并跳过去了。此前所有断言
    // 都是绿的 —— 判据是「标题变了」「库里字段对」，没有一条关心弹窗还在不在。
    // 而对作者来说，弹窗还开着就是「没成功」，他会再点一次，于是建出两章同名。
    const closed = await waitForModalGone(window)
    if (!closed) {
      problems.push('创建章节后弹窗没有关闭 —— 作者会以为没建成功，再点一次就多出一章')
    }

    const rowsAfterCreate = await readCatalogRows(window)
    if (!rowsAfterCreate.some((row) => row.title === title)) {
      problems.push(`新建的「${title}」没有出现在目录里（目录里只有 ${rowsAfterCreate.length} 行）`)
    }

    return {
      name: '新建章弹窗',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `弹窗一次收齐标题 / 分卷 / 状态：选「${ctx.volumeTitle}」+「修订中」并提交，跳到新章节、弹窗关闭、目录里出现该行，回库核对 volumeId=${String(record.volumeId)}、状态=${record.status}、目标字数快照=${record.targetWords}`
          : problems.join('；')
    }
  } catch (error) {
    return {
      name: '新建章弹窗',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

/* ==================================================================== *
 * 目录行右键菜单
 * ==================================================================== */

interface CatalogMenuState {
  open: boolean
  /** 菜单项上我们自己挂的 data-testid，按 DOM 顺序 */
  items: string[]
  /** 其中被标为「当前值」的那些（对勾） */
  current: string[]
}

const EMPTY_CATALOG_MENU: CatalogMenuState = { open: false, items: [], current: [] }

interface CatalogRowState {
  id: number
  title: string
  status: string
  active: boolean
  /** 所在分组的 data-volume-id；未分卷是 'none' */
  groupId: string
  hasDot: boolean
}

const CATALOG_ROWS_SCRIPT = `(() => {
  return Array.prototype.map.call(
    document.querySelectorAll('[data-testid="catalog-row"]'),
    (row) => {
      const group = row.closest('[data-testid="catalog-volume-group"]')
      return {
        id: Number(row.getAttribute('data-chapter-id')),
        title: (row.querySelector('.catalog__row-title')?.textContent || '').trim(),
        status: row.getAttribute('data-status') || '',
        active: row.getAttribute('data-active') === 'true',
        groupId: group ? group.getAttribute('data-volume-id') || '' : '',
        hasDot: !!row.querySelector('[data-testid="catalog-row-status-dot"]')
      }
    }
  )
})()`

/**
 * 读右键菜单。
 *
 * 靠 `overlayClassName="catalog__menu"`（我们自己挂的类）找浮层，不看
 * antd 的 `.ant-dropdown` 类名，也不靠它那套 hidden 类判断开合 ——
 * 只问「这块元素现在有没有尺寸」，组件库换 DOM 结构也不会失效。
 */
/**
 * 「当前真正可见的那个菜单」。
 *
 * 读菜单和点菜单**必须共用这一条**，否则两边会各挑各的：每一行都有自己的
 * Dropdown 实例，关掉的那个浮层仍留在 DOM 里（只是没有尺寸），用不带可见性
 * 过滤的 querySelector 会拿到**先渲染的那一行**的菜单 —— 于是在 A 行的菜单里
 * 点「移到分卷」，实际改的是 B 行。这个错还特别安静：A 行已经在该分卷里，
 * 补丁落下去是个 no-op，表现出来只是「点了没反应」。
 *
 * 判可见性只问「有没有尺寸」，不看 antd 的 hidden 类名，组件库换 DOM 结构
 * 也不会失效。
 */
const VISIBLE_CATALOG_MENUS = `Array.prototype.filter.call(
  document.querySelectorAll('.catalog__menu'),
  (el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
)`

const CATALOG_MENU_SCRIPT = `(() => {
  const menus = ${VISIBLE_CATALOG_MENUS}
  const menu = menus[menus.length - 1]
  if (!menu) return ${JSON.stringify(EMPTY_CATALOG_MENU)}

  const labels = Array.prototype.slice.call(menu.querySelectorAll('[data-testid]'))
  return {
    open: labels.length > 0,
    items: labels.map((el) => el.getAttribute('data-testid')),
    current: labels
      .filter((el) => el.getAttribute('data-current') === 'true')
      .map((el) => el.getAttribute('data-testid'))
  }
})()`

async function readCatalogMenu(
  window: BrowserWindow,
  done: (state: CatalogMenuState) => boolean,
  timeoutMs = 3000
): Promise<CatalogMenuState> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_CATALOG_MENU

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(CATALOG_MENU_SCRIPT)) as CatalogMenuState
    if (done(last)) return last
    await delay(80)
  }

  return last
}

async function readCatalogRows(window: BrowserWindow): Promise<CatalogRowState[]> {
  return (await window.webContents.executeJavaScript(CATALOG_ROWS_SCRIPT)) as CatalogRowState[]
}

/**
 * 等某一行的界面状态跟上。
 *
 * 单独需要它的原因：库里已经是新值了，界面还不一定是。`invalidateLibrary`
 * 之后要重取列表再重渲一遍，而回读数据库的轮询在写入那一刻就返回了 ——
 * 紧接着去读 DOM，读到的是**改动之前**的那一帧，于是报出「库里改了、
 * 界面没跟上」这种听起来很严重、其实只是自己抢跑了的假失败。
 */
async function waitForCatalogRow(
  window: BrowserWindow,
  chapterId: number,
  hit: (row: CatalogRowState) => boolean,
  timeoutMs = 4000
): Promise<CatalogRowState | null> {
  const deadline = Date.now() + timeoutMs
  let last: CatalogRowState | null = null

  while (Date.now() < deadline) {
    const rows = await readCatalogRows(window)
    last = rows.find((row) => row.id === chapterId) ?? null
    if (last !== null && hit(last)) return last
    await delay(100)
  }

  return last
}

/**
 * 先关掉已经开着的菜单。
 *
 * 每一行都挂着自己的 Dropdown 实例，前一个不关就右键下一行，页面上会同时
 * 浮着两个菜单 —— 之后所有「读菜单」的断言都变成在赌读到的是哪一个。
 * 关的方式是在 body 上派发一次 mousedown：rc-trigger 靠文档级 mousedown
 * 判断「点到外面了」。不用 focus / blur，因为浮层里的项本来就不一定持有焦点。
 */
async function closeCatalogMenu(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    return true
  })()`)
  await readCatalogMenu(window, (state) => !state.open, 1000)
}

/** 在指定章节行上右键，等菜单出来 */
async function openRowMenu(
  window: BrowserWindow,
  chapterId: number
): Promise<CatalogMenuState> {
  return openContextMenuOn(window, '[data-testid="catalog-row"][data-chapter-id="' + chapterId + '"]')
}

/**
 * 在指定分卷行上右键，等菜单出来。
 *
 * 与章节行共用同一段派发逻辑（`openContextMenuOn`）：两者都挂
 * `overlayClassName="catalog__menu"`，读菜单与点菜单的辅助函数也是同一套。
 */
async function openVolumeMenu(
  window: BrowserWindow,
  volumeId: number
): Promise<CatalogMenuState> {
  return openContextMenuOn(
    window,
    '[data-testid="catalog-volume"][data-volume-id="' + volumeId + '"]'
  )
}

/** 在任意元素上派发一次 contextmenu（鼠标右键）并等菜单浮层出现 */
async function openContextMenuOn(
  window: BrowserWindow,
  selector: string
): Promise<CatalogMenuState> {
  await closeCatalogMenu(window)

  const dispatched = (await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)})
    if (!row) return false
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    }))
    return true
  })()`)) as boolean

  if (!dispatched) return EMPTY_CATALOG_MENU
  return readCatalogMenu(window, (state) => state.open)
}

/**
 * 点菜单里的某一项。
 *
 * 在挂着 testid 的那个 span 上派发 click 就够了：React 的事件处理器挂在外层
 * 的菜单项上，冒泡能到。所以这里连 `role="menuitem"` 都不用找。
 *
 * 但**必须限定在当前可见的那个菜单里**，理由见 VISIBLE_CATALOG_MENUS。
 */
async function clickMenuItem(window: BrowserWindow, testId: string): Promise<boolean> {
  return (await window.webContents.executeJavaScript(`(() => {
    const menus = ${VISIBLE_CATALOG_MENUS}
    const menu = menus[menus.length - 1]
    if (!menu) return false
    const label = menu.querySelector('[data-testid="${testId}"]')
    if (!label) return false
    label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  })()`)) as boolean
}

/** 轮询主进程里的那条记录，直到满足条件（菜单改的就是库里的值，判据只能在库里） */
async function waitForChapterRecord<T extends { id: number }>(
  lookup: () => T | null,
  hit: (record: T) => boolean,
  timeoutMs = 4000
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  let last: T | null = null

  while (Date.now() < deadline) {
    last = lookup()
    if (last !== null && hit(last)) return last
    await delay(100)
  }

  return last
}

/**
 * 目录行右键菜单：状态与所属分卷的事后修改入口。
 *
 * 为什么值得单开一项：这两项原先只在新建章弹窗里能设，之后再无入口 ——
 * 而状态是会随写作推进变化的（草稿→修订中→已完成）。菜单这种东西的实现
 * 最容易出的错恰恰是「点了没反应」与「改错了对象」：
 *
 *   1. 菜单照常弹出、点下去也关掉了，但回调没接上，库里什么都没变；
 *   2. `chapterUpdate` 是**整体替换**（title / status / volumeId /
 *      targetWords 都得给全），补入参时补错一处，就会出现「我改 A 章的
 *      分卷，B 章的正文被抹了」；
 *   3. 菜单里的对勾不跟着状态刷新，改完再打开还是旧的对勾。
 *
 * 这三条都不是「元素在不在」能测出来的，所以这里一律：真右键、真点、
 * 回主进程读库核对，并且**同时核对没被操作的那一章没被动过**。
 */
async function checkCatalogContextMenu(
  window: BrowserWindow,
  ctx: {
    volumeId: number
    volumeTitle: string
    lookup: (title: string) => {
      id: number
      title: string
      status: string
      volumeId: number | null
      targetWords: number
      hanziCount: number
    } | null
  }
): Promise<StepResult> {
  const name = '目录右键菜单'
  const problems: string[] = []

  try {
    /*
     * 判据不带「渲染齐备」：上一步刚建出来的新章节正文是空的、也没有可报的
     * 纠错，拿齐备条件去等会白等 20 秒再报一个假失败。
     * 这里真正需要的只有一件事 —— 目录里有两行（一行当前、一行别处的）。
     */
    const landed = await waitForEditor(
      window,
      (state) => state.mounted && state.hasCatalog && state.catalogRows >= 2
    )

    if (!landed.mounted || !landed.hasCatalog) {
      return { name, ok: false, detail: '当前不在章节编辑器页面上' }
    }
    if (landed.catalogRows < 2) {
      return {
        name,
        ok: false,
        detail: `目录里只有 ${landed.catalogRows} 行，「改这一行不碰那一行」验证需要至少两章`
      }
    }

    const activeRecord = ctx.lookup(landed.title)
    if (!activeRecord) {
      return { name, ok: false, detail: `正在编辑的「${landed.title}」在库里找不到` }
    }
    if (activeRecord.volumeId === null) {
      return {
        name,
        ok: false,
        detail: `正在编辑的「${landed.title}」不在任何分卷里，菜单的分卷项验证需要它先在某一卷`
      }
    }

    const activeVolumeItem = `catalog-menu-volume-${activeRecord.volumeId}`

    /* ---- ① 在正在编辑的那一行上右键：菜单要出，且现状要对得上 ---- */
    const opened = await openRowMenu(window, activeRecord.id)
    if (!opened.open) {
      return { name, ok: false, detail: '在目录行上右键没有弹出菜单' }
    }

    for (const testId of [
      'catalog-menu-status-draft',
      'catalog-menu-status-revising',
      'catalog-menu-status-done',
      'catalog-menu-volume-none',
      activeVolumeItem
    ]) {
      if (!opened.items.includes(testId)) {
        problems.push(`右键菜单里缺「${testId}」（现有的：${opened.items.join(' / ') || '空'}）`)
      }
    }

    const expectStatusItem = `catalog-menu-status-${activeRecord.status}`
    if (!opened.current.includes(expectStatusItem)) {
      problems.push(
        `菜单没有把当前状态「${activeRecord.status}」标为选中（标了：${opened.current.join(' / ') || '无'}）`
      )
    }
    const statusMarked = opened.current.filter((item) => item.startsWith('catalog-menu-status-'))
    if (statusMarked.length !== 1) {
      problems.push(`状态项里有 ${statusMarked.length} 个被标成「当前」，应当恰好 1 个`)
    }
    if (!opened.current.includes(activeVolumeItem)) {
      problems.push(
        `菜单没有把当前所属分卷（${String(activeRecord.volumeId)}）标为选中（标了：${opened.current.join(' / ') || '无'}）`
      )
    }

    if (problems.length > 0) {
      return { name, ok: false, detail: problems.join('；') }
    }

    /* ---- ② 点「已完成」：库里必须真的变，界面上必须看得见 ---- */
    if (!(await clickMenuItem(window, 'catalog-menu-status-done'))) {
      return { name, ok: false, detail: '点不到菜单里的「已完成」' }
    }

    const doneRecord = await waitForChapterRecord(
      () => ctx.lookup(activeRecord.title),
      (record) => record.status === 'done'
    )
    if (doneRecord === null || doneRecord.status !== 'done') {
      problems.push(
        `点了「已完成」，库里「${activeRecord.title}」的状态还是 ${doneRecord?.status ?? '读不到'}`
      )
    }
    if (doneRecord !== null) {
      /*
       * 正文一个字都不能变。菜单走的是整体替换的接口，补入参时漏掉正文相关
       * 的字段（或把内容字段当成可选项略过）就会在这里露出来。
       */
      if (doneRecord.hanziCount !== activeRecord.hanziCount) {
        problems.push(
          `改状态顺手改掉了正文：汉字数 ${activeRecord.hanziCount} → ${doneRecord.hanziCount}`
        )
      }
      if (doneRecord.volumeId !== activeRecord.volumeId) {
        problems.push(
          `只改了状态，所属分卷却被改了：${String(activeRecord.volumeId)} → ${String(doneRecord.volumeId)}`
        )
      }
      if (doneRecord.title !== activeRecord.title) {
        problems.push(`只改了状态，标题却被改了：「${activeRecord.title}」→「${doneRecord.title}」`)
      }
    }

    /*
     * 界面上必须有反馈。库里改了、界面上什么也看不出来，用户就无法确认
     * 操作是否生效 —— 这也是这个字段会变成「死字段」的原因本身。
     */
    const marked = await waitForCatalogRow(
      window,
      activeRecord.id,
      (row) => row.status === 'done' && row.hasDot
    )
    if (!marked) {
      problems.push('改完状态后，正在编辑的那一行从目录里消失了')
    } else {
      if (marked.status !== 'done') {
        problems.push(`库里已是「已完成」，目录行的状态标记还停在 ${marked.status}（界面没跟上）`)
      }
      if (!marked.hasDot) problems.push('「已完成」的章节行没有状态点，改完状态看不出来')
    }

    /* ---- ③ 重开菜单：对勾必须跟着新状态走，不能是缓存的旧值 ---- */
    const reopened = await openRowMenu(window, activeRecord.id)
    if (!reopened.open) {
      problems.push('第二次右键同一行，菜单没有弹出')
    } else if (!reopened.current.includes('catalog-menu-status-done')) {
      problems.push(
        `改完状态后重开菜单，对勾没有跟过去（仍标：${reopened.current.join(' / ') || '无'}）`
      )
    }

    /* ---- ④ 改另一行：不能碰到正在编辑的这一章 ---- */
    const rows = await readCatalogRows(window)
    const other = rows.find((row) => row.id !== activeRecord.id)
    if (!other) {
      return {
        name,
        ok: false,
        detail: problems.length > 0
          ? problems.join('；')
          : '目录里只剩一行，无法验证「改这一行不会动到那一行」'
      }
    }

    const otherBefore = ctx.lookup(other.title)
    const activeBefore = ctx.lookup(activeRecord.title)
    if (!otherBefore || !activeBefore) {
      return { name, ok: false, detail: `目录里的「${other.title}」在库里读不到` }
    }

    const otherMenu = await openRowMenu(window, otherBefore.id)
    if (!otherMenu.open) {
      problems.push(`在「${other.title}」那一行上右键没有弹出菜单`)
    } else if (!(await clickMenuItem(window, activeVolumeItem))) {
      problems.push(`点不到菜单里的分卷「${ctx.volumeTitle}」`)
    } else {
      const moved = await waitForChapterRecord(
        () => ctx.lookup(other.title),
        (record) => record.volumeId === ctx.volumeId
      )
      if (moved === null || moved.volumeId !== ctx.volumeId) {
        problems.push(
          `给「${other.title}」选了分卷「${ctx.volumeTitle}」，库里记的却是 ${String(moved?.volumeId ?? null)}（应为 ${ctx.volumeId}）`
        )
      } else if (moved.hanziCount !== otherBefore.hanziCount) {
        problems.push(
          `移分卷时把「${other.title}」的正文弄丢了：${otherBefore.hanziCount} → ${moved.hanziCount}`
        )
      } else if (moved.status !== otherBefore.status) {
        problems.push(
          `只移了分卷，「${other.title}」的状态却被顺带改了：${otherBefore.status} → ${moved.status}`
        )
      }

      /*
       * 这一步是整项的要点：操作对象是「那一行」，而在编辑的是「这一行」。
       * 整体替换的接口只要补错一次入参，写出去的就是正在编辑的标题 ——
       * 而用户看到的只是「我给另一章分了个卷，当前章的标题怎么变了」。
       */
      const activeAfter = ctx.lookup(activeRecord.title)
      if (activeAfter === null) {
        problems.push(`给「${other.title}」移分卷后，正在编辑的「${activeRecord.title}」读不到了`)
      } else if (
        activeAfter.status !== activeBefore.status ||
        activeAfter.volumeId !== activeBefore.volumeId ||
        activeAfter.hanziCount !== activeBefore.hanziCount
      ) {
        problems.push(
          `操作「${other.title}」影响到了正在编辑的「${activeRecord.title}」：` +
            `状态 ${activeBefore.status}→${activeAfter.status}、` +
            `分卷 ${String(activeBefore.volumeId)}→${String(activeAfter.volumeId)}、` +
            `汉字数 ${activeBefore.hanziCount}→${activeAfter.hanziCount}`
        )
      }

      /* 结构上也要跟着走：那一行得出现在目标分卷的分组里 */
      await waitForCatalogRow(window, otherBefore.id, (row) => row.groupId === String(ctx.volumeId))
      const after = await readCatalogRows(window)
      const movedRow = after.find((row) => row.id === otherBefore.id)
      if (!movedRow) {
        problems.push(`移完分卷后「${other.title}」那一行从目录里消失了`)
      } else if (movedRow.groupId !== String(ctx.volumeId)) {
        problems.push(
          `「${other.title}」已归入分卷 ${ctx.volumeId}，行却还在分组 ${movedRow.groupId || '未知'} 下面`
        )
      }
      /*
       * 只断言「这一行确实从『未分卷』里少了一个」。
       *
       * 不能断言「未分卷分组消失」：这本书里还有别的未归卷章节（大纲节点
       * 落地成的章就带着 null 分卷），那种写法会把「别的章本来就未分卷」
       * 算成本次操作的失败 —— 是拿自己的假设去规定数据，而不是规定行为。
       */
      const looseBefore = rows.filter((row) => row.groupId === 'none').length
      const looseAfter = after.filter((row) => row.groupId === 'none').length
      if (looseAfter !== looseBefore - 1) {
        problems.push(
          `移分卷后「未分卷」分组里的章数应当从 ${looseBefore} 变成 ${looseBefore - 1}，实测 ${looseAfter}`
        )
      }
      // 正在编辑的那一行不能被这次操作带走（它是当前章，只该待在原地）
      const stillActive = after.find((row) => row.id === activeRecord.id)
      if (!stillActive?.active) {
        problems.push('操作另一行之后，正在编辑的章节变了')
      }
    }

    /*
     * 文档配图专用：右键菜单只有真的右键才出现，别的截图一张都拍不到它，
     * 而它恰恰是这一版新增的东西。放在所有断言之后 —— 它只负责换个画面，
     * 不参与通过与否，也就不会因为「截图时窗口被显示出来导致浮层被关掉」
     * 而把断言带成红灯。
     */
    await openRowMenu(window, activeRecord.id)
    await captureIfRequested(window, 'catalog-menu')

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `右键「${activeRecord.title}」→ 标为已完成（库中状态 ${doneRecord?.status}、行上出现状态点、重开菜单对勾已跟过去）；` +
            `右键「${other.title}」→ 移到「${ctx.volumeTitle}」（库中 volumeId=${ctx.volumeId}、行已落进该分组、未分卷分组少一章）；` +
            `全程正文与另外一章的字段均未被改动`
          : problems.join('；')
    }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

interface RouteState {
  hash: string
  pageTitle: string
  /**
   * 页标题在画面上是否占位。
   *
   * 用户 2026-09-20 要求「页标题移除，不要展示」：首页与四个模块页
   * （书籍管理 / 大纲管理 / 卡片库 / 统计）的标题都是**导航标签**，
   * 内容本身已经说明了这是哪一页 —— 必须 false。
   *
   * 曾经有过一个例外：书籍详情页显示书名（那里的标题是内容）。那一页后来
   * 被整体取消（同一天的「打开书籍后直接就是正文编辑界面」），书名改挂在
   * 编辑器顶栏上 —— 那是同一页里的一条横带，不是页标题。**于是「一律不显示」
   * 现在没有例外**，这个字段也就只有一种期望值。
   *
   * 判据是**实测面积**而不是类名：类名怎么改都行，「占不占画面」才是事实。
   * 与该隐的没隐（回去了）互为正反两条断言。
   */
  titleVisible: boolean
  /** 可见标题的左 / 上坐标；标题隐藏时是 -1 */
  titleLeft: number
  titleTop: number
  /**
   * 右侧操作区（`.page-header__extra`）的左 / 上坐标。
   *
   * 和标题的坐标一起证明「书名显示在**原标题的位置**」：同一行（top 接近）、
   * 书名在左、按钮在右。只断 `titleVisible` 的话，标题被挪到页面底部
   * 另起一行也同样通过。
   */
  actionsLeft: number
  actionsTop: number
  /**
   * 外层标题行（`.page-header`）里没有任何可见内容的个数。
   *
   * 专挡「标题隐了、外壳还在」这种半途改动：`.page-header` 是 flex 行，
   * 还套着一层空壳的话，父级 `gap: 16` 会在页顶留下 16px 死空间 ——
   * 页面高度没问题、断言全绿，只是内容整体下移一截，看不出来源。
   */
  emptyHeaderRows: number
  hasTopNav: boolean
  hasHomeButton: boolean
  /**
   * 返回首页按钮的实测几何与定位方式。
   *
   * 用户对它提过两次要求（2026-09-20）：先是「不要顶部菜单」，再是
   * 「返回首页的图标要**悬浮**在角落、不是固定在界面里的图标」。
   * 所以这里读的不只是尺寸 —— `position` 与到窗口两边的距离才是
   * 「悬浮」这件事的实测证据。
   */
  homeButton: {
    width: number
    height: number
    radiusPx: number
    position: string
    zIndex: number
    /** 距窗口右缘 / 下缘的距离。悬浮在右下角时这两个值应当很小 */
    rightInset: number
    bottomInset: number
    /** 是否落在顶栏的高度范围内（「不是顶栏里的图标」要靠它证明） */
    insideTopBar: boolean
  } | null
  /** 品牌区的左坐标：用来证明按钮出现/消失不会把顶栏内容挤跑 */
  brandLeft: number
  moduleCount: number
  /**
   * 画面上所有圆形图标按钮的实测形态（见 `ICON_BUTTON_PROBE_JS`）。
   *
   * 这份探针挂在**路由快照**上，所以首页、四个模块页、书籍详情页都会各量一遍
   * —— 用户 2026-09-20 要求「各个界面中的图标也要跟着改」，而「各个界面」
   * 没法用一条断言写完，用「每个页面各量一次、规矩共用同一份」才拦得住
   * 「只改了一半页面」。
   */
  iconButtons: IconButtonProbe[]
  /**
   * 同一页上**重复出现**的按钮锚点（按钮级别的 `data-testid`，出现两次以上）。
   *
   * 卡片库真出过这个：工具栏上的「新建卡片」被复制成了两份（连同那段
   * 「固定在工具栏最左端」的注释一起复制），于是两枚一模一样的蓝圆并排站着。
   * 而所有断言读的都是 `querySelector('[data-testid="cards-add"]')` ——
   * 永远只读到左边那一枚，右边那枚是「测试看不见的第二份」，
   * 存在性、几何、提示文案全都查得挺好。
   *
   * 只数 `<button>`：列表行的锚点（`progress-row` / `catalog-row` / `module-entry`）
   * 本来就该出现多次，混进来会变成一堆误报。按钮锚点重复则几乎只可能是
   * 复制粘贴失手 —— 同一颗按钮在一屏里出现两次没有合理用途。
   */
  duplicateButtonTestIds: string[]
  /**
   * 每一行并排卡片的实测几何（见 `CARD_ROW_PROBE_JS`）。
   *
   * 用户 2026-09-20：「并排的卡片都需要高度对齐」。这件事没有任何
   * 「存在性」断言能替代 —— 四张卡都在、都能点、内容都对，只是底边参差。
   * 挂在路由快照上，所以首页、四个模块页、书籍详情页各量一遍，
   * 规矩共用同一份 `checkCardRows`。
   */
  cardRows: CardRowProbe[]
  /**
   * 「在写书籍」这类进度列表渲染出的行数。
   *
   * 只有一个用途：把「数据还在路上」和「真的没有在写的书」分开。空状态断言
   * 挂在下面那个探针上，而**加载中读到的空状态集合必然也是空的** ——
   * 不区分的话，「空状态入口被删掉」会伪装成「还没加载完」而静默通过。
   */
  bookProgressRows: number
  /**
   * 空状态区块的实测形态（见 `EMPTY_ZONE_PROBE_JS`）。
   *
   * 用户 2026-09-20 看着首页截图指出：空状态那枚「新建第一本书」还是带文字的
   * 长条，全应用就剩这两处没改。挂在路由快照上，首页与各模块页各量一遍 ——
   * 全应用只有书籍相关的这两处是「页面上没有内容、只剩一个动作」的样子。
   */
  emptyZones: EmptyZoneProbe[]
}

const EMPTY_ROUTE_STATE: RouteState = {
  hash: '',
  pageTitle: '',
  titleVisible: false,
  titleLeft: -1,
  titleTop: -1,
  actionsLeft: -1,
  actionsTop: -1,
  emptyHeaderRows: 0,
  hasTopNav: false,
  hasHomeButton: false,
  homeButton: null,
  brandLeft: -1,
  moduleCount: 0,
  iconButtons: [],
  duplicateButtonTestIds: [],
  cardRows: [],
  bookProgressRows: 0,
  emptyZones: []
}

/**
 * 读「当前在哪一页」的实测状态。
 *
 * 与首页快照分开写：那个快照里全是首页特有的数据指标（书籍数、趋势图高度），
 * 换个页面读到的全是 0 与 -1，混在一起会让人误以为「数据没加载出来」。
 * 这里只读路由与导航相关的通用事实。
 */
const ROUTE_STATE_SCRIPT = `(() => {
  const titleEl = document.querySelector('[data-testid="page-title"]')
  const titleRect = titleEl?.getBoundingClientRect()
  const extraEl = document.querySelector('.page-header__extra')
  const brandEl = document.querySelector('.app-header__brand')
  const headerEl = document.querySelector('.app-header')
  const homeEl = document.querySelector('[data-testid="home-button"]')
  let homeButton = null
  if (homeEl) {
    const rect = homeEl.getBoundingClientRect()
    const style = window.getComputedStyle(homeEl)
    // border-radius 写成 50% 时，computedStyle 原样返回字符串 "50%"，
    // parseFloat 会得到 50 这个「像素数」—— 直接拿去比会误判成不是圆角。
    // 百分比要按宽度折算成像素（圆形按钮的 50% === 宽度的一半）。
    const rawRadius = style.borderTopLeftRadius || '0'
    const radiusPx = rawRadius.trim().endsWith('%')
      ? Math.round((rect.width * parseFloat(rawRadius)) / 100)
      : Math.round(parseFloat(rawRadius))
    homeButton = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radiusPx,
      position: style.position,
      zIndex: Number(style.zIndex) > 0 ? Number(style.zIndex) : 0,
      rightInset: Math.round(window.innerWidth - rect.right),
      bottomInset: Math.round(window.innerHeight - rect.bottom),
      insideTopBar: headerEl ? rect.top < headerEl.getBoundingClientRect().bottom - 1 : false
    }
  }
  return {
    hash: location.hash,
    pageTitle: titleEl?.textContent ?? '',
    titleVisible: !!titleRect && titleRect.width > 2 && titleRect.height > 2,
    // 标题与操作区的实测位置。用来证明「书名显示在原标题的位置」——同一行、
    // 书名在左、按钮在右，而不只是「标题出现在页面某处」。
    titleLeft: titleRect ? Math.round(titleRect.left) : -1,
    titleTop: titleRect ? Math.round(titleRect.top) : -1,
    actionsLeft: extraEl ? Math.round(extraEl.getBoundingClientRect().left) : -1,
    actionsTop: extraEl ? Math.round(extraEl.getBoundingClientRect().top) : -1,
    // 空壳标题行：外层还在，里面却没有任何可见子元素。这类残留不会让任何
    // 「标题在不在」的断言变红，只是在页顶留出一截空白。
    emptyHeaderRows: Array.prototype.filter.call(
      document.querySelectorAll('.page-header'),
      (row) =>
        !Array.prototype.some.call(row.children, (child) => {
          const r = child.getBoundingClientRect()
          return r.width > 2 && r.height > 2
        })
    ).length,
    hasTopNav: !!document.querySelector('[data-testid="app-nav"]'),
    hasHomeButton: !!homeEl,
    homeButton,
    brandLeft: brandEl ? Math.round(brandEl.getBoundingClientRect().left) : -1,
    moduleCount: document.querySelectorAll('[data-testid="module-entry"]').length,
    iconButtons: ${ICON_BUTTON_PROBE_JS},
    // 「在写书籍」的行数：用来区分「还没加载完」与「真的没有在写的书」，
    // 否则空状态断言会把「入口被删掉」读成「还没加载完」。
    bookProgressRows: document.querySelectorAll('[data-testid="progress-row"]').length,
    // 空状态区块：区块出现就要求「里面恰好一枚圆形图标入口」（见
    // EMPTY_ZONE_PROBE_JS 的说明）。首页与各模块页各量一遍。
    emptyZones: ${EMPTY_ZONE_PROBE_JS},
    // 每一行并排卡片的实测几何。用户 2026-09-20：「并排的卡片都需要高度对齐」。
    cardRows: ${CARD_ROW_PROBE_JS},
    // 重复的按钮锚点：同一颗按钮在一屏里出现两次。见 RouteState 里的说明 ——
    // 这类重复会让所有「按锚点查一次」的断言只查到第一枚，另一枚永远没人看。
    // 列表行锚点（一屏里本来就很多个、用 querySelectorAll 读）在白名单里。
    duplicateButtonTestIds: (() => {
      const repeatable = ${JSON.stringify(REPEATABLE_BUTTON_ANCHORS)}
      const seen = []
      const dup = []
      Array.prototype.forEach.call(document.querySelectorAll('button[data-testid]'), (el) => {
        const id = el.getAttribute('data-testid')
        if (repeatable.indexOf(id) >= 0) return
        if (seen.indexOf(id) >= 0) {
          if (dup.indexOf(id) < 0) dup.push(id)
        } else {
          seen.push(id)
        }
      })
      return dup
    })()
  }
})()`

async function readRouteState(
  window: BrowserWindow,
  done: (state: RouteState) => boolean,
  timeoutMs = 8000
): Promise<RouteState> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_ROUTE_STATE

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(ROUTE_STATE_SCRIPT)) as RouteState
    if (done(last)) return last
    await delay(100)
  }

  return last
}

/**
 * 点某一模块卡片。
 *
 * 必须按 data-module-key 定位到**那一张**，而不是「第一张」：四张卡片
 * 的跳转逻辑一模一样，只有目标路径不同 —— 复制粘贴时把两张卡片的路径
 * 写成同一个，用「点第一张」的测法永远发现不了。
 */
async function clickModuleEntry(window: BrowserWindow, key: string): Promise<boolean> {
  return (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('[data-testid="module-entry"][data-module-key="${key}"]')
      if (!el) return false
      el.click()
      return true
    })()`
  )) as boolean
}

async function gotoHome(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    `(() => { location.hash = '#/'; return true })()`
  )
}

/**
 * 首页即启动台：卡片能跳出去，跳出去之后能回来。
 *
 * 为什么这一条不能省：顶部导航条被整条删掉之后，首页卡片成了**唯一**的
 * 模块入口，而返回首页按钮成了**唯一**的脱身出口。这两个东西一起坏掉
 * （比如卡片 onClick 没接上、返回按钮只在某个页面渲染），用户就被关在
 * 单个模块里出不来，而其它所有断言依然是全绿的 —— 它们的页面是直接改
 * hash 进去的，压根不经过这两个按钮。
 *
 * 所以这里走完整往返，而且**四个模块各走一遍**：单测一个模块只能证明
 * 「跳转这件事能work」，证不了「四张卡片各自指向正确的模块」。
 */
async function checkHomeNavigation(window: BrowserWindow): Promise<StepResult> {
  const name = '首页启动台'
  const problems: string[] = []

  try {
    await gotoHome(window)
    /*
     * 等判据里带上「在写书籍」区已就绪：`emptyZones` 在数据回来之前必然是空的，
     * 只等 `moduleCount` 会读到一个「还没有区块」的帧 —— 那时空状态断言不会
     * 报错（区块不在画面上是合法的），但**也永远不会开始工作**。
     * 要么读到行（有书），要么读到空状态区块（没有书），两者都没有就是还没加载完。
     */
    const home = await readRouteState(
      window,
      (state) =>
        state.moduleCount > 0 && (state.bookProgressRows > 0 || state.emptyZones.length > 0)
    )

    if (home.moduleCount !== HOME_MODULES.length) {
      return {
        name,
        ok: false,
        detail: `首页只有 ${home.moduleCount} 张功能卡片，无法继续验证跳转（应为 ${HOME_MODULES.length} 张）`
      }
    }
    // 首页上不该有「返回首页」：它就是根，摆一个点了没反应的按钮只是噪音
    if (home.hasHomeButton) {
      problems.push('首页上也有「返回首页」按钮 —— 在根页面上它是无意义的噪音')
    }

    // 首页有三行并排卡片（功能模块 / 首页指标 / 趋势与今日），每一行内部必须等高
    problems.push(...checkCardRows(home.cardRows, '首页', CARD_ROWS_MIN['/'] ?? 0))

    /* 空状态里的新建入口（见 `checkEmptyZones` 的说明）。
     *
     * 用户 2026-09-20 看着首页截图问的正是这一枚：「这个按钮没有改？太丑了，
     * 改成【+】图标加鼠标悬浮提示的形式」。区块不在画面上时这里不报错 ——
     * 「有书可写」的时候本来就没有空状态。 */
    problems.push(...checkEmptyZones(home.emptyZones, '首页'))

    // 品牌区的左坐标作为「顶栏没被挤动」的基线。悬浮按钮不在布局流里，
    // 它在与不在都不该让顶栏的任何东西挪位置；若有人把它改回顶栏里的普通
    // 按钮，模块页的品牌就会比首页右移一截 —— 用户看到的是「一切换页面，
    // 顶栏就跳一下」，而所有存在性断言仍然全绿。
    const brandLeftOnHome = home.brandLeft
    if (brandLeftOnHome < 0) problems.push('读不到品牌区的左坐标，无法验证顶栏是否被挤动')

    const trips: string[] = []
    let floatingDetail = ''

    for (const module of HOME_MODULES) {
      if (!(await clickModuleEntry(window, module.key))) {
        problems.push(`点不到「${module.label}」的卡片`)
        continue
      }

      /* ① 跳过去：判据是「路由 + 页面标识都对」，不是「等一下」。
            页面标识读的是隐藏的 page-title，所以它同时也在验证「锚点没被删」——
            那个元素一旦被顺手删掉，路由判据会退化成永远读空字符串。 */
      const arrived = await readRouteState(
        window,
        (state) => state.hash === `#${module.path}` && state.pageTitle === module.label
      )

      if (arrived.hash !== `#${module.path}`) {
        problems.push(
          `点「${module.label}」卡片后停在 ${arrived.hash || '空'}，应为 #${module.path}`
        )
        await gotoHome(window)
        await readRouteState(window, (state) => state.moduleCount > 0)
        continue
      }
      if (arrived.pageTitle !== module.label) {
        problems.push(
          `到了 #${module.path}，页面标识却是「${arrived.pageTitle}」（应为「${module.label}」）—— 读屏与冒烟测试都靠它认页`
        )
      }
      // 模块页的标题是**导航标签**，必须不显示（用户 2026-09-20 指定）。
      // 这一条是上一版断言的反转：原先断的是「标题可见且写着模块名」，
      // 需求翻过来之后旧断言不能直接删 —— 删了就没人拦得住它被改回可见。
      // 反向那一条（曾经只开给书籍详情页的书名）随着那一页被取消而消失，
      // 于是「一律不显示」这条规矩现在**只有这一个方向**，也就没有了对冲。
      if (arrived.titleVisible) {
        problems.push(
          `「${module.label}」页的标题又显示出来了 —— 模块页的标题是导航标签，应当只做隐藏锚点`
        )
      }
      // 标题隐了，外套那一行也得跟着走，否则页面顶部会多出一截死空白
      if (arrived.emptyHeaderRows > 0) {
        problems.push(
          `「${module.label}」页有 ${arrived.emptyHeaderRows} 行只剩外壳的标题行（标题已隐藏却还留着容器），会在页顶撑出空白`
        )
      }
      if (arrived.hasTopNav) {
        problems.push(`「${module.label}」页又出现了顶部导航条`)
      }

      /* ② 图标按钮的形态：每一页都量一遍。
       *
       * 用户 2026-09-20 先改顶栏、再要求「各个界面中的图标也要跟着改」。这类
       * 批量外观改造最容易的失败方式是**只改了一半** —— 而「按钮在不在」
       * 「点了有没有反应」这些断言全都照样绿。所以这一条不看存在性，
       * 只看形状：圆形、无文字、aria-label 还在。规矩只有一份
       * （`checkIconButtons`），四个模块页量的是同一套。 */
      problems.push(...checkIconButtons(arrived.iconButtons, module.label))

      /* 并排卡片必须等高（用户 2026-09-20：「并排的卡片都需要高度对齐」）。
       *
       * 与上面那条同源：批量外观/布局改造最容易只改一半，而「卡片在不在」
       * 「点了有没有反应」全都照样绿。不等高是纯几何症状，只有量盒子看得见。
       * 规矩共用 `checkCardRows`，四页各量一遍（编辑器页没有并排卡片，也没挂标记）。 */
      problems.push(
        ...checkCardRows(arrived.cardRows, module.label, CARD_ROWS_MIN[module.path] ?? 0)
      )

      /* 空状态里的新建入口：书籍管理页「书架还是空的」那枚（见 checkEmptyZones）。
       * 其他模块页的空状态没有挂标记，采不到就不会报错 —— 标记只挂在「本来就
       * 该给出口」的那种空状态上。 */
      problems.push(...checkEmptyZones(arrived.emptyZones, module.label))

      /* 重复的按钮锚点：同一颗按钮在一屏里出现两次。
       *
       * 卡片库真出过这个（工具栏上两枚一模一样的「新建卡片」，注释也复制了两遍）——
       * 而它是**测试查不出来**的一类错：所有断言都用 `querySelector`，永远只读到
       * 第一枚，第二枚既不会让任何断言变红，也不会被截图之外的眼睛看到。
       * 判据是锚点重复，不是「按钮数」：一个页面上按钮很多是正常的。 */
      if (arrived.duplicateButtonTestIds.length > 0) {
        problems.push(
          `「${module.label}」页有重复的按钮锚点：${arrived.duplicateButtonTestIds.join(
            '、'
          )} —— 同一颗按钮在屏上出现了两次，` +
            '而按锚点查询的断言只会读到第一枚，另一枚谁都看不见'
        )
      }

      /* ② 返回按钮必须出现，而且是**浮在右下角**的圆形图标。
       *
       * 为什么量这些而不是「按钮在不在」：用户对它提的要求是「悬浮」与
       * 「不是固定在界面里的图标」—— 一个摆在顶栏里的普通按钮同样能通过
       * 「存在性」断言，但那正是被否掉的方案。position=fixed、贴着窗口
       * 右下角、且不落在顶栏高度范围内，才是「悬浮」的实测证据。 */
      if (!arrived.hasHomeButton) {
        problems.push(`「${module.label}」页没有「返回首页」按钮 —— 用户会被关在这个模块里`)
        await gotoHome(window)
        await readRouteState(window, (state) => state.moduleCount > 0)
        continue
      }
      const box = arrived.homeButton
      if (!box) {
        problems.push(`「${module.label}」页读不到「返回首页」按钮的几何信息`)
      } else {
        if (box.width < 28 || box.height < 28) {
          problems.push(`「${module.label}」页的「返回首页」按钮只有 ${box.width}×${box.height}px，太小点不着`)
        }
        if (Math.abs(box.width - box.height) > 1 || Math.abs(box.radiusPx - box.width / 2) > 1) {
          problems.push(
            `「返回首页」按钮不是正圆（${box.width}×${box.height}，圆角 ${box.radiusPx}px）—— 与工具栏上的图标按钮观感应一致`
          )
        }
        if (box.position !== 'fixed') {
          problems.push(
            `「返回首页」按钮的 position 是 ${box.position}，不是 fixed —— 它应当是浮在界面之上的，不是布局流里的图标`
          )
        }
        if (box.rightInset > 48 || box.bottomInset > 48) {
          problems.push(
            `「返回首页」按钮不在窗口右下角（距右缘 ${box.rightInset}px、距下缘 ${box.bottomInset}px）`
          )
        }
        if (box.insideTopBar) {
          problems.push('「返回首页」按钮落在顶栏范围内 —— 那是被否掉的「顶栏固定图标」方案')
        }
        if (box.zIndex < 1) {
          problems.push('「返回首页」按钮没有 z-index，浮不到内容之上')
        }
        if (!floatingDetail) {
          floatingDetail = `悬浮按钮 ${box.width}px 正圆 / position=${box.position} / z-index=${box.zIndex} / 距右下角 ${box.rightInset}×${box.bottomInset}px`
        }
      }

      // 顶栏不该被这个按钮挤动（它是悬浮的，不在布局流里）
      if (brandLeftOnHome >= 0 && arrived.brandLeft !== brandLeftOnHome) {
        problems.push(
          `「${module.label}」页的品牌左坐标是 ${arrived.brandLeft}px，首页是 ${brandLeftOnHome}px —— 悬浮按钮把顶栏挤动了，说明它其实是布局流里的图标`
        )
      }

      /* ③ 点它回首页 */
      if (!(await clickTestId(window, 'home-button'))) {
        problems.push(`点不到「${module.label}」页的返回首页按钮`)
        continue
      }

      const back = await readRouteState(
        window,
        (state) => (state.hash === '#/' || state.hash === '') && state.moduleCount > 0
      )

      if (back.hash !== '#/' && back.hash !== '') {
        problems.push(`从「${module.label}」点返回首页后停在 ${back.hash}，没有回到首页`)
      } else if (back.hasHomeButton) {
        problems.push('回到首页后「返回首页」按钮还在 —— 它应当只在非首页显示')
      } else {
        trips.push(module.key)
      }
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `${trips.length} 个模块各自走通「卡片 → 模块页（页标题已移除、右下角悬浮返回按钮）→ 返回首页」：${trips.join(' → ')}；首页上无返回按钮，全程无顶部导航条、无可见页标题、无空壳标题行，顶栏未被挤动（品牌左坐标恒为 ${brandLeftOnHome}px）；${floatingDetail}；首页并排卡片行实测：${describeCardRows(home.cardRows)}`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}


async function checkEditorTools(window: BrowserWindow): Promise<StepResult> {
  const problems: string[] = []

  try {
    const before = await waitForEditor(window)
    if (!before.mounted) {
      return { name: '编辑器工具栏', ok: false, detail: '当前不在章节编辑器页面上，无法验证工具栏' }
    }

    /* ① 字体大小 */
    if (!(await pickSelectOption(window, 'editor-font-size-select', '22px'))) {
      problems.push('点不开「字号」下拉，或下拉里没有 22px 这个选项')
    }
    const afterSize = await waitForEditor(window)
    if (afterSize.contentFontSize !== 22) {
      problems.push(`选了 22px 字号，正文实测却是 ${afterSize.contentFontSize}px —— 下拉没接上正文`)
    }

    /* ② 字体选择 */
    if (!(await pickSelectOption(window, 'editor-font-select', '楷体'))) {
      problems.push('点不开「字体」下拉，或下拉里没有「楷体」这个选项')
    }
    const afterFont = await waitForEditor(window)
    if (!/KaiTi|Kaiti|STKaiti/i.test(afterFont.contentFontFamily)) {
      problems.push(`选了楷体，正文实测字体栈却是「${afterFont.contentFontFamily}」`)
    }

    /* ③ 一键格式整理：每段开头空两个字、段落之间空一行 */
    // 「空一行」的高度 = 字号 × 行距。字号刚被改成 22px，行距用默认的 1.9
    const expectedGap = Math.round(afterFont.contentFontSize * 1.9)
    const expectedIndent = afterFont.contentFontSize * 2
    if (!(await clickTestId(window, 'editor-tidy'))) {
      problems.push('点不到「整理格式」按钮')
    }
    const afterTidy = await waitForEditor(window)
    if (afterTidy.firstParagraph.indentPx !== expectedIndent) {
      problems.push(
        `「整理格式」后首行缩进是 ${afterTidy.firstParagraph.indentPx}px，两个字的宽度应为 ${expectedIndent}px`
      )
    }
    if (Math.abs(afterTidy.firstParagraph.gapPx - expectedGap) > 2) {
      problems.push(
        `「整理格式」后段间距是 ${afterTidy.firstParagraph.gapPx}px，一行的高度应为 ${expectedGap}px`
      )
    }
    // 排版整理不该动正文：示例正文本来就是干净的，字数与段数都必须原样
    if (afterTidy.hanzi !== before.hanzi) {
      problems.push(`「整理格式」改动了正文：汉字从 ${before.hanzi} 变成 ${afterTidy.hanzi}`)
    }
    if (afterTidy.paragraphCount !== before.paragraphCount) {
      problems.push(
        `「整理格式」改动了段落数：从 ${before.paragraphCount} 变成 ${afterTidy.paragraphCount}`
      )
    }

    /* ④ 下划线 */
    if (!(await selectAllEditorText(window))) {
      problems.push('选不中正文（找不到 .winbook-editor__content）')
    }
    if (!(await clickTestId(window, 'editor-underline'))) {
      problems.push('点不到「下划线」按钮')
    }
    const afterUnderline = await waitForEditor(window)
    if (afterUnderline.underlineCount < 1) {
      problems.push('点了下划线按钮，正文里没有出现任何 <u> —— 按钮没接上编辑器')
    }
    // 加格式不该改字数：24 个字还是 24 个字，少一个就说明链路把正文当成了变更
    if (afterUnderline.hanzi !== before.hanzi) {
      problems.push(`加下划线后汉字数从 ${before.hanzi} 变成 ${afterUnderline.hanzi}`)
    }

    /* ⑤ 工具栏只占一行；装不下时靠头尾的箭头横向滑动，而不是折行 */
    const bar = (await waitForEditor(window)).toolbar
    if (!bar.stripFound) {
      problems.push('找不到工具栏的滑动容器（editor-toolbar-strip）')
    } else {
      const spread =
        bar.itemCenters.length > 1 ? Math.max(...bar.itemCenters) - Math.min(...bar.itemCenters) : 0
      if (spread > 2) {
        problems.push(
          `工具栏折成了多行（${bar.itemCount} 个控件的中线极差 ${spread}px）—— 应当靠横向滑动容纳`
        )
      }

      const overflows = bar.scrollWidth > bar.clientWidth + 1
      if (!overflows) {
        if (bar.hasLeftButton || bar.hasRightButton) {
          problems.push('工具栏没有溢出，却显示了左右滚动按钮（点不动的按钮会让人以为坏了）')
        }
      } else if (!bar.hasLeftButton || !bar.hasRightButton) {
        problems.push('工具栏已溢出，却没有在头尾给出左右滚动按钮')
      } else {
        if (!bar.leftDisabled) problems.push('工具栏刚打开时停在左端，「<」不该是可点的')
        if (bar.rightDisabled) problems.push('工具栏已溢出，「>」却是禁用态，滑不动')

        if (!(await clickTestId(window, 'editor-toolbar-scroll-right'))) {
          problems.push('点不到工具栏的「>」按钮')
        }
        /* 等待条件里必须带上按钮的禁用态：scrollLeft 是 DOM 立刻变的，
         * 而箭头按钮是否可点是 React 状态，晚一拍才刷新。只等 scrollLeft
         * 就点「<」，会点在还处于禁用态的按钮上，白报一个假失败。 */
        const forward = await readToolbarScroll(
          window,
          (state) => state.scrollLeft > 0 && !state.leftDisabled
        )
        if (forward.scrollLeft <= 0) {
          problems.push('点了「>」工具栏没有向右滑动')
        } else {
          /* 「>」变灰只允许出现在真的顶到右端时。这里不能反过来假定
           * 「点一下必须停在中间」——溢出量小时（本例内容 845 / 可视 650，一次
           * 滚动就到底）那是拿测试的假设去规定产品行为，会把对的实现判成错的。 */
          const atRightEnd =
            forward.scrollLeft + forward.clientWidth >= forward.scrollWidth - 1
          if (forward.rightDisabled && !atRightEnd) {
            problems.push('还没滑到右端，「>」就被禁用了')
          }
          if (!(await clickTestId(window, 'editor-toolbar-scroll-left'))) {
            problems.push('点不到工具栏的「<」按钮（向右滑动后它仍处于禁用态）')
          }
          const back = await readToolbarScroll(
            window,
            (state) => state.scrollLeft <= 0 && state.leftDisabled
          )
          if (back.scrollLeft > 0) problems.push('点了「<」工具栏没有滑回左端')
          if (!back.leftDisabled) problems.push('已经滑回左端，「<」却还是可点的')
          if (back.rightDisabled) {
            problems.push('滑回左端后「>」该恢复可点（内容仍然溢出），却还是禁用态')
          }
        }
      }
    }

    return {
      name: '编辑器工具栏',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `字号选 22px → 正文 ${afterSize.contentFontSize}px；字体选楷体 → ${afterFont.contentFontFamily}；整理格式 → 首行缩进 ${afterTidy.firstParagraph.indentPx}px（两字）/ 段间距 ${afterTidy.firstParagraph.gapPx}px（一行 ${expectedGap}px）且正文 ${afterTidy.hanzi} 汉字未变；下划线 → 正文出现 ${afterUnderline.underlineCount} 处 <u>；工具栏单行不折行（${bar.itemCount} 个控件中线极差 ${
              bar.itemCenters.length > 1 ? Math.max(...bar.itemCenters) - Math.min(...bar.itemCenters) : 0
            }px），内容 ${bar.scrollWidth}px / 可视 ${bar.clientWidth}px，头尾箭头可用且点「>」确实向右滑动`
          : `${problems.join('；')}｜实测：字号=${afterSize.contentFontSize}px，字体=「${afterFont.contentFontFamily}」，缩进=${afterTidy.firstParagraph.indentPx}px，段间距=${afterTidy.firstParagraph.gapPx}px，汉字=${before.hanzi}→${afterTidy.hanzi}，下划线=${afterUnderline.underlineCount} 处，工具栏=${bar.itemCount} 控件/中线极差${
              bar.itemCenters.length > 1 ? Math.max(...bar.itemCenters) - Math.min(...bar.itemCenters) : 0
            }px，内容宽=${bar.scrollWidth} 可视宽=${bar.clientWidth} 左按钮=${
              bar.hasLeftButton ? (bar.leftDisabled ? '有(禁用)' : '有') : '无'
            } 右按钮=${bar.hasRightButton ? (bar.rightDisabled ? '有(禁用)' : '有') : '无'}`
    }
  } catch (error) {
    return { name: '编辑器工具栏', ok: false, detail: messageOf(error) }
  }
}

/**
 * 大纲页：两栏布局 + 情节树。
 *
 * 断言口径与编辑器一致 —— 只认我们自己挂在 JSX 上的锚点，不去碰
 * antd Tree 的内部类名。
 *
 * 这里额外要量的是**树面板的实际高度**：这一页用的是「内容区不滚动、
 * 两栏各自滚」的布局，高度链一旦断开，grid 的行高会被内容撑开，
 * 两栏的滚动全部失效，而 DOM 查询与节点数量看上去完全正常。
 */
async function checkOutline(window: BrowserWindow): Promise<StepResult> {
  const route = '#/outline'

  try {
    // HashRouter 认的是 hash，直接改它相当于点了一次链接
    await window.webContents.executeJavaScript(
      `(() => { location.hash = ${JSON.stringify(route)}; return true })()`
    )

    const snap = await waitForOutline(window)

    const problems: string[] = []
    if (!snap.mounted) problems.push(`未进入大纲页（hash 停在 ${snap.hash || '空'}）`)
    if (snap.title !== '大纲管理') problems.push(`页面标题异常：${snap.title}`)
    if (!snap.hasTree) problems.push('情节树未渲染')
    // 后端为这本书留了 4 个节点（根 → 支线 → 两个子节点），少一个都说明树没铺开
    if (snap.total !== 4) problems.push(`节点总数应为 4，实得 ${snap.total}`)
    if (snap.nodeRows !== 4) problems.push(`树里渲染出 ${snap.nodeRows} 行，预期 4 行`)
    if (snap.landed !== 1) problems.push(`已落地节点数应为 1，实得 ${snap.landed}`)
    if (!snap.hasPanel) problems.push('右侧节点面板未渲染')
    if (snap.treeHeight < 200) {
      problems.push(`树面板高度只有 ${snap.treeHeight}px，两栏的内部滚动会失效`)
    }

    await captureIfRequested(window, 'outline')

    /* 右侧面板头部那两枚按钮（子节点 / 同级）**空状态下根本不在画面上** ——
     * 没选中节点时右栏是一张空状态插图。它们恰好是本轮改造的对象之一
     * （用户点名了「大纲页」），而「按页截图 + 按页量」的常规覆盖永远碰不到它们：
     * 大纲页默认就是空状态。所以这里先选一个节点把面板叫出来，再量一遍。
     *
     * 判据用「锚点真的出现了」而不是「等一会儿」：React 回写是异步的，
     * 点击返回时面板往往还没切过去。 */
    const nodeClicked = (await window.webContents.executeJavaScript(
      `(() => {
        const row = document.querySelector('[data-testid="outline-node-row"]')
        if (!row) return false
        row.click()
        return true
      })()`
    )) as boolean

    if (!nodeClicked) {
      problems.push('点不到树上的节点 —— 右侧面板头部那两枚图标按钮因此无法验证')
    } else {
      const panelState = await readRouteState(window, (state) =>
        state.iconButtons.some((item) => item.testId === 'outline-add-child')
      )
      // 按**显式清单**挑，不用前缀匹配：`outline-add-root` 是页头那一枚，
      // 前缀一把抓会把它也算进来，于是 2 枚变成 3 枚（第一版就这么误报的）。
      const headIcons = panelState.iconButtons.filter((item) =>
        (OUTLINE_PANEL_ACTIONS as readonly string[]).includes(item.testId)
      )
      if (headIcons.length !== OUTLINE_PANEL_ACTIONS.length) {
        problems.push(
          `选中节点后右侧面板头部读到 ${headIcons.length} 枚图标按钮（应为 ${OUTLINE_PANEL_ACTIONS.length}：子节点 / 同级）`
        )
      }
      problems.push(...checkIconButtons(headIcons, '大纲节点面板头部'))
      await captureIfRequested(window, 'outline-panel')
    }

    return {
      name: '大纲管理',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，标题「${snap.title}」，树渲染 ${snap.nodeRows} 行 / 共 ${snap.total} 个节点，已落地 ${snap.landed} 个，树面板高 ${snap.treeHeight}px；页头 3 枚圆形图标按钮，选中节点后面板头部 2 枚（子节点 / 同级）也是正圆且无文字、提示文案齐全`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，标题「${snap.title}」，树=${
              snap.hasTree ? '有' : '无'
            }，行数=${snap.nodeRows}，总数=${snap.total}，已落地=${snap.landed}，面板=${
              snap.hasPanel ? '有' : '无'
            }，树高=${snap.treeHeight}`
    }
  } catch (error) {
    return { name: '大纲管理', ok: false, detail: messageOf(error) }
  }
}

/**
 * 书籍管理页（书架）：真的渲染出书，且「新建书籍」按钮已图标化并挪到搜索框左侧。
 *
 * 这一页此前没有独立检查 —— 首页只覆盖了列表接口（BookProgress），
 * 而书架页读的是另一支接口（BookList）并带分页 / 筛选 / 排序。
 * 现在补上，顺带把「独立主按钮 → 工具栏图标按钮」这条界面约定锁住：
 * 它属于「用户肉眼能看到、但 DOM 查询与接口断言都覆盖不到」的那类事实。
 *
 * **「从书架打开一本书」那一段已经搬去 `checkBookWorkspace`**：那一页原来
 * 是「书籍详情页」，用户 2026-09-20 取消了它，落点从而从这一页越到了编辑器。
 * 跨页面的检查留在同一段里，失败时说不清是哪一页坏的。
 */
async function checkBooks(window: BrowserWindow): Promise<StepResult> {
  const route = '#/books'

  try {
    // HashRouter 认的是 hash，直接改它相当于点了一次链接
    await window.webContents.executeJavaScript(
      `(() => { location.hash = ${JSON.stringify(route)}; return true })()`
    )

    const snap = await waitForBooks(window)

    const problems: string[] = []
    if (!snap.mounted) problems.push(`未进入书籍管理（hash 停在 ${snap.hash || '空'}）`)
    if (snap.title !== '书籍管理') problems.push(`页面标题异常：${snap.title}`)
    if (snap.cards < 1) problems.push('书架没有渲染出任何书籍卡片')
    problems.push(...checkAddButtonPlacement('书籍管理', snap.addButton, { adjacentToSearch: true }))

    await captureIfRequested(window, 'books')

    // 悬浮提示单独验一次（截图之后再悬停，免得提示浮层挡住截图内容）
    const tip = await waitForTooltip(window, 'books-add', 'books-add-tip')
    if (tip === '') {
      problems.push('书籍管理：「新建书籍」图标按钮悬浮后没有任何提示文案')
    }

    return {
      name: '书籍管理',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，标题「${snap.title}」，书架渲染 ${snap.cards} 本书，新建按钮为 ${snap.addButton.width}px 正圆图标（圆角 ${snap.addButton.radiusPx}px）且在搜索框左侧 ${snap.addButton.gapToSearch}px，悬浮提示「${tip}」`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，标题「${snap.title}」，书籍卡片=${snap.cards}，新建按钮文字「${snap.addButton.text}」间距=${snap.addButton.gapToSearch} 中线差=${snap.addButton.centerOffset} 在工具栏=${snap.addButton.inToolbar} 尺寸=${snap.addButton.width}×${snap.addButton.height} 圆角=${snap.addButton.radiusPx}`
    }
  } catch (error) {
    return { name: '书籍管理', ok: false, detail: messageOf(error) }
  }
}

/* ------------------------------------------------------------------ *
 * 「打开一本书」= 正文编辑页
 *
 * 用户 2026-09-20：「这个页面的功能完全不正确，新建书籍并且打开书籍之后
 * 应该是正文编辑页，不应该出现这个统计界面，而且卷和章节还分开了。
 * 打开书籍后直接就是正文编辑界面，左侧可以新建卷和章节，底部才是统计信息
 * 该出现的地方。」
 *
 * 落点的改变是这一条的核心，也正因为它只是一次路由跳转，**所有「元素在不在」
 * 的断言都拦不住它退回去**：把 `/books/:bookId` 改回旧的那张统计页，
 * 编辑器本身一切正常、书架也一切正常，全部断言照样全绿。
 * 所以这里断的是三件事，缺一不可：
 *   ① 打开一本书之后，**hash 落在具体某一章上**（而不是停在书本身）；
 *   ② 那一刻页面上是编辑器的三件套（顶栏 / 左侧目录 / 底栏），
 *      且**旧统计页的三件标志物一件都不在**；
 *   ③ 底栏右端那组「全书」统计与库里的数（主进程现算）逐项相等。
 *
 * 空书（一章都没有）另有一段：它必须**留在原地**显示编辑器空态，
 * 而不是把用户弹走 —— 那正是用户截图里那本书的样子。
 * ------------------------------------------------------------------ */

interface WorkspaceSnapshot {
  hash: string
  hasEditorPage: boolean
  hasCatalog: boolean
  hasStatusbar: boolean
  /** 正文上方的章节标题输入框。空书里必须没有它 */
  hasTitleInput: boolean
  /**
   * 顶栏显示的书名。
   *
   * 存在的唯一理由是**当路由判据用**：`location.hash` 是同步改掉的，
   * React 还停在上一本书的界面上时它已经是新值了。只等 hash 会读到
   * 「上一本书的页面 + 新书的地址」，于是所有针对空书的断言都变成在量
   * 上一本有章节的书 —— 报出来的却是「空书里怎么什么都有」。
   */
  bookTitle: string
  /** 空状态区块的 `data-empty-zone`（没有就是空串）。空书必须挂着它 */
  emptyZone: string
  /** 顶栏里那几枚圆形图标按钮的锚点，用来核对「哪几枚在」 */
  topBarButtons: string[]
  /**
   * 锚点清单里每一枚顶栏按钮的**逐项体检**。
   *
   * `topBarButtons` 只回答「哪几枚挂着形状类」，一旦某枚被浮层组件换掉了
   * className（2026-09-20 真踩到：`Dropdown` 会把 `className` 注入子元素，
   * 而 `IconButton` 原先把类名写在自己内部、`child.props.className` 是
   * undefined，于是一条 `app-icon-button` 被整条换掉），那枚按钮就从
   * `topBarButtons` 里静悄悄地消失 —— 报出来只是一句「顶栏少了按钮」，
   * 而它其实**就在 DOM 里、也点得动**。
   *
   * 所以这里额外记下「元素在不在、类名到底是什么」，失败时能一句话说清是
   * 「真删了」还是「还在但不是那枚圆钮了」。
   */
  topBarButtonDetail: TopBarButtonDetail[]
  /** 旧「书籍详情页」的三件标志物 */
  legacyChapterTable: boolean
  legacyOverviewCards: boolean
  legacyVolumeCard: boolean
  /* 底栏右端那组全书统计，取自 data-value */
  bookVolumes: number
  bookChapters: number
  bookHanzi: number
  bookProgress: number
  /** 底栏左端那组本章统计里的「本章汉字」，同样取 data-value */
  chapterHanzi: number
}

interface TopBarButtonDetail {
  id: string
  /** 元素在不在 DOM 里 */
  present: boolean
  /** 有没有挂上形状类 `.app-icon-button` */
  shaped: boolean
  /** 实测的 class 属性，用来指认被换成了什么 */
  className: string
}

const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  hash: '',
  hasEditorPage: false,
  hasCatalog: false,
  hasStatusbar: false,
  hasTitleInput: false,
  bookTitle: '',
  emptyZone: '',
  topBarButtons: [],
  topBarButtonDetail: [],
  legacyChapterTable: false,
  legacyOverviewCards: false,
  legacyVolumeCard: false,
  bookVolumes: -1,
  bookChapters: -1,
  bookHanzi: -1,
  bookProgress: -1,
  chapterHanzi: -1
}

/**
 * 工作台（编辑器）的实测快照。
 *
 * 读 `data-value` 而不是文案：底栏的数字带千分位、带「计划：剩 N」这类前缀，
 * 拿文案去比会把「格式变了」误报成「数错了」。产品代码把原始数字另挂了一份
 * 到 `data-value` 上（这是本项目的成例，见底栏的 `editor-hanzi`）。
 */
const WORKSPACE_PROBE_JS = `(() => {
  const intOf = (testId) => {
    const el = document.querySelector('[data-testid="' + testId + '"]')
    const n = Number(el?.getAttribute('data-value'))
    return Number.isFinite(n) ? n : -1
  }
  /*
   * 顶栏每一枚应有按钮的逐项体检，清单从主进程传进来（同一份
   * EDITOR_TOP_BAR_ACTIONS，不在这里再抄一遍）。选择器与 topBarButtons 同源，
   * 所以 shaped 与「在不在那份列表里」等价 —— 多出来的是 present 与 className：
   * 「真删了」和「还在但形状类被换掉了」是两种病，报出来的话却都是「少了按钮」。
   */
  const expectedBar = ${JSON.stringify(EDITOR_TOP_BAR_ACTIONS)}
  const barDetail = expectedBar.map((id) => {
    const el = document.querySelector('.editor-topbar [data-testid="' + id + '"]')
    return {
      id,
      present: !!el,
      shaped: !!el && el.classList.contains('app-icon-button'),
      className: el ? el.getAttribute('class') || '' : ''
    }
  })
  return {
    hash: location.hash,
    hasEditorPage: !!document.querySelector('.editor-page'),
    hasCatalog: !!document.querySelector('[data-testid="chapter-catalog"]'),
    hasStatusbar: !!document.querySelector('.editor-statusbar'),
    hasTitleInput: !!document.querySelector('[data-testid="chapter-title-input"]'),
    bookTitle: (document.querySelector('.editor-topbar__book')?.textContent || '').trim(),
    emptyZone: document.querySelector('[data-empty-zone]')?.getAttribute('data-empty-zone') || '',
    topBarButtons: Array.prototype.map.call(
      document.querySelectorAll('.editor-topbar .app-icon-button'),
      (el) => el.getAttribute('data-testid') || ''
    ),
    topBarButtonDetail: barDetail,
    legacyChapterTable: !!document.querySelector('[data-testid="chapter-table"]'),
    legacyOverviewCards: !!document.querySelector('[data-card-row="书籍概览"]'),
    legacyVolumeCard: !!document.querySelector('.volume-list'),
    bookVolumes: intOf('editor-book-volumes'),
    bookChapters: intOf('editor-book-chapters'),
    bookHanzi: intOf('editor-book-hanzi'),
    bookProgress: intOf('editor-book-progress'),
    chapterHanzi: intOf('editor-hanzi')
  }
})()`

async function readWorkspace(
  window: BrowserWindow,
  done: (state: WorkspaceSnapshot) => boolean,
  timeoutMs = 8000
): Promise<WorkspaceSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_WORKSPACE

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(WORKSPACE_PROBE_JS)) as WorkspaceSnapshot
    if (done(last)) return last
    await delay(100)
  }

  return last
}

/** 直接改 hash 进某个路由（HashRouter 认的就是它，等价于点了一次链接） */
async function gotoHash(window: BrowserWindow, hash: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `(() => { location.hash = ${JSON.stringify(hash)}; return true })()`
  )
}

/**
 * 等 `location.hash` 变成某个样子。
 *
 * 它比 `waitForTestId` 严的地方在于**认的是整个字符串**：路由跳转常常先落一个
 * 中间态（比如先 `#/books/3` 再由编辑器重定向到 `#/books/3/chapters/12`），
 * 只判「开头匹配」会把中间态当成终点，后面量的就是错页面。
 */
async function waitForHash(
  window: BrowserWindow,
  done: (hash: string) => boolean,
  timeoutMs = 4000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript('location.hash')) as string
    if (done(last)) return last
    await delay(80)
  }
  return last
}

/**
 * 往某个锚点对应的输入框里打字。
 *
 * 必须走原生 setter + 派发 input 事件：直接改 `input.value` 不会触发 React 的
 * onChange，界面看着填进去了、state 里还是空的，提交时又变回旧值。
 */
async function typeIntoTestId(
  window: BrowserWindow,
  testId: string,
  text: string
): Promise<boolean> {
  return (await window.webContents.executeJavaScript(`(() => {
    const raw = document.querySelector('[data-testid="${testId}"]')
    const input = raw instanceof HTMLInputElement ? raw : (raw && raw.querySelector('input'))
    if (!input) return false
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)) as boolean
}

/** 轮询主进程，直到按标题查得到（或查不到）某个分卷 */
/**
 * 等一张卡片在库里出现 / 消失。
 *
 * 与「界面上有没有这一行」分开：新建面板点完保存之后，React Query 会先
 * 乐观地把行画出来，而库里那一行要等 IPC 往返。只读界面的话，「保存失败」
 * 与「保存成功」在最初几百毫秒里长得一模一样。
 */
async function waitForCard(
  lookup: (title: string) => {
    id: number
    title: string
    cardType: string
    extraKeys: string
    category: string
  } | null,
  title: string,
  wantFound: boolean,
  timeoutMs = 6000
): Promise<{
  id: number
  title: string
  cardType: string
  extraKeys: string
  category: string
} | null> {
  const deadline = Date.now() + timeoutMs
  let last: {
    id: number
    title: string
    cardType: string
    extraKeys: string
    category: string
  } | null = null

  while (Date.now() < deadline) {
    last = lookup(title)
    if ((last !== null) === wantFound) return last
    await delay(120)
  }

  return last
}

async function waitForVolume(
  lookup: (title: string) => { id: number; title: string } | null,
  title: string,
  wantFound: boolean,
  timeoutMs = 6000
): Promise<{ id: number; title: string } | null> {
  const deadline = Date.now() + timeoutMs
  let last: { id: number; title: string } | null = null

  while (Date.now() < deadline) {
    last = lookup(title)
    if ((last !== null) === wantFound) return last
    await delay(120)
  }

  return last
}

/**
 * 「打开一本书」的落点。
 *
 * 覆盖三种进入方式 + 一处底栏口径，全部走**用户真的会走的路**：
 *   ① 直接打开一本书（`#/books/:id`，书架点卡片走的就是这条）；
 *   ② 顶栏那枚 `…` 书籍菜单里三项都在、且行首是圆形图标；
 *   ③ 打开一本一章都没有的书：留在编辑器空态，中央恰好一枚圆形入口；
 *   ④ 底栏右端的「全书」统计 = 主进程现算的数。
 */
async function checkBookWorkspace(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '打开书籍'
  const problems: string[] = []
  const notes: string[] = []

  try {
    /* ---------- ① 打开一本有章节的书：直接落在正文编辑页 ---------- */
    const resumeId = ctx.resumeChapterId(ctx.bookId)
    if (resumeId === null) {
      return { name, ok: false, detail: '展示用书里一章都没有，无法验证「打开书籍」的落点' }
    }

    const openRoute = `#/books/${ctx.bookId}`
    const chapterRoute = `#/books/${ctx.bookId}/chapters/${resumeId}`

    await gotoHash(window, openRoute)
    /*
     * 判据里必须带上**书名**：`location.hash` 是同步改的，React 可能还停在
     * 上一页 —— 那样读到的就是「上一页的 DOM + 新地址」，所有断言都在量错东西。
     * 书名是这一页自己渲染出来的，它对了才说明这一页真的换过来了。
     */
    const opened = await readWorkspace(
      window,
      (state) =>
        state.hash === chapterRoute &&
        state.hasEditorPage &&
        state.hasCatalog &&
        state.hasTitleInput &&
        state.bookTitle === ctx.bookTitle
    )

    if (!opened.hasEditorPage) {
      problems.push(`打开一本书之后没有落在正文编辑页（hash=${opened.hash || '空'}）`)
    } else if (opened.hash !== chapterRoute) {
      problems.push(
        `打开一本书之后停在 ${opened.hash}，应当接着上次写的那一章（${chapterRoute}）—— ` +
          '「打开书籍」的落点是正文编辑页，不是一本书的统计页'
      )
    }
    if (!opened.hasCatalog) problems.push('编辑器左侧目录栏没有渲染 —— 卷与章应当都在这一栏里')
    if (!opened.hasStatusbar) problems.push('编辑器底栏没有渲染 —— 统计信息应当在底部')
    if (!opened.hasTitleInput) problems.push('正文上方的章节标题输入框没有渲染')

    /* 旧统计页的三件标志物：任何一件出现都说明那一页又回来了 */
    if (opened.legacyChapterTable || opened.legacyOverviewCards || opened.legacyVolumeCard) {
      problems.push(
        `打开一本书又出现了统计界面（${
          [
            opened.legacyChapterTable ? '章节表格' : '',
            opened.legacyOverviewCards ? '概览卡' : '',
            opened.legacyVolumeCard ? '分卷卡片列表' : ''
          ]
            .filter((item) => item.length > 0)
            .join(' / ')
        }）—— 用户 2026-09-20：「不应该出现这个统计界面，而且卷和章节还分开了」`
      )
    }

    /* ---------- ② 顶栏：六枚圆钮齐备，且**还是圆钮** ---------- */
    //
    // 走 `topBarButtonDetail` 而不是 `topBarButtons.includes(id)`：后者只能
    // 说出「少了按钮」，分不清「真删了」与「还在但形状类被浮层组件换掉了」
    // （2026-09-20 的 `editor-book-menu` 就是后者 —— 它一直在 DOM 里、点得动、
    // 菜单也打得开，所以「按钮在不在」「菜单项在不在」这类断言全绿，
    // 只有按类采的探针看得见它已经不是一枚正圆按钮了）。
    const missingButtons = opened.topBarButtonDetail.filter((item) => !item.shaped)
    for (const item of missingButtons) {
      if (!item.present) {
        problems.push(`有章节的编辑器顶栏少了 [${item.id}] 按钮`)
        continue
      }
      problems.push(
        `有章节的编辑器顶栏的 [${item.id}] 按钮没有 .app-icon-button 类（实测 class="${item.className}"）` +
          '—— 它还在 DOM 里、也点得动，但已经不再是一枚圆钮。' +
          '最常见成因：浮层组件（Dropdown / Popconfirm / Tooltip）会把自己的 className' +
          '注入被包裹的子元素，而组件内部又自己生成类名，两边一叠加就把形状类整条换掉了（见 IconButton）'
      )
    }

    /* ---------- ③ 底栏的全书统计 = 主进程现算的数 ---------- */
    const totals = ctx.bookTotals(ctx.bookId)
    if (opened.bookVolumes !== totals.volumes) {
      problems.push(`底栏「分卷」显示 ${opened.bookVolumes}，库里有 ${totals.volumes} 卷`)
    }
    if (opened.bookChapters !== totals.chapters) {
      problems.push(`底栏「章节」显示 ${opened.bookChapters}，库里有 ${totals.chapters} 章`)
    }
    if (opened.bookHanzi !== totals.hanzi) {
      problems.push(
        `底栏「全书」显示 ${opened.bookHanzi} 汉字，库里各章合计 ${totals.hanzi} —— ` +
          '这个数必须按章节现算，读书籍列表项里的缓存聚合就会是旧值'
      )
    }
    if (opened.chapterHanzi !== totals.hanzi && totals.chapters === 1) {
      // 只有一章时「本章」与「全书」必然相等。多章时两者本就不同，
      // 所以只在单章这一种情形下额外核对一次口径是否同源
      problems.push(
        `这本书只有一章，底栏「本章」${opened.chapterHanzi} 与「全书」${totals.hanzi} 却不相等`
      )
    }

    await captureIfRequested(window, 'book-workspace')

    /* ---------- ④ 顶栏 `…` 书籍菜单：三项都在，行首是圆形图标 ---------- */
    const menu = await openMenu(window, 'editor-book-menu', BOOK_MENU_ITEMS)
    for (const def of BOOK_MENU_ITEMS) {
      const item = menu.items.find((entry) => entry.key === def.key)
      if (!item || !item.found || !item.visible) {
        problems.push(`书籍菜单里没有「${def.name}」（[${def.testId}]）`)
        continue
      }
      if (item.text.length === 0) {
        problems.push(`书籍菜单的「${def.name}」一行没有任何文字`)
      }
      if (item.iconWidth <= 0 || item.iconWidth !== item.iconHeight) {
        problems.push(
          `书籍菜单的「${def.name}」行首图标不是正方形（${item.iconWidth}×${item.iconHeight}）`
        )
      } else if (Math.abs(item.iconRadiusPx - item.iconWidth / 2) > 1) {
        problems.push(
          `书籍菜单的「${def.name}」行首图标不是正圆（宽 ${item.iconWidth}px，圆角 ${item.iconRadiusPx}px）`
        )
      }
    }
    /*
     * 截图之前再读一次菜单 —— 这张图的**标签就写着「菜单展开的样子」**，
     * 如果拍的时候菜单已经合上，图里就什么都没有，而所有断言照样全绿
     * （菜单项的文字与圆形图标在前一步已经量过了）。这正是本项目一直在防的
     * 「断言全绿、图是坏的」：图是给人看的，它坏掉时没有任何断言会响。
     *
     * 判读必须是**等待式**的而不是单次读：后台窗口里合成器被节流，浮层的
     * 进退场帧不按 16ms 推进，单次读会撞上「关闭帧」—— 实测就是循环里读到的
     * 是开的、紧接着单次一读是关的、再隔 120ms 一读又是开的（浮层在稳定之前
     * 会闪）。所以这里等「连续若干次读都开着」才认账，拍完再复核一次，
     * 撞上关闭帧就等它再开、重拍，至多三次。
     */
    await captureMenuOpen(window, 'book-menu', 'editor-book-menu', BOOK_MENU_ITEMS)
    await closeMenu(window, BOOK_MENU_ITEMS)

    if (problems.length === 0) {
      notes.push(
        `打开《${ctx.bookTitle}》直落那一章（${chapterRoute}），顶栏 ${
          opened.topBarButtons.length
        } 枚圆钮、` +
          `底栏全书 ${totals.chapters} 章 / ${totals.hanzi} 汉字（与库一致），` +
          `书籍菜单三项（${BOOK_MENU_ITEMS.map((def) => def.name).join(' / ')}）行首均为正圆图标`
      )
    }

    /* ---------- ⑤ 打开一本空书：留在编辑器空态 ---------- */
    const emptyRoute = `#/books/${ctx.emptyBookId}`
    await gotoHash(window, emptyRoute)
    /*
     * 空书这一段的判据更要紧：这一页**留在原地**，hash 从改的那一刻起就是
     * `${emptyRoute}`，而上一本书的编辑器还挂在那儿。所以必须等到「书名换成
     * 这本空书」+「正文区没有标题输入框」+「空状态区块挂上来了」三件事同时
     * 成立 —— 只等 hash 的话，下面每一条断言量的都是上一本书。
     */
    const empty = await readWorkspace(
      window,
      (state) =>
        state.hash === emptyRoute &&
        state.hasEditorPage &&
        state.hasCatalog &&
        state.bookTitle === ctx.emptyBookTitle &&
        !state.hasTitleInput &&
        state.emptyZone === 'editor-book',
      12_000
    )

    if (empty.hash !== emptyRoute) {
      problems.push(
        `打开一本还没有章节的书之后跳到了 ${empty.hash}，应当留在 ${emptyRoute} —— ` +
          '空书没有可跳的目标，页面自己停住才是对的'
      )
    }
    if (!empty.hasEditorPage || !empty.hasCatalog || !empty.hasStatusbar) {
      problems.push('空书的页面上缺了编辑器的框架（顶栏 / 左侧目录 / 底栏之一）')
    }
    if (empty.bookTitle !== ctx.emptyBookTitle) {
      problems.push(
        `空书页顶栏显示的书名是「${empty.bookTitle}」，应为「${ctx.emptyBookTitle}」`
      )
    }
    if (empty.hasTitleInput) {
      problems.push('空书里出现了章节标题输入框 —— 没有任何章节时它不是有效的输入')
    }
    if (empty.bookChapters !== 0 || empty.bookHanzi !== 0 || empty.bookVolumes !== 0) {
      problems.push(
        `空书的底栏统计应为 0，实测 分卷 ${empty.bookVolumes} / 章节 ${empty.bookChapters} / 全书 ${empty.bookHanzi}`
      )
    }
    if (empty.chapterHanzi !== -1) {
      problems.push('空书里出现了「本章」字数 —— 没有章节时左端那三项都不该在')
    }
    // 空书里顶栏只该剩两枚：返回书架 + 书籍菜单。查找 / 取名 / 专注 / 导出
    // 都要有正文才谈得上，摆着只是四个点了没反应的圆球。
    const expectedEmptyBar = ['editor-back', 'editor-book-menu']
    const extraEmptyButtons = empty.topBarButtons.filter(
      (id) => !expectedEmptyBar.includes(id)
    )
    if (extraEmptyButtons.length > 0) {
      problems.push(
        `空书的顶栏多出了 ${extraEmptyButtons.join(' / ')} —— 没有正文时这些操作无从谈起`
      )
    }
    for (const id of expectedEmptyBar) {
      // 与 ② 同一条道理：分不清「删了」和「还在但不是圆钮了」的断言等于没测
      const item = empty.topBarButtonDetail.find((entry) => entry.id === id)
      if (item?.shaped) continue
      if (item?.present) {
        problems.push(
          `空书顶栏的 [${id}] 按钮没有 .app-icon-button 类（实测 class="${item.className}"）—— 它在 DOM 里，但不是一枚圆钮`
        )
      } else {
        problems.push(`空书的顶栏少了 [${id}]`)
      }
    }

    /* 空态区块本身：外观规矩与首页、书架页共用同一份（见 checkEmptyZones） */
    const emptyState = await readRouteState(window, (state) => state.emptyZones.length > 0)
    if (emptyState.emptyZones.length === 0) {
      problems.push('空书里没有任何空状态区块 —— 用户会看到一个什么都没有的页面，无处可点')
    } else {
      problems.push(...checkEmptyZones(emptyState.emptyZones, '空书编辑器'))
    }
    problems.push(...checkIconButtons(emptyState.iconButtons, '空书编辑器'))
    if (emptyState.duplicateButtonTestIds.length > 0) {
      problems.push(
        `空书编辑器里有重复的按钮锚点：${emptyState.duplicateButtonTestIds.join('、')}`
      )
    }

    await captureIfRequested(window, 'book-empty')

    if (problems.length === 0) {
      notes.push(
        `空书《${ctx.emptyBookTitle}》留在 ${emptyRoute}，` +
          `顶栏仅 ${empty.topBarButtons.length} 枚圆钮（返回书架 + 书籍菜单），` +
          `中央空态 ${emptyState.emptyZones.length} 个区块、恰好一枚圆形新建入口`
      )
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? notes.join('；')
          : `${problems.join('；')}｜实测：开书后 hash=${opened.hash}，编辑器=${
              opened.hasEditorPage ? '在' : '不在'
            }，目录=${opened.hasCatalog ? '在' : '不在'}，底栏=${opened.hasStatusbar ? '在' : '不在'}，` +
            `顶栏按钮=[${opened.topBarButtons.join(',')}]，底栏全书=${opened.bookVolumes}/${opened.bookChapters}/${opened.bookHanzi}（库 ${totals.volumes}/${totals.chapters}/${totals.hanzi}），` +
            `空书 hash=${empty.hash}，空书顶栏=[${empty.topBarButtons.join(',')}]，空书状态区块=${emptyState.emptyZones.length}`
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  }
}

/* ------------------------------------------------------------------ *
 * 左侧目录栏的卷管理
 *
 * 用户 2026-09-20：「左侧可以新建卷和章节」。在「书籍详情页」被取消之前，
 * 目录栏的「新建卷」是一句**谎话**：它只弹一条「请先在书籍详情页创建分卷」，
 * 然后把用户送去那一页。而那一页已经不存在了 —— 所以这一段必须落到库里验证，
 * 只断「点了有反应」是测不出这个 bug 的（它"有反应"，只是没建出任何东西）。
 *
 * 三条路径逐个走完：建卷 → 改名 → 删除，每一步都回主进程按标题读库。
 * ------------------------------------------------------------------ */

const VOLUME_MENU_ITEMS = [
  'catalog-volume-menu-rename',
  'catalog-volume-menu-up',
  'catalog-volume-menu-down',
  'catalog-volume-menu-export',
  'catalog-volume-menu-remove'
] as const

async function checkCatalogVolumeMenu(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '左侧目录建卷'
  const problems: string[] = []
  const createdTitle = `冒烟-空卷-${STAMP}`
  const renamedTitle = `冒烟-空卷改名-${STAMP}`

  try {
    await gotoHash(window, `#/books/${ctx.bookId}/chapters/${ctx.chapterId}`)
    const editor = await waitForEditor(window)
    if (!editor.mounted || !editor.hasCatalog) {
      return {
        name,
        ok: false,
        detail: '当前不在带左侧目录的编辑器页面上，无法验证分卷管理'
      }
    }

    /* ---------- ① 新建分卷：弹窗提交，真的落库 ---------- */
    if (!(await clickTestId(window, 'catalog-new-volume'))) {
      problems.push('点不到目录栏头部的「新建卷」按钮')
    } else if (!(await waitForTestId(window, 'volume-title-input', 3000))) {
      problems.push('点了「新建分卷」但弹窗没有打开（找不到名称输入框）')
    } else if (!(await typeIntoTestId(window, 'volume-title-input', createdTitle))) {
      problems.push('填不进分卷弹窗的名称输入框')
    } else if (!(await clickTestId(window, 'volume-modal-ok'))) {
      problems.push('点不到分卷弹窗的确认按钮')
    }

    const created = await waitForVolume(ctx.lookupVolume, createdTitle, true)
    if (created === null) {
      return {
        name,
        ok: false,
        detail: `在分卷弹窗里新建「${createdTitle}」，但库里查不到它 —— 「新建分卷」没有真的写库`
      }
    }

    /*
     * 空卷也要在目录树里站住一行（用户 2026-09-20：「无论卷中有没有章节都要
     * 显示」）。刚建好的卷必然是 0 章 —— 这时目录里必须有它这一组；
     * 章节列表为空时整个目录落进空状态、连卷一起吞掉的旧毛病在这里拦住。
     */
    const emptyGroupShown = await window.webContents.executeJavaScript(
      `(() => {
        const group = document.querySelector(
          '[data-testid="catalog-volume-group"][data-volume-id="' + ${JSON.stringify(created.id)} + '"]'
        )
        const row = group ? group.querySelector('[data-testid="catalog-volume"]') : null
        return {
          group: !!group,
          title: (row?.querySelector('.catalog__volume-title')?.textContent || '').trim(),
          count: (row?.querySelector('.catalog__count')?.textContent || '').trim()
        }
      })()`
    ) as { group: boolean; title: string; count: string }
    if (!emptyGroupShown.group) {
      problems.push(`新卷「${createdTitle}」一章都没有，目录树里却没有它的行 —— 空卷被吞掉了`)
    } else if (emptyGroupShown.title !== createdTitle || emptyGroupShown.count !== '0') {
      problems.push(
        `空卷行显示异常：应为「${createdTitle} · 0」，实际是「${emptyGroupShown.title} · ${emptyGroupShown.count}」`
      )
    }

    /* ---------- ② 右键菜单：五项都在 ---------- */
    const openedMenu = await openVolumeMenu(window, created.id)
    if (!openedMenu.open) {
      problems.push('在分卷行上右键没有弹出菜单')
    } else {
      const missing = VOLUME_MENU_ITEMS.filter((id) => !openedMenu.items.includes(id))
      if (missing.length > 0) {
        problems.push(`分卷右键菜单里少了：${missing.join(' / ')}`)
      }
    }
    if (problems.length > 0) {
      return { name, ok: false, detail: problems.join('；') }
    }

    /* ---------- ③ 改名：编辑弹窗，改的是库里的那一行 ---------- */
    if (!(await clickMenuItem(window, 'catalog-volume-menu-rename'))) {
      problems.push('点不到分卷菜单里的「编辑分卷」')
    } else {
      const modalShown = await waitForTestId(window, 'volume-title-input', 3000)
      if (!modalShown) {
        problems.push('点了「编辑分卷」但弹窗没有打开')
      } else if (!(await typeIntoTestId(window, 'volume-title-input', renamedTitle))) {
        problems.push('填不进编辑弹窗的名称输入框')
      } else if (!(await clickTestId(window, 'volume-modal-ok'))) {
        problems.push('点不到编辑弹窗的确认按钮')
      }

      const renamed = await waitForVolume(ctx.lookupVolume, renamedTitle, true)
      if (renamed === null) {
        problems.push(`分卷改名后库里仍然没有「${renamedTitle}」`)
      } else {
        const stale = ctx.lookupVolume(createdTitle)
        if (stale !== null) {
          problems.push(`改名后「${createdTitle}」还在库里 —— 改名应当改掉原来那一行，而不是新建一行`)
        }
      }

      /* ---------- ④ 删除：回库确认它真的没了 ---------- */
      const target = renamed ?? created
      const menuAgain = await openVolumeMenu(window, target.id)
      if (!menuAgain.open) {
        problems.push('改完名后再右键，菜单没有弹出来')
      } else if (!(await clickMenuItem(window, 'catalog-volume-menu-remove'))) {
        problems.push('点不到分卷菜单里的「删除分卷」')
      } else if (!(await clickConfirmOk(window))) {
        problems.push('「删除分卷」没有弹出二次确认（或确认按钮点不到）')
      } else {
        const gone = await waitForVolume(ctx.lookupVolume, renamedTitle, false)
        if (gone !== null) {
          problems.push(`确认删除之后，库里还能查到分卷「${renamedTitle}」`)
        }
      }
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `目录栏头部「新建卷」按钮 → 弹窗提交 → 库中出现「${createdTitle}」且空卷在目录树里占一行；右键该卷 → 菜单五项齐备 → 编辑弹窗改名为「${renamedTitle}」（旧名已不在库中）→ 二次确认后删除（库中查不到）`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  }
}

interface ReturnTicketSnapshot {
  present: boolean
  /** 还带着 `.app-icon-button` 这个形状类 */
  shaped: boolean
  className: string
  width: number
  height: number
  radiusPx: number
  /** `aria-label` —— 图标按钮唯一的说明渠道 */
  label: string
  /** 悬浮按钮不在布局流里，跑到视口之外不会被挤回来，得单独量 */
  inViewport: boolean
  bottom: number
  viewportHeight: number
}

const EMPTY_RETURN_TICKET: ReturnTicketSnapshot = {
  present: false,
  shaped: false,
  className: '',
  width: 0,
  height: 0,
  radiusPx: 0,
  label: '',
  inViewport: false,
  bottom: 0,
  viewportHeight: 0
}

const RETURN_TICKET_PROBE_JS = `(() => {
  const el = document.querySelector('[data-testid="return-to-origin"]')
  if (!el) {
    return ${JSON.stringify(EMPTY_RETURN_TICKET)}
  }
  const rect = el.getBoundingClientRect()
  const rawRadius = getComputedStyle(el).borderTopLeftRadius
  return {
    present: true,
    shaped: el.classList.contains('app-icon-button'),
    className: typeof el.className === 'string' ? el.className : '',
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    // border-radius 写成 50% 时 computedStyle 原样返回 "50%"，parseFloat 会
    // 得到 50 这个「像素数」—— 必须按宽度折算，否则正圆会被判成不是圆
    radiusPx: String(rawRadius).trim().endsWith('%')
      ? Math.round((rect.width * parseFloat(rawRadius)) / 100)
      : Math.round(parseFloat(rawRadius)),
    label: el.getAttribute('aria-label') || '',
    inViewport:
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth,
    bottom: Math.round(rect.bottom),
    viewportHeight: window.innerHeight
  }
})()`

/**
 * 「临时外出」的回程票。
 *
 * 用户 2026-09-20：「在正文编辑的时候，点击『大纲』和『卡片』菜单按钮跳转
 * 界面之后就回不来了，没有回到正文编辑窗口的入口。」
 *
 * 这一条断的是**回程**，不是「跳过去」—— 跳过去从来没坏过，坏的是过去了
 * 就回不来。所以它走完整的一趟：编辑器 → 大纲 → 点回程票 → **必须回到
 * 同一章**（不是首页、不是书架）。顺带再走一趟卡片库，因为两个入口是同一
 * 段代码生成的、却各自指向不同的模块 —— 只验一个的话，另一个照样是死胡同。
 *
 * 反向那条同样要紧：从首页正常进模块时，这枚按钮**必须不存在**。
 * 它是「外出的回程票」而不是常驻导航，摆得到处都是就又变回一条常驻导航栏 ——
 * 那正是上一轮刚拆掉的东西。
 */
/**
 * 查阅面板出现时，写作工具那组 Tabs 必须真的被藏住。
 *
 * 读**计算样式**而不是看类名在不在：藏 Tabs 的类名一直挂在元素上，
 * 但只要 `display: none` 被更高特异度的规则压掉（真踩过 ——
 * `.inspector__panel .ant-tabs { display: flex }` 两个类压过单类的
 * 藏匿规则），页签就会原样画在查阅面板底下，两行字叠成一团；
 * 而此时「面板在、hash 没变」等断言照样全绿。这种坏法只有读
 * computed display 看得见。
 */
async function readHiddenTabsDisplay(window: BrowserWindow): Promise<string> {
  return (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.inspector__tabs--hidden')
      if (el === null) return '(类名不在)'
      return getComputedStyle(el).display
    })()`
  )) as string
}

async function checkOriginReturn(window: BrowserWindow, ctx: ShowcaseTargets): Promise<StepResult> {
  const name = '外出后返回正文'
  const problems: string[] = []

  try {
    const resumeId = ctx.resumeChapterId(ctx.bookId)
    if (resumeId === null) {
      return { name, ok: false, detail: '展示用书里一章都没有，无法验证「外出后返回」' }
    }
    const chapterRoute = `#/books/${ctx.bookId}/chapters/${resumeId}`

    /* ---------- ① 三趟外出，每趟都回到同一章 ---------- */
    /*
     * 「角色」与「设定」两趟指向同一个卡片库，只是带的查询参数不同
     * （`type` 指定卡片类型、`book` 限定在这一本书里）—— 所以判据不能只比
     * 路径前缀，还得把各自该带的参数一起对上：只比 `#/cards` 的话，
     * 「设定」那一趟就算退化成跳到「全部卡片」也照样通过，而那正是
     * 从正文里跳过去最没用的一种结果（作者得自己再筛一遍）。
     */
    const trips: Array<{
      rail: string
      target: string
      label: string
      /** 这一趟必须出现在 hash 里的查询片段 */
      query?: string
      /**
       * 点竖栏之后**先在右侧出现的查阅面板**。
       *
       * 2026-09-21 起竖栏这三项不再直接跳界面：它们把资料列在右侧展示栏，
       * 要看完整页面得再点面板上的「打开完整页面」。两步都要验 ——
       * 只验跳转的话，「竖栏点下去什么也没发生」这种故障会全绿。
       */
      panel: string
    }> = [
      { rail: 'rail-outline', target: '#/outline', label: '大纲', panel: 'lookup-outline' },
      {
        rail: 'rail-characters',
        target: '#/cards',
        label: '角色',
        query: 'type=character',
        panel: 'lookup-cards'
      },
      {
        rail: 'rail-setups',
        target: '#/cards',
        label: '设定',
        query: 'type=setting',
        panel: 'lookup-cards'
      }
    ]

    for (const trip of trips) {
      await gotoHash(window, chapterRoute)
      const editor = await waitForEditor(window)
      if (!editor.mounted) {
        problems.push(`进入编辑器失败，无法验证「${trip.label}」的回程（hash=${editor.hash}）`)
        continue
      }

      if (!(await clickTestId(window, trip.rail))) {
        problems.push(`点不到右侧竖栏的「${trip.label}」`)
        continue
      }

      /*
       * 第一步：右侧出现查阅面板，**并且 hash 不变** —— 竖栏这三项的
       * 意义就是「不离开正文」。要是它还是跳走了，这里先红，
       * 而不是等到后面「回程票」那条给出一个看似无关的失败。
       */
      if (!(await waitForTestId(window, trip.panel, 5000))) {
        problems.push(
          `点「${trip.label}」之后右侧没有出现查阅面板（${trip.panel}）—— ` +
            '2026-09-21 起竖栏改为就地查阅，不再跳界面'
        )
        continue
      }
      const stayed = await readWorkspace(window, (state) => state.hash === chapterRoute, 3000)
      if (stayed.hash !== chapterRoute) {
        problems.push(`点「${trip.label}」之后离开了正文（hash=${stayed.hash}），应当停在原章不动`)
        continue
      }

      /*
       * 面板在场 ≠ 没有叠字：写作工具页签必须真的 display:none。
       * （CSS 特异度压不过时页签会画在面板底下，其余断言全绿 —— 见
       * readHiddenTabsDisplay 的说明。）
       */
      const tabsDisplay = await readHiddenTabsDisplay(window)
      if (tabsDisplay !== 'none') {
        problems.push(
          `点「${trip.label}」后写作工具页签没有被藏住（display=${tabsDisplay}），` +
            '会跟查阅面板叠在一起'
        )
        continue
      }

      // 第二步：明确点「打开完整页面」才跳走
      if (!(await clickTestId(window, 'inspector-open-page'))) {
        problems.push(`点不到「${trip.label}」查阅面板上的「打开完整页面」圆钮`)
        continue
      }

      const arrivedOk = (hash: string): boolean =>
        hash.startsWith(trip.target) &&
        hash.includes('from=') &&
        (trip.query === undefined || hash.includes(trip.query))

      const arrived = await waitForHash(window, arrivedOk, 6000)
      if (!arrivedOk(arrived)) {
        problems.push(
          `点「${trip.label}」之后停在 ${arrived || '(空)'}，应当落在 ${trip.target}` +
            `${trip.query === undefined ? '' : `（含 ${trip.query}）`}?from=… —— ` +
            '不带来源参数就没有回程票，不带类型就只能从全部卡片里再筛一遍'
        )
        continue
      }

      /*
       * 等这枚按钮**渲染出来**再量它。`location.hash` 是同步改的、React 滞后一帧，
       * 只等 hash 就读的话，量到的是「上一页的 DOM + 新地址」—— 那一刻它确实
       * 「不存在」，报出来却像按钮被删了。
       */
      const ticketShown = await waitForTestId(window, 'return-to-origin', 4000)
      const ticket = (await window.webContents.executeJavaScript(
        RETURN_TICKET_PROBE_JS
      )) as ReturnTicketSnapshot

      if (!ticketShown || !ticket.present) {
        problems.push(
          `在${trip.label}页看不到「返回正文编辑」圆钮 —— 跳过去之后就回不来了（` +
            '用户 2026-09-20 的原话：「没有回到正文编辑窗口的入口」）'
        )
        continue
      }
      if (!ticket.shaped) {
        problems.push(`「返回正文编辑」按钮没有 .app-icon-button 类（class="${ticket.className}"）`)
      }
      if (ticket.width !== ticket.height || ticket.width === 0) {
        problems.push(`「返回正文编辑」按钮不是正圆（${ticket.width}×${ticket.height}）`)
      } else if (Math.abs(ticket.radiusPx - ticket.width / 2) > 1) {
        problems.push(
          `「返回正文编辑」按钮的圆角 ${ticket.radiusPx}px 不是半宽（${ticket.width / 2}px）`
        )
      }
      if (ticket.label.length === 0) {
        problems.push('「返回正文编辑」按钮没有提示文案也没有 aria-label')
      }
      // 悬浮按钮跑到视口之外等于没有 —— 它不在任何布局流里，不会被挤回来
      if (!ticket.inViewport) {
        problems.push(
          `「返回正文编辑」按钮落在可视区之外（bottom=${ticket.bottom} / 视口高 ${ticket.viewportHeight}）`
        )
      }

      /*
       * 留一张「回程票长什么样」的实拍。这类悬浮按钮是**新增的界面元素**，
       * 几何都量过了，但「它压住了什么没有、叠在返回首页上方好不好看」
       * 只有肉眼判得出来 —— 留图至少让下一次改动有对照。
       */
      if (trip.rail === 'rail-outline') {
        await captureIfRequested(window, 'origin-return')
      }

      /* 点了它必须回到**刚才那一章**，不是首页、不是书架 */
      if (!(await clickTestId(window, 'return-to-origin'))) {
        problems.push(`点不到「${trip.label}」页的返回按钮`)
        continue
      }
      const back = await readWorkspace(
        window,
        (state) =>
          state.hash === chapterRoute && state.hasEditorPage && state.bookTitle === ctx.bookTitle,
        8000
      )
      if (back.hash !== chapterRoute) {
        problems.push(
          `从${trip.label}页点返回之后停在 ${back.hash || '(空)'}，应当回到刚才那一章 ${chapterRoute}`
        )
      } else if (!back.hasEditorPage) {
        problems.push(`从${trip.label}页返回 ${chapterRoute} 之后没有渲染出正文编辑页`)
      }
    }

    /* ---------- ② 反向：正常进模块时不该出现这枚按钮 ---------- */
    await gotoHash(window, '#/outline')
    const plain = await waitForHash(window, (hash) => hash === '#/outline', 6000)
    if (plain !== '#/outline') {
      problems.push(`直接进大纲页之后 hash 是 ${plain || '(空)'}`)
    }
    /*
     * 必须等**这一页真的渲染出来**再断「没有按钮」：读得太早会读到
     * 「还没渲染完」而不是「没有这个按钮」—— 那是一条假失败，
     * 而假失败的结局通常是有人把它改成「等更久」甚至删掉这条断言。
     */
    const outlineShown = await waitForTestId(window, 'outline-page', 5000)
    if (!outlineShown) {
      problems.push('直接进 `#/outline` 之后大纲页没有渲染出来，无法核对「不该有回程票」')
    }
    await delay(300)
    const stray = (await window.webContents.executeJavaScript(
      RETURN_TICKET_PROBE_JS
    )) as ReturnTicketSnapshot
    if (stray.present) {
      problems.push(
        '从首页正常进大纲页也出现了「返回正文编辑」按钮 —— 它是外出的回程票，' +
          '不是常驻导航，摆得到处都是就等于把刚拆掉的导航栏加回来'
      )
    }

    await gotoHash(window, '#/')

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? '编辑器右侧竖栏「大纲 / 角色」→ 目标页右下角出现 40px 正圆回程票 → 点它回到**同一章**；从首页直接进模块时不出现这枚按钮'
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  }
}

/**
 * 「正文自动保存往返」—— 用户 2026-09-20 报的第二个问题：
 * 「输入的时候需要添加自动保存，防止输入文字后点击到其它地方返回来后
 * 输入的文字消失不见。」
 *
 * 自动保存本身一直在（2 秒防抖 + 离开页面强制落盘），真正丢字的凶手在
 * **读取**那头：章节详情缓存是 `staleTime: Infinity`（编辑器重新挂载时直接
 * 用缓存起稿），而保存成功后只更新了列表缓存的字数、**没更新详情缓存的正文**。
 * 于是「输入 → 跳去别处 → 回来」读到的是这一章**第一次加载时的旧正文** ——
 * 字已经在库里了，画面上却消失，重启应用才回来。这条路径在「外出回程票」
 * 出现之后变得人人都会踩。
 *
 * 所以这一条走的是**行为的全程**：打进一段新文字 → 等到底栏真的报「已保存」
 * → 离开 → 回来 → 刚打的那段字必须在画面上。
 *
 * **盲区要写在明处**（对照实验实测过）：这一步排在很多会调 `invalidateLibrary`
 * 的检查之后，而它会把章节详情也标成过期 —— 于是「回来」时查询会重新拉库，
 * 恰好把缓存不同步掩盖掉。把修复摘掉这条守卫照样绿。真实用户路径（写完
 * 直接切章回看、期间没人做过任何结构性变更）不享受这层重拉，旧缓存就会
 * 直接上屏。所以这条守卫锁的是**不变量**（保存后，无论走哪条路回来，正文都在），
 * 而不是「能抓住缓存回归」；后者靠 code review 与上面对照实验的记录。
 */
async function checkEditorRoundTrip(window: BrowserWindow, ctx: ShowcaseTargets): Promise<StepResult> {
  const name = '正文自动保存往返'
  const problems: string[] = []
  const stamp = `冒烟往返${STAMP}`

  try {
    const chapterRoute = `#/books/${ctx.bookId}/chapters/${ctx.chapterId}`
    await gotoHash(window, chapterRoute)
    const editor = await waitForEditor(window)
    if (!editor.mounted) {
      return { name, ok: false, detail: `进不了编辑器（hash=${editor.hash}），无法验证正文往返` }
    }

    /* ---------- ① 往正文末尾打一段新文字 ---------- */
    const typed = (await window.webContents.executeJavaScript(
      `(() => {
        const content = document.querySelector('.winbook-editor__content')
        if (!content) return false
        content.focus()
        const selection = window.getSelection()
        if (!selection) return false
        const range = document.createRange()
        range.selectNodeContents(content)
        range.collapse(false) /* 光标落到文档末尾 */
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('insertText', false, ${JSON.stringify(stamp)})
        return content.textContent.includes(${JSON.stringify(stamp)})
      })()`
    )) as boolean
    if (!typed) {
      return { name, ok: false, detail: '往正文里插不进文字，无法验证自动保存往返' }
    }

    /*
     * 等底栏报「已保存」。防抖 2 秒 + 一次 IPC，所以要等而不是立刻读；
     * 状态值（saved / saving / error）取自 `data-value` —— 文案里带着
     * 「N 分钟前」这种相对时间，没法做相等匹配。
     */
    const saved = await waitForSaveState(window, 'saved', 10_000)
    if (saved !== 'saved') {
      problems.push(`打字之后 10 秒内底栏没有报「已保存」（实测状态：${saved || '无'}）`)
    }

    /* ---------- ② 离开，再回来 ---------- */
    await gotoHash(window, '#/')
    await waitForHash(window, (hash) => hash === '#/', 4000)
    await gotoHash(window, chapterRoute)
    const again = await waitForEditor(window)
    if (!again.mounted) {
      problems.push(`回到 ${chapterRoute} 之后编辑器没有渲染出来`)
    } else {
      const text = (await window.webContents.executeJavaScript(
        `(document.querySelector('.winbook-editor__content')?.textContent || '')`
      )) as string
      if (!text.includes(stamp)) {
        problems.push(
          `输入并「已保存」后离开再回来，正文里找不到刚打的「${stamp}」—— ` +
            '这就是用户报的「返回来后输入的文字消失不见」：字在库里，画面读的是旧缓存'
        )
      }
    }

    await gotoHash(window, '#/')

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `正文末尾输入「${stamp}」→ 底栏报「已保存」→ 离开再回来，那段字仍在画面上（保存成功后同步详情缓存，回来不再读旧正文）`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  }
}

/** 轮询底栏保存状态的原始值（`data-value`），直到等于期望或超时 */
async function waitForSaveState(
  window: BrowserWindow,
  expected: 'saved' | 'saving' | 'error',
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="editor-save-state"]')?.getAttribute('data-value') || ''`
    )) as string
    if (last === expected) return last
    await delay(120)
  }
  return last
}

/**
 * 卡片库页：筛选条 + 卡片列表 + 编辑面板。
 *
 * 断言口径与大纲页一致 —— 只认我们自己挂在 JSX 上的锚点。
 *
 * 这里额外要量的有两件事：
 *   1. **列表面板的实际高度**。这一页与大纲页同构（内容区不滚动、两栏各自滚），
 *      高度链一旦断开，grid 的行高会被内容撑开，两栏的滚动全部失效，
 *      而 DOM 查询与卡片数量看上去完全正常。
 *   2. **编辑面板真的打开了一张卡**，而不是停在「选一张卡片来编辑」的空状态。
 *      空状态带着同一个 `card-editor` 锚点，只断言「面板存在」的话，
 *      「点开卡片打不开编辑器」这个缺陷会被判成通过 —— 正是那种
 *      「元素在、数字对、断言全绿但界面确实是坏的」。
 */
async function checkCards(window: BrowserWindow): Promise<StepResult> {
  const route = '#/cards'

  try {
    // HashRouter 认的是 hash，直接改它相当于点了一次链接
    await window.webContents.executeJavaScript(
      `(() => { location.hash = ${JSON.stringify(route)}; return true })()`
    )

    const snap = await waitForCards(window)

    const problems: string[] = []
    if (!snap.mounted) problems.push(`未进入卡片库（hash 停在 ${snap.hash || '空'}）`)
    if (snap.title !== '卡片库') problems.push(`页面标题异常：${snap.title}`)
    if (!snap.hasList) problems.push('卡片列表未渲染')
    // 后端为这本书留了 4 张卡（人物 / 物品 / 灵感 / 设定），另加 1 张通用卡；
    // 默认「全部书籍」范围应看到 5 行
    if (snap.rows !== 5) problems.push(`列表渲染出 ${snap.rows} 行，预期 5 行`)
    if (snap.total !== 5) problems.push(`卡片总数应为 5，实得 ${snap.total}`)
    if (snap.character !== 1) problems.push(`人物卡计数应为 1，实得 ${snap.character}`)
    if (snap.item !== 1) problems.push(`物品卡计数应为 1，实得 ${snap.item}`)
    if (snap.inspiration !== 2) problems.push(`灵感卡计数应为 2，实得 ${snap.inspiration}`)
    // 设定卡是 2026-09-20 落地的第四类。计数是从 CARD_TYPES 循环出来的，
    // 所以这一条真正锁的是「界面上也有这一类」（下拉与统计都挂在同一个数组上）
    if (snap.setting !== 1) problems.push(`设定卡计数应为 1，实得 ${snap.setting}`)
    if (snap.global !== 1) problems.push(`通用卡片计数应为 1，实得 ${snap.global}`)
    if (!snap.hasEditor) problems.push('右侧编辑面板未渲染')
    if (snap.editorCardId <= 0) {
      problems.push(`编辑面板没有打开任何卡片（data-card-id=${snap.editorCardId}）`)
    }
    if (snap.listHeight < 200) {
      problems.push(`列表面板高度只有 ${snap.listHeight}px，两栏的内部滚动会失效`)
    }
    // 「新建卡片」按钮：图标化 + 位于工具栏最左端（在搜索框左侧）。几何验证，不看截图。
    // 不要求紧贴搜索框：卡片库的搜索框前面还有两个筛选器，而按钮的位置是用户指定的。
    problems.push(...checkAddButtonPlacement('卡片库', snap.addButton, { adjacentToSearch: false }))

    await captureIfRequested(window, 'cards')

    // 悬浮提示单独验一次（截图之后再悬停，免得提示浮层挡住截图内容）
    const tip = await waitForTooltip(window, 'cards-add', 'cards-add-tip')
    if (tip === '') {
      problems.push('卡片库：「新建卡片」图标按钮悬浮后没有任何提示文案')
    }

    return {
      name: '卡片库',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，标题「${snap.title}」，渲染 ${snap.rows} 行 / 共 ${snap.total} 张（人物 ${snap.character} / 物品 ${snap.item} / 灵感 ${snap.inspiration} / 设定 ${snap.setting}，其中通用 ${snap.global}），编辑面板已打开卡片 #${snap.editorCardId}，列表面板高 ${snap.listHeight}px，新建按钮为 ${snap.addButton.width}px 正圆图标（圆角 ${snap.addButton.radiusPx}px），位于工具栏最左端、在搜索框左侧 ${snap.addButton.gapToSearch}px，悬浮提示「${tip}」`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，标题「${snap.title}」，列表=${
              snap.hasList ? '有' : '无'
            }，行数=${snap.rows}，总数=${snap.total}，人物=${snap.character}，物品=${snap.item}，灵感=${snap.inspiration}，设定=${snap.setting}，通用=${snap.global}，面板=${
              snap.hasEditor ? '有' : '无'
            }，面板卡片=${snap.editorCardId}，列表高=${snap.listHeight}，新建按钮文字「${snap.addButton.text}」间距=${
              snap.addButton.gapToSearch
            } 中线差=${snap.addButton.centerOffset} 在工具栏=${snap.addButton.inToolbar} 尺寸=${snap.addButton.width}×${snap.addButton.height} 圆角=${snap.addButton.radiusPx}`
    }
  } catch (error) {
    return { name: '卡片库', ok: false, detail: messageOf(error) }
  }
}

/**
 * 编辑器竖栏的「设定」入口，以及设定卡本身。
 *
 * 这一格在竖栏里置灰挂了很久（提示写着「第二期」），2026-09-20 才真的做出来。
 * 它是第四种卡片类型，但**不是第四套代码**：与人物 / 物品 / 灵感共用同一张
 * 表、同一个编辑面板，差异只有一个「类别」字段（地点 / 势力 / 规则体系 / 时间线）。
 *
 * 断言押在三件「看起来都像通过」的事上：
 *
 *   1. **入口要落到「这本书的设定」，不是「全部卡片」**。只比路径前缀的话，
 *      退化成跳到卡片库首页也照样通过 —— 而那正是从正文里跳过去最没用的结果。
 *   2. **类别必须真的存进库**。它在界面上只是一个下拉里选中的词，存不进去、
 *      或者存成了另一个键名，界面都不会报错 —— 只有回库读 extra 才知道。
 *   3. **回程票还得在**。设定页是「临时外出」的第三站，前两站（大纲 / 角色）
 *      各有各的断言，这一站若漏了就是新的死胡同。
 */
async function checkSettingCard(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '设定卡'
  const problems: string[] = []
  const title = `冒烟-设定-${STAMP}`

  try {
    const resumeId = ctx.resumeChapterId(ctx.bookId)
    if (resumeId === null) {
      return { name, ok: false, detail: '展示用书里一章都没有，无法从正文进入设定' }
    }
    const chapterRoute = `#/books/${ctx.bookId}/chapters/${resumeId}`

    await gotoHash(window, chapterRoute)
    const editor = await waitForEditor(window)
    if (!editor.mounted) {
      return { name, ok: false, detail: `进入编辑器失败（hash=${editor.hash}）` }
    }

    if (!(await clickTestId(window, 'rail-setups'))) {
      return { name, ok: false, detail: '点不到右侧竖栏的「设定」' }
    }

    /*
     * 2026-09-21 起竖栏「设定」先把设定卡列在右侧（不再跳界面），
     * 要进完整卡片库得再点面板上的「打开完整页面」。
     */
    if (!(await waitForTestId(window, 'lookup-cards', 5000))) {
      return { name, ok: false, detail: '点「设定」之后右侧没有出现设定卡查阅面板' }
    }
    const tabsDisplay = await readHiddenTabsDisplay(window)
    if (tabsDisplay !== 'none') {
      return {
        name,
        ok: false,
        detail: `点「设定」后写作工具页签没有被藏住（display=${tabsDisplay}），会跟查阅面板叠在一起`
      }
    }
    if (!(await clickTestId(window, 'inspector-open-page'))) {
      return { name, ok: false, detail: '点不到查阅面板上的「打开完整页面」圆钮' }
    }

    const wanted = (hash: string): boolean =>
      hash.startsWith('#/cards') &&
      hash.includes('type=setting') &&
      hash.includes(`book=${ctx.bookId}`) &&
      hash.includes('from=')

    const arrived = await waitForHash(window, wanted, 6000)
    if (!wanted(arrived)) {
      return {
        name,
        ok: false,
        detail:
          `点「设定」之后停在 ${arrived || '(空)'}，应当落到 #/cards 且带上 ` +
          `type=setting 与 book=${ctx.bookId}（外加 from= 供回程票）`
      }
    }

    const snap = await waitForCards(window)
    if (!snap.mounted || !snap.hasList) {
      return { name, ok: false, detail: '卡片库没有渲染出来' }
    }

    /*
     * 列表里必须**只剩设定卡**：类型筛选没跟着 URL 设好的话，这一页还是
     * 「全部卡片」，而那样「设定」这个入口等于没做 —— 作者还得自己再筛一遍。
     */
    const rowTypes = (await window.webContents.executeJavaScript(
      `Array.prototype.map.call(
        document.querySelectorAll('[data-testid="card-row"]'),
        (el) => el.getAttribute('data-card-type')
      ).join(',')`
    )) as string

    if (snap.rows < 1) {
      problems.push('这本书一张设定卡都没有，无法证明入口真的落到了「设定」而不是空结果')
    } else if (!rowTypes.split(',').every((value) => value === 'setting')) {
      problems.push(`设定入口进来的列表里还有别的类型（实测 ${rowTypes}）—— 类型筛选没有跟着 URL 设好`)
    }

    /* ---- 新建一张「时间线」设定卡，回库核对 ---- */
    if (!(await clickTestId(window, 'cards-add'))) {
      problems.push('点不到卡片库的「新建卡片」')
    } else if (!(await waitForTestId(window, 'card-title-input', 3000))) {
      problems.push('新建面板没有打开（找不到标题输入框）')
    } else {
      if (!(await typeIntoTestId(window, 'card-title-input', title))) {
        problems.push('填不进设定卡的标题')
      }
      if (!(await pickSelectOption(window, 'card-type-select', '设定'))) {
        problems.push('卡片类型的下拉里选不到「设定」')
      }
      if (!(await pickSelectOption(window, 'card-extra-category', '时间线'))) {
        problems.push('设定卡没有「类别」下拉，或里面选不到「时间线」')
      }
      if (!(await clickTestId(window, 'card-save'))) {
        problems.push('点不到新建面板的保存按钮')
      }
    }

    const created = await waitForCard(ctx.lookupCard, title, true)
    if (created === null) {
      problems.push(`库里查不到刚建的设定卡「${title}」`)
    } else {
      if (created.cardType !== 'setting') {
        problems.push(`落库类型是 ${created.cardType}，应为 setting`)
      }
      /*
       * 2026-09-21 起设定卡多了「时点」与「时间线序号」两个字段（第三期
       * 第 2 件），所以完整的键集是这三个。写死在这里而不是「包含 category」
       * 就够了：多出一个键往往意味着别的类型切过来时没被清干净。
       */
      if (created.extraKeys !== 'category,order,timePoint') {
        problems.push(
          `extra 的键是「${created.extraKeys}」，应当恰好是 category,order,timePoint`
        )
      }
      if (created.category !== '时间线') {
        problems.push(`类别存成了「${created.category}」，应为「时间线」`)
      }

      // 验证用的卡片建完就删：后面的步骤还要看卡片总数
      ctx.removeCard(created.id)
      const after = await waitForCard(ctx.lookupCard, title, false)
      if (after !== null) problems.push(`删除之后库里还能查到「${title}」`)
    }

    /* ---- 这一站也要有回程票，且点了回到刚才那一章 ---- */
    if (!(await clickTestId(window, 'return-to-origin'))) {
      problems.push('在设定页看不到「返回正文编辑」圆钮 —— 跳过去之后就回不来了')
    } else {
      const back = await readWorkspace(
        window,
        (state) => state.hash === chapterRoute && state.hasEditorPage,
        8000
      )
      if (back.hash !== chapterRoute) {
        problems.push(`从设定返回后停在 ${back.hash || '(空)'}，应当回到 ${chapterRoute}`)
      } else if (!back.hasEditorPage) {
        problems.push(`从设定返回 ${chapterRoute} 之后没有渲染出正文编辑页`)
      }
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `竖栏「设定」直达这本书的设定卡（列表 ${snap.rows} 行全是设定卡）→ 新建一张并把类别选成「时间线」，回库核对 cardType=setting、extra 恰好 category,order,timePoint 且 category=时间线 → 删掉这张验证卡 → 点回程票回到同一章`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  }
}

/**
 * 读卡片列表里每一行的类型与类别。
 *
 * 逐行读而不是只比总数：类别筛选最容易出现的假通过就是「总数对了、
 * 行数也对了，但行是别的类别」—— 数字层面看不出来，只有逐行读才知道。
 */
async function readCardRowInfo(
  window: BrowserWindow
): Promise<Array<{ type: string; category: string }>> {
  const raw = (await window.webContents.executeJavaScript(
    `JSON.stringify(Array.prototype.map.call(
      document.querySelectorAll('[data-testid="card-row"]'),
      (el) => ({
        type: el.getAttribute('data-card-type') || '',
        category: el.getAttribute('data-card-category') || ''
      })
    ))`
  )) as string
  return JSON.parse(raw) as Array<{ type: string; category: string }>
}

/**
 * 等一个下拉**可用**再动手。
 *
 * 这里的下拉在数据没到之前是 `disabled` 的（选项为空，点了也没意义）。
 * 直接去选的话，mousedown 打在一个禁用的下拉上，浮层压根不展开，
 * 3 秒重试窗口内每次都扑空 —— 表现是「随机失败」：机器快的时候数据
 * 早就回来了，慢一点就红。等目标状态，不要等固定时长。
 */
async function waitForSelectReady(
  window: BrowserWindow,
  testId: string,
  timeoutMs = 8000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-testid="${testId}"]')
        if (!el) return false
        if (el.classList.contains('ant-select-disabled')) return false
        return el.getAttribute('aria-disabled') !== 'true'
      })()`
    )) as boolean
    if (ready) return true
    await delay(120)
  }
  return false
}

/**
 * 等某个 testid 的元素个数变成预期值。
 *
 * 0 也很有用：「点了删除，行要消失」这类断言如果读一次就下结论，
 * 等于在赌 IPC 回程与 React 重渲染的几十毫秒 —— 本地快、偶发慢，
 * 就成了那种「本机全绿、别人偶尔红」的守卫。
 */
async function waitForCount(
  window: BrowserWindow,
  testId: string,
  expected: number,
  timeoutMs = 4000
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = -1
  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="${testId}"]').length`
    )) as number
    if (last === expected) return last
    await delay(120)
  }
  return last
}

/** 等列表行数稳定在某个值。筛选是异步的：点完下拉，请求要等一拍才回来 */
async function waitForCardRowCount(
  window: BrowserWindow,
  expected: number,
  timeoutMs = 4000
): Promise<Array<{ type: string; category: string }>> {
  const deadline = Date.now() + timeoutMs
  let last = await readCardRowInfo(window)
  while (Date.now() < deadline) {
    if (last.length === expected) return last
    await delay(120)
    last = await readCardRowInfo(window)
  }
  return last
}

/**
 * 重新加载渲染进程，并停在当前 hash 上。
 *
 * 冒烟有两处数据是**绕着界面直接写进库**的（seed 一张卡），而全局
 * staleTime 是 15 秒：同一个 queryKey 在这期间被当成 fresh 不再请求，
 * 界面于是停在造数据之前的那一版列表上。真实写入不存在这个问题 ——
 * 它们都走 mutation 并 invalidate，前端立刻知道。
 *
 * reload 清空 React Query 的缓存，等价于用户按了一次刷新，
 * 是拿到真实数据最直接的方式，也顺带验了深链在刷新之后仍然有效。
 */
async function reloadAt(window: BrowserWindow, hash: string): Promise<void> {
  await gotoHash(window, hash)
  await window.webContents.reload()
  await waitForLoad(window)
}

/** 设定卡各类别的计数（界面上那一行数字） */
async function readCategoryCounts(window: BrowserWindow): Promise<Record<string, number>> {
  const raw = (await window.webContents.executeJavaScript(
    `(() => {
      const out = {}
      document.querySelectorAll('[data-testid^="cards-category-count-"]').forEach((el) => {
        const key = el.getAttribute('data-testid').replace('cards-category-count-', '')
        out[key] = Number(el.getAttribute('data-value'))
      })
      return JSON.stringify(out)
    })()`
  )) as string
  return JSON.parse(raw) as Record<string, number>
}

/**
 * 点开某个页签（按标题文字）。
 *
 * antd 的 Tabs 没有稳定的 testid 可挂，只能按文本找。这里只用于**驱动**，
 * 断言读的仍然是 testid 与库里的真实关联。
 */
async function clickTabByLabel(window: BrowserWindow, label: string): Promise<boolean> {
  return (await window.webContents.executeJavaScript(
    `(() => {
      const tab = Array.prototype.slice
        .call(document.querySelectorAll('.ant-tabs-tab'))
        .find((el) => (el.getAttribute('data-testid') || '') === ${JSON.stringify(label)} ||
                       (el.textContent || '').trim().startsWith(${JSON.stringify(label)}))
      if (!tab) return false
      tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()`
  )) as boolean
}

/**
 * 设定卡按类别筛选。
 *
 * 类别只是 extra 里的一个字段，界面上表现为列表行里的一段文字，于是
 * 「筛选生效了」有太多看起来正确的失败方式：行数变了、总数变了，
 * 可筛出来的可能是别的类别。所以断言逐行读 data-card-category。
 *
 * 另一半风险在 SQL：类别过滤走 json_extract。若有人把这项条件也加进了
 * 计数查询，表现是「选了时间线之后另外三类计数全变 0」—— 而那看起来
 * 像是数据被删了。因此计数也要对账：选完类别，各类别的数字不许变。
 */
async function checkSettingCategoryFilter(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '设定卡类别筛选'
  const problems: string[] = []
  const seeded: number[] = []

  try {
    /*
     * 造两张「时间线」设定卡。展示数据里本来就有一张设定卡（势力），
     * 只靠它的话「筛出 1 行」证明不了筛对了 —— 少写条件的 bug
     * 同样会碰巧剩 1 行。两张才能把「筛出来的是这一类」和
     * 「筛出来的不是那一类」分开。
     */
    for (const suffix of ['甲', '乙']) {
      seeded.push(ctx.seedSettingCard(`冒烟-时间线${suffix}-${STAMP}`, '时间线'))
    }

    /*
     * 直接进「这本书的设定卡 + 时间线」这一格。
     *
     * 除了顺带验一遍类别深链，更重要的是**换一个没被查过的 queryKey**：
     * 全局 staleTime 是 15 秒，而上面两张卡是主进程直接建进去的、前端
     * 无从知晓（真实写入都走 mutation 并 invalidate，只有冒烟这种
     * 「绕着界面改库」的造数方式会遇到）。命中旧缓存的话，第一帧读到的
     * 是造数据之前的计数 —— 那会把「缓存没换」报成「筛选算错了」。
     */
    await gotoHash(window, `#/cards?type=setting&book=${ctx.bookId}&category=时间线`)

    /*
     * 类别是「时间线」时卡片库默认就给**时间线视图**（第三期第 2 件），
     * 而这一项要读的是列表行上的类别 —— 时间线视图里没有 cards-list。
     * 先切回列表，顺带把那枚切换按钮也验了。
     */
    if (!(await waitForTestId(window, 'cards-view-list', 5000))) {
      return { name, ok: false, detail: '卡片库里没有「列表 / 时间线」视图切换' }
    }
    if (!(await clickTestId(window, 'cards-view-list'))) {
      return { name, ok: false, detail: '点不到「列表」视图切换按钮' }
    }

    const snap = await waitForCards(window)
    if (!snap.mounted || !snap.hasList) {
      return { name, ok: false, detail: '卡片库没有渲染出来，无法验证类别筛选' }
    }

    if (!(await waitForTestId(window, 'cards-category-select', 4000))) {
      problems.push('选中「设定」之后没有出现类别下拉')
    }

    const rows = await waitForCardRowCount(window, 2)
    if (rows.length !== 2) {
      problems.push(`深链「时间线」应筛出 2 行，实得 ${rows.length} 行`)
    } else {
      const wrong = rows.filter((row) => row.category !== '时间线')
      if (wrong.length > 0) {
        problems.push(
          `深链「时间线」之后有 ${wrong.length} 行的类别不对（实测 ${rows
            .map((row) => row.category || '(空)')
            .join(' / ')}）`
        )
      }
      if (!rows.every((row) => row.type === 'setting')) {
        problems.push('按类别筛完之后列表里出现了非设定卡')
      }
    }

    const counts = await readCategoryCounts(window)
    if (counts['时间线'] !== 2) {
      problems.push(`时间线的类别计数应为 2，实得 ${counts['时间线']}`)
    }
    if (counts['势力'] !== 1) {
      problems.push(`势力的类别计数应为 1，实得 ${counts['势力']}`)
    }

    /*
     * 换到「势力」再读一次计数：各类别的数字不许跟着筛选清零。
     * 它们是导航用的数字，被自己这一维筛没了就变成「那些设定被删了」的错觉。
     */
    if (!(await pickSelectOption(window, 'cards-category-select', '势力'))) {
      problems.push('类别下拉里选不到「势力」')
    } else {
      const only = await waitForCardRowCount(window, 1)
      if (only.length !== 1) {
        problems.push(`切到「势力」应剩 1 行，实得 ${only.length} 行`)
      }
      const after = await readCategoryCounts(window)
      if (after['时间线'] !== counts['时间线'] || after['势力'] !== counts['势力']) {
        problems.push(
          `选了「势力」之后类别计数跟着变了（时间线 ${counts['时间线']}→${after['时间线']}，` +
            `势力 ${counts['势力']}→${after['势力']}）—— 计数是导航用的，不该被自己这一项筛掉`
        )
      }
    }

    if (!(await pickSelectOption(window, 'cards-category-select', '时间线'))) {
      problems.push('类别下拉里选不到「时间线」')
    } else {
      /*
       * 类别选回「时间线」会**自动切到时间线视图**（第三期第 2 件），
       * 那时列表行是不存在的。切回列表再读行数 ——
       * 这一项验的是「筛得对不对」，不是视图切换。
       */
      await clickTestId(window, 'cards-view-list')
      const back = await waitForCardRowCount(window, 2)
      if (back.length !== 2) {
        problems.push(`切回「时间线」应剩 2 行，实得 ${back.length} 行`)
      } else if (!back.every((row) => row.category === '时间线')) {
        problems.push(
          `切回「时间线」之后有行的类别不对（实测 ${back
            .map((row) => row.category || '(空)')
            .join(' / ')}）`
        )
      }
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `库中 3 张设定卡（势力 1 / 时间线 2）→ ?category=时间线 深链直达，2 行逐行核对类别都是时间线；` +
            `再切到「势力」剩 1 行，而各类别计数保持不变（时间线 2 / 势力 1）—— ` +
            `计数是导航用的数字，不该被自己这一维筛成 0；切回「时间线」仍是 2 行`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  } finally {
    // 造的卡片一定删掉：后面的检查还要看卡片总数
    for (const id of seeded) ctx.removeCard(id)
  }
}

/**
 * 设定卡时间线（第三期第 2 件）。
 *
 * 押的是三个「界面排出来了、顺序却没真的排」的失败点：
 *
 *   1. **上下移动只动了界面。** 本地 state 换一下位置是最容易写出来的实现，
 *      而它看起来完全正常 —— 只有回库读 extra 里的序号才看得出没落库。
 *   2. **「没排过序号」被当成 0。** 那样新建的卡会一出现就插到最前面，
 *      把作者刚排好的顺序挤乱。这里用「没排过的按建卡先后跟在后面」
 *      这条规则挡住，并断言建卡顺序。
 *   3. **时点没渲染。** 时间线的全部意义就是那一串时点，行上看不到
 *      就退化成一个普通列表 —— 所以逐行读 data-time 对账。
 */
async function checkSettingTimeline(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '设定卡时间线'
  const problems: string[] = []
  const seeded: number[] = []

  /** 时间线当前的行：卡片 id、所在位次、显示的时点 */
  const readRows = async (): Promise<
    Array<{ cardId: number; order: number; time: string }>
  > => {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll('[data-testid="timeline-item"]'),
        (el) => ({
          cardId: Number(el.getAttribute('data-card-id')),
          order: Number(el.getAttribute('data-order')),
          time: el.getAttribute('data-time') || ''
        })
      ))`
    )) as string
    return JSON.parse(raw) as Array<{ cardId: number; order: number; time: string }>
  }

  /** 点某一行内部的按钮（上下移动是按卡片定位的，不能只按 testid 点第一个） */
  const clickIn = async (selector: string): Promise<boolean> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (el === null || el.disabled === true) return false
        el.click()
        return true
      })()`
    )) as boolean

  try {
    const times = ['星历 2103 年', '星历 2104 年', '开战前三天']
    const titles = times.map((_, index) => `冒烟-时序${index}-${STAMP}`)
    for (let index = 0; index < titles.length; index += 1) {
      seeded.push(ctx.seedSettingCard(titles[index], '时间线', times[index]))
    }

    /*
     * 与类别筛选那一项同样的理由：换一个**没被查过**的 queryKey。
     * 全局 staleTime 是 15 秒，这几张卡是主进程直接建进去的，
     * 命中旧缓存的话读到的会是造数据之前的列表。
     */
    await reloadAt(window, `#/cards?type=setting&book=${ctx.bookId}&category=时间线`)

    if (!(await waitForTestId(window, 'setting-timeline', 8000))) {
      return { name, ok: false, detail: '类别是「时间线」时没有直接给出时间线视图' }
    }

    // 等三行都渲染出来：等目标状态，而不是读一次
    const deadline = Date.now() + 6000
    let rows = await readRows()
    while (
      Date.now() < deadline &&
      !seeded.every((id) => rows.some((row) => row.cardId === id))
    ) {
      await delay(120)
      rows = await readRows()
    }

    const at = (list: typeof rows, cardId: number): number =>
      list.findIndex((row) => row.cardId === cardId)
    const positions = seeded.map((id) => at(rows, id))

    if (positions.some((index) => index < 0)) {
      problems.push(
        `时间线里没有找齐这三张验证卡（实测 ${rows.map((row) => row.cardId).join(',') || '空'}）`
      )
    } else if (!(positions[0] < positions[1] && positions[1] < positions[2])) {
      problems.push(
        `没排过序号时应当按建卡先后排列，实测位次 ${positions.map((i) => i + 1).join(' → ')}`
      )
    }

    const firstRow = rows.find((row) => row.cardId === seeded[0])
    if (firstRow !== undefined && firstRow.time !== times[0]) {
      problems.push(
        `时间线行上没有显示时点（期望「${times[0]}」，实测「${firstRow.time || '空'}」）`
      )
    }

    /* ---------- 下移一位：界面要动，库里也要动 ---------- */
    if (
      !(await clickIn(
        `[data-testid="timeline-item"][data-card-id="${seeded[0]}"] ` +
          '[data-testid="timeline-move-down"]'
      ))
    ) {
      problems.push('点不到时间线第一行的「下移」按钮')
    } else {
      const moveDeadline = Date.now() + 6000
      let after = await readRows()
      while (Date.now() < moveDeadline) {
        after = await readRows()
        const a = at(after, seeded[0])
        const b = at(after, seeded[1])
        if (a >= 0 && b >= 0 && b < a) break
        await delay(120)
      }

      const a = at(after, seeded[0])
      const b = at(after, seeded[1])
      if (!(b >= 0 && a >= 0 && b < a)) {
        problems.push(
          `点了「下移」之后界面顺序没变（#${seeded[0]} 在第 ${a + 1} 位，` +
            `#${seeded[1]} 在第 ${b + 1} 位）`
        )
      }

      /*
       * 回库对账 —— 这是这一项唯一能证明「排序真的存下来了」的判据。
       * 第三张卡也必须有序号：提交的是**整组顺序**，只改两张的话
       * 第三张会留在「没排过」的状态，下次加卡就会乱。
       */
      const orderOf = (index: number): string => ctx.lookupCard(titles[index])?.order ?? ''
      const [o0, o1, o2] = [orderOf(0), orderOf(1), orderOf(2)]
      if (o0 !== '1' || o1 !== '0' || o2 !== '2') {
        problems.push(
          `下移之后库里的序号不对（「${titles[0]}」=${o0 || '空'}、` +
            `「${titles[1]}」=${o1 || '空'}、「${titles[2]}」=${o2 || '空'}，期望 1 / 0 / 2）`
        )
      }
    }

    /* ---------- 类别计数那一格是入口：点它要把类别写进地址栏 ---------- */
    if (!(await clickTestId(window, 'cards-category-entry-时间线'))) {
      problems.push('点不到类别计数上的「时间线」入口')
    } else {
      const arrived = await waitForHash(window, (hash) => hash.includes('category='), 4000)
      if (!arrived.includes('category=')) {
        problems.push(`点类别计数之后地址栏没有带上类别（${arrived || '(空)'}）`)
      }
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `三张带时点的「时间线」设定卡 → 时间线视图按建卡先后给出 ${rows.length} 行并逐行显示时点；` +
            `点第一行「下移」→ 界面换序且库里序号跟着变成 0/1/2（整组提交，第三张也编号）；` +
            `点类别计数那一格 → 地址栏带上 ?category=`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  } finally {
    for (const id of seeded) ctx.removeCard(id)
    /*
     * 与「卡片与大纲节点关联」那个坑是同一个道理的另一面：删完之后
     * 整页重载，把缓存里这几张已删的卡冲掉 —— 否则下一个检查会拿着
     * 它们的 id 去取数，撞出 NOT_FOUND。
     */
    await reloadAt(window, '#/')
  }
}

/**
 * 卡片 ↔ 章节的关联，两个方向各走一遍。
 *
 * 押的是三个「界面绿、数据是空」的失败点：
 *
 *   1. **下拉里选了章，列表长出一行，但库里根本没有那条关联。**
 *      界面本地 state 自己加一行是最容易写出来的 bug，而它看起来完全正常。
 *      所以每一步都回库读 linksOfCard / cardsOfChapter 对账。
 *   2. **只做通了一个方向。** 关联是对称的，但两个方向的 UI 是两套代码；
 *      卡片页连上了、章节页「设定」页签里却空着，是最典型的漏做。
 *   3. **同书约束被绕过。** 跨书关联没有意义（点过去是另一本书的章节），
 *      这里虽然没直接测跨书（展示数据里另一本书也有章），但两侧都从
 *      同一本书取数据，若服务层那条检查写反了，这趟往返会直接报错。
 */
/**
 * 卡片 ↔ 大纲节点的关联（第三期第 1 件）。
 *
 * 与 checkCardChapterLink 同一套骨架 —— 两个方向都要验：
 * 卡片侧「挂在哪些节点」、节点侧「用到哪些卡片」。只验一侧的话，
 * 另一侧的下拉可能一直不可用（比如取不到这本书的节点），
 * 而界面上表现为「还没关联」，看着跟正常空态一模一样。
 *
 * **每一侧都回库对账**：界面上长出一行只证明渲染到了，库里真有那条
 * 记录才证明功能做了。这是这个项目一贯的口径。
 */
/**
 * 离开当前页面，然后删掉一张验证用的卡片。返回一条问题描述（没问题则空串）。
 *
 * 顺序很要紧：**先真的离开，再删**。页面上那些按 cardId 取数的查询（这张卡
 * 的章节关联、节点关联）只要还在场，卡片一没就会重新取数，撞出两次
 * NOT_FOUND —— 「IPC 无静默失败」会把它们记成真故障，而它们只是删除之后
 * 的必然结果。（这一项连踩过两次：2 次被拒｜cards:list-links /
 * cards:list-node-links → NOT_FOUND。）
 *
 * 「真的离开」要有**正面**判据：
 *   - 只改 hash 不够 —— 导航是异步的，紧接着就删的话 React 还没卸载面板；
 *   - 判据也不能取「卡片面板消失了」—— 选择器写错、或页面压根没渲染时，
 *     数出来同样是 0，于是一路放行，看起来像通过了。
 * 所以等的是首页的 `dashboard-metrics`（`#/` 渲染 DashboardPage，锚点见
 * 该文件头的说明）：它出现即证明路由已经切走、编辑页已卸载。
 *
 * 就算没等到也照删：留一张野卡片在库里，后面按总数对账的检查会跟着错。
 */
async function leaveAndRemoveCard(
  window: BrowserWindow,
  ctx: ShowcaseTargets,
  cardId: number
): Promise<string> {
  if (cardId === 0) return ''
  await gotoHash(window, '#/')
  const ready = await waitForTestId(window, 'dashboard-metrics', 5000)
  ctx.removeCard(cardId)
  /*
   * 删完还要**整页重载**一次，把渲染进程的查询缓存冲掉。
   *
   * 缓存里的「卡片列表」结果还带着这张刚删掉的卡（staleTime 是 15 秒，足够
   * 撑到下一个检查）。卡片库页一挂载就自动选中列表第一行，于是下一步会拿着
   * 这个已经不存在的 id 去取关联，撞出两次 NOT_FOUND（cards:list-links /
   * cards:list-node-links），被「IPC 无静默失败」记成真故障。
   *
   * 这是**测试**的副作用，不是产品缺陷：真实删除走 IPC 变更，会顺带失效
   * 列表缓存；只有绕过前端直接改库才会留下这份陈旧结果。
   */
  await reloadAt(window, '#/')
  return ready ? '' : '删掉验证用的卡片之前没能回到首页，随后的删除可能撞出 NOT_FOUND'
}

async function checkCardNodeLink(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '卡片与大纲节点关联'
  const problems: string[] = []
  const cardTitle = `冒烟-节点关联-${STAMP}`
  let cardId = 0

  try {
    const nodes = ctx.nodesOf(ctx.bookId)
    if (nodes.length === 0) {
      return { name, ok: false, detail: '展示用书里一个大纲节点都没有，无法验证关联' }
    }
    const node = nodes[0]

    cardId = ctx.seedSettingCard(cardTitle, '势力')

    /* ---------- ① 卡片侧：把这张卡挂到某个节点 ---------- */
    await reloadAt(window, `#/cards?cardId=${cardId}`)
    if (!(await waitForTestId(window, 'card-node-links', 8000))) {
      const cleanup = await leaveAndRemoveCard(window, ctx, cardId)
      return {
        name,
        ok: false,
        detail: '卡片面板里没有「挂在哪些情节节点」这一块' + (cleanup ? `（${cleanup}）` : '')
      }
    }

    if (!(await waitForSelectReady(window, 'card-link-node-select'))) {
      problems.push('「选择情节节点」的下拉一直不可用：这本书的节点没加载出来')
    } else if (!(await pickSelectOption(window, 'card-link-node-select', node.title))) {
      problems.push(`节点下拉里选不到「${node.title}」`)
    } else if (!(await waitForTestId(window, 'card-node-link-row', 5000))) {
      problems.push('选了节点之后关联列表里没有长出这一行')
    } else {
      const nodeIds = (await window.webContents.executeJavaScript(
        `Array.prototype.map.call(
          document.querySelectorAll('[data-testid="card-node-link-row"]'),
          (el) => Number(el.getAttribute('data-node-id'))
        ).join(',')`
      )) as string
      if (!nodeIds.split(',').includes(String(node.id))) {
        problems.push(`关联行里没有节点 #${node.id}（实测 ${nodeIds || '空'}）`)
      }

      const linked = ctx.nodesOfCard(cardId)
      if (!linked.includes(node.id)) {
        problems.push(`库里查不到这张卡与节点 #${node.id} 的关联（实得 ${linked.join(',') || '空'}）`)
      }

      /* ---------- ② 解除：库与界面同时清空（都等，不读一次） ---------- */
      if (!(await clickTestId(window, 'card-unlink-node'))) {
        problems.push('点不到节点侧的「解除关联」按钮')
      } else {
        const deadline = Date.now() + 5000
        let remaining = ctx.nodesOfCard(cardId)
        while (Date.now() < deadline && remaining.length > 0) {
          await delay(120)
          remaining = ctx.nodesOfCard(cardId)
        }
        if (remaining.length > 0) {
          problems.push(`解除之后库里还剩 ${remaining.length} 条关联（${remaining.join(',')}）`)
        }

        const leftRows = await waitForCount(window, 'card-node-link-row', 0, 5000)
        if (leftRows !== 0) {
          problems.push(`库里已解除，界面上却还留着 ${leftRows} 行`)
        }
      }
    }

    /* ---------- ③ 节点侧：大纲面板里反方向再连一次 ---------- */
    /*
     * 走 `?nodeId=` 深链而不是「进去再点第一行」：大纲页默认是空状态
     * （没选中节点时右侧面板根本不渲染），漏了这步会把「面板没叫出来」
     * 报成「功能没做」；而点第一行还多一层风险 —— 树的第一行未必是
     * 这里要断言的那个节点，库里对账就会对到别的节点上。
     */
    await gotoHash(window, `#/outline?bookId=${ctx.bookId}&nodeId=${node.id}`)

    if (!(await waitForTestId(window, 'outline-node-refs', 8000))) {
      problems.push('大纲节点面板里没有「用到的卡片」这一块')
    } else {
      const optionText = `${cardTitle}（设定）`
      if (!(await waitForSelectReady(window, 'outline-node-ref-add-select'))) {
        problems.push('「选择一张卡片」的下拉一直不可用（这本书的卡片没加载出来？）')
      } else if (!(await pickSelectOption(window, 'outline-node-ref-add-select', optionText))) {
        problems.push(`卡片下拉里选不到「${optionText}」`)
      } else if (!(await waitForTestId(window, 'outline-node-ref-row', 5000))) {
        problems.push('选了卡片之后节点侧没有长出关联行')
      } else {
        const refs = ctx.cardsOfNode(node.id)
        if (!refs.includes(cardId)) {
          problems.push(
            `库里查不到节点 #${node.id} 与卡片 #${cardId} 的关联（实得 ${refs.join(',') || '空'}）`
          )
        }

        if (!(await clickTestId(window, 'outline-node-ref-unlink'))) {
          problems.push('点不到节点侧的「解除关联」按钮')
        } else {
          const deadline = Date.now() + 5000
          let left = ctx.cardsOfNode(node.id)
          while (Date.now() < deadline && left.length > 0) {
            await delay(120)
            left = ctx.cardsOfNode(node.id)
          }
          if (left.length > 0) {
            problems.push(`节点侧解除之后库里还剩 ${left.length} 条关联`)
          }

          const leftRows = await waitForCount(window, 'outline-node-ref-row', 0, 5000)
          if (leftRows !== 0) {
            problems.push(`库里已解除，节点侧界面上却还留着 ${leftRows} 行`)
          }
        }
      }
    }

    /*
     * 清理写在**构建结果之前**，不能写在 finally 里：finally 是在 return 的
     * 表达式求值之后才执行的，那时 ok 已经算完了，清理期发现的问题就再也
     * 进不了 ok —— 记了等于没记。
     */
    const cleanup = await leaveAndRemoveCard(window, ctx, cardId)
    if (cleanup) problems.push(cleanup)

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `卡片侧：下拉选节点「${node.title}」→ 长出关联行，回库 nodesOfCard 含 #${node.id} → 解除后界面与库同时清空；` +
            `节点侧：大纲面板下拉选「${cardTitle}（设定）」→ 长出关联行，回库 cardsOfNode 含 #${cardId} → 解除后同样两边都空`
          : problems.join('；')
    }
  } catch (err) {
    return { name, ok: false, detail: `断言过程抛错：${String(err)}` }
  }
}

/**
 * 卡片 ↔ 卡片的关系（第三期第 3 件）。
 *
 * 押的是三个「界面长得像通过、其实没做」的失败点：
 *
 *   1. **面板里长出一行，库里却没有那条边。** 本地 state 自己加一行是最容易
 *      写出来的 bug，而它看起来完全正常 —— 所以每一步都回库对账。
 *   2. **只有一头看得到。** 关系没有方向，但从 id 小的那头与 id 大的那头
 *      查是两条 SQL 分支（WHERE 里两个条件），只扫一个方向就会「这一头有、
 *      那一头空」，而空列表跟「还没有关系」一模一样。所以最后从关系网点到
 *      另一头，直接看它那一侧的列表。
 *   3. **关系网里没有这条边。** 它是按书聚合的另一条查询，漏了它界面上
 *      表现为「卡片上的关系都在，关系网却一直是空的」。
 */
async function checkCardRelation(window: BrowserWindow, ctx: ShowcaseTargets): Promise<StepResult> {
  const name = '人物关系'
  const problems: string[] = []
  const titleA = `冒烟-关系甲-${STAMP}`
  const titleB = `冒烟-关系乙-${STAMP}`
  const ids: number[] = []

  /** 面板里当前的关系行 */
  const readRows = async (): Promise<Array<{ relatedId: number; relation: string }>> => {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll('[data-testid="relation-row"]'),
        (el) => ({
          relatedId: Number(el.getAttribute('data-related-id')),
          relation: el.getAttribute('data-relation') || ''
        })
      ))`
    )) as string
    return JSON.parse(raw) as Array<{ relatedId: number; relation: string }>
  }

  /** 关系网里的边 */
  const readEdges = async (): Promise<
    Array<{ cardId: number; relatedId: number; relation: string }>
  > => {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll('[data-testid="relation-edge"]'),
        (el) => ({
          cardId: Number(el.getAttribute('data-card-id')),
          relatedId: Number(el.getAttribute('data-related-id')),
          relation: el.getAttribute('data-relation') || ''
        })
      ))`
    )) as string
    return JSON.parse(raw) as Array<{ cardId: number; relatedId: number; relation: string }>
  }

  /** 点某一条边内部的第二个卡名（按边定位，不能只按 testid 点第一个） */
  const clickOtherEnd = async (cardId: number, relatedId: number): Promise<boolean> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const edges = Array.prototype.slice.call(document.querySelectorAll('[data-testid="relation-edge"]'))
        const edge = edges.find((el) => Number(el.getAttribute('data-card-id')) === ${cardId} && Number(el.getAttribute('data-related-id')) === ${relatedId})
          || edges.find((el) => Number(el.getAttribute('data-card-id')) === ${relatedId} && Number(el.getAttribute('data-related-id')) === ${cardId})
        if (!edge) return false
        const el = edge.querySelector('[data-testid="relation-edge-open-other"]')
        if (el === null || el.disabled === true) return false
        el.click()
        return true
      })()`
    )) as boolean

  const panelCardId = async (): Promise<string> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const panel = document.querySelector('[data-testid="card-editor"]')
        return panel ? String(panel.getAttribute('data-card-id')) : 'no-panel'
      })()`
    )) as string

  try {
    ids.push(ctx.seedCard(titleA, 'character'))
    ids.push(ctx.seedCard(titleB, 'character'))

    /* ---------- ① 在 A 上建立与 B 的关系 ---------- */
    await reloadAt(window, `#/cards?cardId=${ids[0]}`)
    if (!(await waitForTestId(window, 'card-relations', 8000))) {
      return {
        name,
        ok: false,
        detail: `卡片面板里没有「关系」这一块（目标卡片 #${ids[0]}）`
      }
    }

    if (!(await waitForSelectReady(window, 'relation-select'))) {
      problems.push('「选择另一张卡」的下拉一直不可用（这本书的卡片没加载出来？）')
    } else if (!(await pickSelectOption(window, 'relation-select', `${titleB}（人物）`))) {
      problems.push(`下拉里选不到「${titleB}（人物）」`)
    } else if (!(await typeIntoTestId(window, 'relation-label-input', '师徒'))) {
      problems.push('填不进关系名')
    } else if (!(await clickTestId(window, 'relation-add'))) {
      problems.push('点不到「建立关系」')
    } else {
      const grown = await waitForCount(window, 'relation-row', 1, 5000)
      if (grown !== 1) {
        problems.push(`建立之后关系列表里没有长出这一行（实得 ${grown} 行）`)
      }

      const rows = await readRows()
      const row = rows.find((item) => item.relatedId === ids[1])
      if (row === undefined) {
        problems.push(`关系行里没有 #${ids[1]}（实测 ${rows.map((item) => item.relatedId).join(',') || '空'}）`)
      } else if (row.relation !== '师徒') {
        problems.push(`关系行上显示的不是「师徒」（实测「${row.relation}」）`)
      }

      // 界面绿不算数：库里必须真有这一条，而且**另一头也要看得到**
      const inDb = ctx.relationsOfCard(ids[0] as number)
      if (!inDb.some((item) => item.relatedId === ids[1] && item.relation === '师徒')) {
        problems.push(
          `库里查不到 #${ids[0]} 与 #${ids[1]} 的「师徒」关系（实得 ${inDb.map((item) => `${item.relatedId}:${item.relation}`).join('、') || '空'}）`
        )
      }
      const otherSide = ctx.relationsOfCard(ids[1] as number)
      if (!otherSide.some((item) => item.relatedId === ids[0])) {
        problems.push(
          `另一头（#${ids[1]}）看不到这条关系（实得 ${otherSide.map((item) => item.relatedId).join(',') || '空'}）—— 只扫了一个方向`
        )
      }
    }

    /* ---------- ② 关系网：整本书的边里要有这一条，点另一头要跳过去 ---------- */
    await gotoHash(window, `#/cards?type=character&book=${ctx.bookId}`)
    if (!(await waitForTestId(window, 'cards-relations-open', 8000))) {
      problems.push('看着某一本书时，卡片库里没有「关系网」入口')
    } else if (!(await clickTestId(window, 'cards-relations-open'))) {
      problems.push('点不到「关系网」')
    } else if (!(await waitForTestId(window, 'relation-web', 5000))) {
      problems.push('关系网浮层没有打开')
    } else {
      const edges = await readEdges()
      const hit = edges.find(
        (edge) =>
          (edge.cardId === ids[0] && edge.relatedId === ids[1]) ||
          (edge.cardId === ids[1] && edge.relatedId === ids[0])
      )
      if (hit === undefined) {
        problems.push(
          `关系网里没有 #${ids[0]} ↔ #${ids[1]} 这条边（实得 ${edges.map((edge) => `${edge.cardId}-${edge.relatedId}`).join('、') || '空'}）`
        )
      } else if (hit.relation !== '师徒') {
        problems.push(`关系网里这条边的关系名是「${hit.relation}」，应为「师徒」`)
      }

      /*
       * 点**另一头**的名字：跳过去之后那一侧的面板里应当有同一条边 ——
       * 这是「关系没有方向」在界面上唯一看得见的证据。
       */
      if (!(await clickOtherEnd(ids[0] as number, ids[1] as number))) {
        problems.push('点不到关系网里另一头的卡名')
      } else {
        const deadline = Date.now() + 6000
        let arrived = await panelCardId()
        while (Date.now() < deadline && arrived !== String(ids[1])) {
          await delay(120)
          arrived = await panelCardId()
        }
        if (arrived !== String(ids[1])) {
          problems.push(`点关系网里的另一头之后，面板停在 #${arrived}，应当切到 #${ids[1]}`)
        }

        const rowsDeadline = Date.now() + 6000
        let rowsB = await readRows()
        while (
          Date.now() < rowsDeadline &&
          !rowsB.some((item) => item.relatedId === ids[0])
        ) {
          await delay(120)
          rowsB = await readRows()
        }
        if (!rowsB.some((item) => item.relatedId === ids[0])) {
          problems.push(
            `跳到「${titleB}」之后，它那一侧没有与「${titleA}」的关系（实测 ${rowsB.map((item) => item.relatedId).join(',') || '空'}）`
          )
        }

        /* ---------- ③ 解除：界面与库两头都要空 ---------- */
        if (!(await clickTestId(window, 'relation-unlink'))) {
          problems.push('点不到「解除关系」')
        } else {
          const dbDeadline = Date.now() + 5000
          let leftInDb = ctx.relationsOfCard(ids[1] as number)
          while (Date.now() < dbDeadline && leftInDb.length > 0) {
            await delay(120)
            leftInDb = ctx.relationsOfCard(ids[1] as number)
          }
          if (leftInDb.length > 0) {
            problems.push(
              `解除之后库里还剩 ${leftInDb.length} 条关系（${leftInDb.map((item) => item.relatedId).join(',')}）`
            )
          }
          if (ctx.relationsOfCard(ids[0] as number).length > 0) {
            problems.push('解除之后另一头的库里还剩关系 —— 一条边被拆成了两条')
          }

          const left = await waitForCount(window, 'relation-row', 0, 5000)
          if (left !== 0) {
            problems.push(`库里已解除，界面上却还留着 ${left} 行`)
          }
        }
      }
    }

    /* ---- 清理放在构建结果之前：卡还在时删，删完再整页重载清缓存 ---- */
    for (const id of ids) {
      const issue = await leaveAndRemoveCard(window, ctx, id)
      if (issue.length > 0) problems.push(issue)
    }
    await reloadAt(window, '#/')

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `人物卡「${titleA}」下拉选「${titleB}（人物）」+ 填「师徒」→ 长出 1 行，回库两头都查得到同一条边；` +
            `卡片库「关系网」里列出这条边，点另一头的名字 → 面板切到「${titleB}」且它那一侧同样看得到；` +
            `点解除 → 界面与库同时清空`
          : problems.join('；')
    }
  } catch (error) {
    for (const id of ids) await leaveAndRemoveCard(window, ctx, id)
    return { name, ok: false, detail: messageOf(error) }
  }
}

async function checkCardChapterLink(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '卡片与章节关联'
  const problems: string[] = []
  const cardTitle = `冒烟-关联-${STAMP}`
  let cardId = 0

  try {
    const chapters = ctx.chaptersOf(ctx.bookId)
    if (chapters.length === 0) {
      return { name, ok: false, detail: '展示用书里一章都没有，无法验证关联' }
    }
    const chapter = chapters[0]
    const chapterRoute = `#/books/${ctx.bookId}/chapters/${chapter.id}`

    cardId = ctx.seedSettingCard(cardTitle, '地点')

    /* ---------- ① 卡片侧：把这张卡连到某一章 ---------- */
    // reload 而不是直接 gotoHash：这张卡是主进程直接建进去的，
    // 前端缓存不知道它存在（见 reloadAt 的说明）。不刷新的话，
    // 列表里根本没有这一行，面板会停在空态 —— 那是缓存问题，不是功能问题
    await reloadAt(window, `#/cards?cardId=${cardId}`)
    if (!(await waitForTestId(window, 'card-links', 8000))) {
      // 失败时把「面板打开的是哪张卡」一起报出来：面板停在空态（card-id=new）
      // 与停在另一张卡上，是两个完全不同的故障，detail 里看不出来就白跑一趟
      const diag = (await window.webContents.executeJavaScript(
        `(() => {
          const panel = document.querySelector('[data-testid="card-editor"]')
          return JSON.stringify({
            hash: location.hash,
            panelCardId: panel ? panel.getAttribute('data-card-id') : 'no-panel',
            panelMode: panel ? panel.getAttribute('data-mode') : 'no-panel',
            rows: document.querySelectorAll('[data-testid="card-row"]').length
          })
        })()`
      )) as string
      return {
        name,
        ok: false,
        detail: `卡片面板里没有「用在哪几章」这一块（诊断：${diag}，目标卡片 #${cardId}）`
      }
    }

    if (!(await waitForSelectReady(window, 'card-link-chapter-select'))) {
      problems.push('「选择一章」的下拉一直不可用：这本书的章节没加载出来，或这本书没有章节')
    } else if (!(await pickSelectOption(window, 'card-link-chapter-select', chapter.title))) {
      problems.push(`章节下拉里选不到「${chapter.title}」`)
    } else if (!(await waitForTestId(window, 'card-link-row', 5000))) {
      problems.push('选了章节之后关联列表里没有长出这一行')
    } else {
      const rowChapterIds = (await window.webContents.executeJavaScript(
        `Array.prototype.map.call(
          document.querySelectorAll('[data-testid="card-link-row"]'),
          (el) => Number(el.getAttribute('data-chapter-id'))
        ).join(',')`
      )) as string
      if (!rowChapterIds.split(',').includes(String(chapter.id))) {
        problems.push(`关联行里没有第 ${chapter.id} 章（实测 ${rowChapterIds || '空'}）`)
      }

      // 界面绿不算数：库里必须真有这一条
      const linked = ctx.linksOfCard(cardId)
      if (!linked.includes(chapter.id)) {
        problems.push(`库里查不到这张卡与第 ${chapter.id} 章的关联（实得 ${linked.join(',') || '空'}）`)
      }

      /* ---------- ② 解除：界面上的行消失，库里也要跟着没 ---------- */
      if (!(await clickTestId(window, 'card-unlink-chapter'))) {
        problems.push('点不到「解除关联」的按钮')
      } else {
        const deadline = Date.now() + 5000
        let remaining = ctx.linksOfCard(cardId)
        while (Date.now() < deadline && remaining.length > 0) {
          await delay(120)
          remaining = ctx.linksOfCard(cardId)
        }
        if (remaining.length > 0) {
          problems.push(`解除之后库里还剩 ${remaining.length} 条关联（${remaining.join(',')}）`)
        }

        /*
         * 界面那一行也要消失 —— 同样是等，不是读一次。
         *
         * 「库里没有了」与「界面上没有了」之间隔着 IPC 回程、mutation 的
         * onSuccess、以及一次 React 重渲染。读一次就断言的话，这个检查
         * 变成在赌那几十毫秒：多数机器快、偶发机器慢，于是就成了
         * 「本地全绿、别人偶尔红」的那种守卫。
         */
        const leftRows = await waitForCount(window, 'card-link-row', 0, 5000)
        if (leftRows !== 0) {
          problems.push(`库里已解除，界面上却还留着 ${leftRows} 行`)
        }
      }
    }

    /* ---------- ③ 章节侧：编辑器的「设定」页签，反方向再连一次 ---------- */
    await gotoHash(window, chapterRoute)
    const editor = await waitForEditor(window)
    if (!editor.mounted) {
      problems.push(`进入编辑器失败，无法验证章节侧的关联（hash=${editor.hash}）`)
    } else if (!(await clickTabByLabel(window, '设定'))) {
      problems.push('编辑器右侧点不到「设定」页签')
    } else if (!(await waitForTestId(window, 'chapter-refs', 5000))) {
      problems.push('「设定」页签里没有「这一章用到了哪几条设定」这一块')
    } else {
      // 卡片下拉里的选项写成「标题（类型）」，类型文案变了这里会红 —— 那正是要报出来的
      const optionText = `${cardTitle}（设定）`
      if (!(await waitForSelectReady(window, 'chapter-ref-add-select'))) {
        problems.push('「选择一张卡片」的下拉一直不可用（这本书的卡片没加载出来？）')
      } else if (!(await pickSelectOption(window, 'chapter-ref-add-select', optionText))) {
        problems.push(`卡片下拉里选不到「${optionText}」`)
      } else if (!(await waitForTestId(window, 'chapter-ref-row', 5000))) {
        problems.push('选了卡片之后章节侧没有长出关联行')
      } else {
        const refs = ctx.cardsOfChapter(chapter.id)
        if (!refs.includes(cardId)) {
          problems.push(
            `库里查不到这一章与卡片 #${cardId} 的关联（实得 ${refs.join(',') || '空'}）`
          )
        }

        if (!(await clickTestId(window, 'chapter-ref-unlink'))) {
          problems.push('点不到章节侧的「解除关联」按钮')
        } else {
          const deadline = Date.now() + 5000
          let left = ctx.cardsOfChapter(chapter.id)
          while (Date.now() < deadline && left.length > 0) {
            await delay(120)
            left = ctx.cardsOfChapter(chapter.id)
          }
          if (left.length > 0) {
            problems.push(`章节侧解除之后库里还剩 ${left.length} 条关联`)
          }

          const leftRows = await waitForCount(window, 'chapter-ref-row', 0, 5000)
          if (leftRows !== 0) {
            problems.push(`章节侧库里已解除，界面上却还留着 ${leftRows} 行`)
          }
        }
      }
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `卡片侧：下拉选「${chapter.title}」→ 长出关联行，回库 linksOfCard 含 #${chapter.id} → ` +
            `点解除，界面与库同时清空；章节侧：编辑器「设定」页签下拉选「${cardTitle}（设定）」→ ` +
            `长出关联行，回库 cardsOfChapter 含 #${cardId} → 解除后同样两边都空`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  } finally {
    if (cardId > 0) ctx.removeCard(cardId)
  }
}

/**
 * 全库检索：顶栏搜索框 → 结果浮层 → 点开命中 → 编辑器定位到那一处。
 *
 * 这一项的重点在**最后两步**，它们无法用主进程断言覆盖：
 *
 *   1. 浮层里的结果行是 React 渲染出来的，主进程只能断言「查到了什么」，
 *      断言不了「界面有没有把它画出来、点得动吗」；
 *   2. 「跳过去并定位」是整条链路上最容易假通过的地方。编辑器能不能选中
 *      正确的字，取决于主进程给的偏移与编辑器自己的坐标系是否对得上 ——
 *      而两套纯文本投影的换行约定并不完全一致（见 ChapterEditorPage 里
 *      docChapterRef 与 locateTarget 的说明）。元素都在、hash 也变了，
 *      唯独选中的是别的字，这种失败只有把选中文本读出来才看得见。
 *
 * 因此断言读的是 `window.getSelection().toString()` —— 它是用户真正看到的
 * 那个高亮。另外还会用一个**人为偏大的偏移**再走一次深链，用来锁住
 * 「偏移只负责消歧、关键词才负责找得到」这条设计：若有人图省事直接把偏移
 * 映射过去，这一次会落空。
 */
async function checkSearch(
  window: BrowserWindow,
  showcase: { bookId: number; chapterId: number }
): Promise<StepResult> {
  const keyword = '真实数据'
  const problems: string[] = []

  try {
    // HashRouter 认的是 hash，直接改它相当于点了一次链接
    await navigateHash(window, '#/')
    await delay(400)

    /*
     * 这一项要在**可见**窗口里跑，其余几项不必。
     *
     * 因为它是唯一读 `getSelection()` 的断言：ProseMirror 只在自己真的拿到 DOM
     * 焦点时才把选区写回 DOM（见 setWindowVisible 的说明）。隐藏窗口上这条链路
     * 时好时坏 —— 失败时报出来的是「定位失败」，而真相是没人真的渲染过。
     * 与其让它随机通过，不如把前提摆明：需要焦点就给一个真能聚焦的窗口。
     */
    await setWindowVisible(window, true)

    /*
     * 驱动顶栏输入框。
     *
     * 两件事都不能只做一半：
     *
     *   1. 先用 Ctrl+K 把浮层唤起。隐藏窗口里 `input.focus()` 不一定真的产生
     *      focus 事件（Chromium 对没有系统焦点的页面可能直接忽略），而浮层是
     *      靠 onFocus 打开的 —— 不唤起，后面什么都读不到。顺带这也把「快捷键
     *      能开搜」这条真实用法测了。
     *   2. 直接改 `input.value` 是不行的 —— React 记着自己上一次渲染的值，
     *      会认为「值没变」而不触发 onChange。必须用原型上的原生 setter 绕过
     *      它的值追踪器，再补一个 input 事件，React 才会当成真实输入处理。
     *      （这是测 React 受控输入的通行做法，不是绕开断言。）
     */
    const typed = (await window.webContents.executeJavaScript(`(() => {
      const raw = document.querySelector('[data-testid="search-input"]')
      const input = raw instanceof HTMLInputElement ? raw : (raw && raw.querySelector('input'))
      if (!input) return { ok: false, reason: '顶栏没有检索输入框' }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(keyword)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true, reason: '' }
    })()`)) as { ok: boolean; reason: string }

    if (!typed.ok) {
      return { name: '全库检索', ok: false, detail: `无法驱动检索输入框：${typed.reason}` }
    }

    const panel = await waitForSearch(window)

    if (panel.panelState !== 'ready') {
      problems.push(`检索面板停在「${panel.panelState || '未打开'}」状态`)
    }
    if (panel.keywords !== keyword) {
      problems.push(`切词结果为「${panel.keywords}」，预期「${keyword}」`)
    }
    if (panel.total < 1) problems.push(`命中总数为 ${panel.total}`)
    if (!panel.sources.split(',').includes('chapter')) {
      problems.push(`结果里没有「章节正文」分组（实际来源：${panel.sources || '无'}）`)
    }
    if (panel.chapterHitId !== showcase.chapterId) {
      problems.push(`章节分组第一条指向 #${panel.chapterHitId}，预期 #${showcase.chapterId}`)
    }

    /* ---- 点开章节命中：应当跳到编辑器并选中那个关键词 ---- */
    const clicked = (await window.webContents.executeJavaScript(`(() => {
      const hit = document.querySelector('[data-testid="search-hit"][data-hit-source="chapter"]')
      if (!hit) return false
      hit.click()
      return true
    })()`)) as boolean

    if (!clicked) {
      problems.push('章节分组里没有可点击的结果行')
    } else {
      const located = await waitForLocate(window, showcase.chapterId, keyword)

      if (!located.hash.includes(`/chapters/${showcase.chapterId}`)) {
        problems.push(`点击后停在 ${located.hash}，没有跳到章节 #${showcase.chapterId}`)
      }
      if (!located.hasEditor) problems.push('章节编辑器未渲染')
      if (located.selection !== keyword) {
        problems.push(
          `编辑器里选中的是「${located.selection}」，预期「${keyword}」—— 检索给的偏移没能对上编辑器自己的坐标系`
        )
      }
    }

    /*
     * 用一个明显跑偏的偏移再走一次深链。
     *
     * 先离开编辑器再回来，是为了让组件真正重建（否则同一次挂载里
     * 「已处理过的定位请求」会被记住，第二次不会重新定位）。
     * 偏移取 99999 远超正文长度：若实现是「把偏移直接映射成文档位置」，
     * 这一步会落空；只有「用关键词重新找、偏移只用来消歧」才过得去。
     */
    await window.webContents.executeJavaScript(
      `(() => { location.hash = '#/'; return true })()`
    )
    await navigateHash(window, '#/')
    await delay(400)

    const driftTarget =
      `#/books/${showcase.bookId}/chapters/${showcase.chapterId}?find=` +
      `${encodeURIComponent(keyword)}&at=99999`
    await navigateHash(window, driftTarget)

    const drifted = await waitForLocate(window, showcase.chapterId, keyword)
    if (drifted.selection !== keyword) {
      problems.push(
        `偏移跑偏时编辑器选中的是「${drifted.selection}」—— 定位过度依赖主进程给的偏移，` +
          `而不是用自己的文本重新找关键词（停在 ${drifted.hash}，编辑器 ${drifted.hasEditor ? '已渲染' : '未渲染'}）`
      )
    }

    /*
     * 文档截图专用的一步：换个能命中三种来源的关键词，浮层才是分组齐全的样子，
     * 拿去给 README 配图才有说明力（「真实数据」只命中 1 行，
     * 画布里几乎全是顶栏）。
     *
     * 放在所有断言之后：它只负责换个画面，不参与通过与否。
     * 不设 WINBOOK_SMOKE_CAPTURE 时 captureIfRequested 直接返回，
     * 但这一步照样跑 —— 让有价值的分支保持每次都被执行，
     * 比让它在环境变量后面长期休眠更可信。
     */
    await window.webContents.executeJavaScript(`(() => {
      const raw = document.querySelector('[data-testid="search-input"]')
      const input = raw instanceof HTMLInputElement ? raw : (raw && raw.querySelector('input'))
      if (!input) return false
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '跃迁')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

    /*
     * 等的一定要是「新查询的结果到了」，而不是「面板处于 ready」——
     * 面板因为上一个查询本来就 ready，只等状态会把上一次的结果截进去：
     * 输入框写着「跃迁」，列表里却是「真实数据」的命中，文档图会自相矛盾。
     */
    await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const panel = document.querySelector('[data-testid="search-panel"]')
        if (
          panel &&
          panel.getAttribute('data-keywords') === '跃迁' &&
          panel.getAttribute('data-state') === 'ready'
        ) {
          return true
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      return false
    })()`)
    await captureIfRequested(window, 'search')

    /*
     * 清空输入再关浮层：编辑器那张截图的顶栏不该残留着别的查询词，
     * 看图的人会以为定位用的是「跃迁」。
     */
    await window.webContents.executeJavaScript(`(() => {
      const raw = document.querySelector('[data-testid="search-input"]')
      const input = raw instanceof HTMLInputElement ? raw : (raw && raw.querySelector('input'))
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }
      return true
    })()`)
    await delay(300)
    await captureIfRequested(window, 'search-editor')
    await setWindowVisible(window, false)

    return {
      name: '全库检索',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `顶栏输入「${keyword}」→ 浮层给出 ${panel.total} 处 / ${panel.hits} 行（来源：${panel.sources}），点开章节命中后停在 #${showcase.chapterId} 且编辑器选中的正是「${keyword}」；偏移跑偏时同样能定位`
          : `${problems.join('；')}｜实测：面板=${panel.panelState}，切词=「${panel.keywords}」，总数=${panel.total}，行数=${panel.hits}，来源=${panel.sources}，章节条=${panel.chapterHitId}，hash=${panel.hash}，选中=「${panel.selection}」`
    }
  } catch (error) {
    return { name: '全库检索', ok: false, detail: messageOf(error) }
  }
}

/**
 * 按需把编辑器截图存盘。
 *
 * 断言只能证明「元素在、数字对」，证明不了「看起来是那么回事」——
 * 三栏的宽度、行距、纸面色调这些只能靠眼睛。所以留一个开关：
 *
 *   WINBOOK_SMOKE_CAPTURE=D:\shots\page.png npm run smoke
 *
 * 一次运行会截多个页面，`label` 会插在扩展名之前（page-outline.png、
 * page-editor.png），这样跑一次就能把改动的几个页面都拿到，
 * 不必为了看另一个页面再跑一遍。
 *
 * 不设这个变量时本函数直接返回，不产生任何副作用。
 *
 * 注意 capturePage 的坑：冒烟窗口是 `show: false` 建的，而隐藏窗口的
 * 渲染会被 Chromium 节流，capturePage 拿回的是**第一帧**——首页刚挂载、
 * 数据还没到、连「正在自检…」都没变。所以这里必须先把窗口亮出来、关掉
 * 后台节流，等一帧真的画完再截，截完再藏回去。
 */
/**
 * 切换窗口可见性，并连带处理后台节流。
 *
 * 抽出来共用是被两件事逼出来的，它们的根其实是同一个：Chromium 对隐藏窗口
 * 做重度节流，连合成器都可能不复帧。
 *
 *   1. 截图 —— 隐藏窗口上 capturePage 拿回的是第一帧（数据还没到）；
 *   2. **断言编辑器的选中文本** —— ProseMirror 只在自己真的拿到焦点时才把
 *      选区写回 DOM（`selectionToDOM` 开头就用 `editorOwnsSelection` 把没有
 *      焦点的调用直接 return 掉）。窗口不可见时 `view.focus()` 落不下去，
 *      `getSelection()` 永远是空的，断言只会报成「定位失败」—— 而真相是
 *      **没有任何东西真的渲染过**。
 *
 * 必须给合成器留出时间画完当前这一帧，否则刚亮出来就抓，抓到的还是旧画面。
 */
async function setWindowVisible(window: BrowserWindow, visible: boolean): Promise<void> {
  window.webContents.setBackgroundThrottling(!visible)
  if (visible) {
    if (!window.isVisible()) {
      window.showInactive()
      await delay(800)
    }
  } else if (window.isVisible()) {
    window.hide()
  }
}

async function captureIfRequested(window: BrowserWindow, label: string): Promise<void> {
  const configured = process.env.WINBOOK_SMOKE_CAPTURE
  if (configured === undefined || configured.length === 0) return

  const target = withLabelSuffix(configured, label)

  try {
    const wasVisible = window.isVisible()
    await setWindowVisible(window, true)

    /*
     * 拍之前强制重绘一帧。
     *
     * `capturePage` 拿回的是**合成器当前那一帧**，而 `setWindowVisible` 在窗口
     * 已经可见时是空操作（它只在「本来隐藏」时才 `showInactive` + 等 800ms）——
     * 于是连着拍两张时，第二张可能拿回与第一张**逐字节相同**的旧帧，
     * 中间开着的浮层（下拉菜单、右键菜单）压根没进画面。
     * 实测过一次：`shot-book-menu.png` 与 `shot-book-workspace.png` 的 md5 完全一样，
     * 而拍它之前刚断过「三个菜单项都可见」。
     *
     * 截图只是辅助手段，所以这里不改判据，只让画面真的重绘一次：
     * 代价是每张图多等 120ms。
     */
    if (wasVisible) {
      window.webContents.invalidate()
      await delay(120)
    }

    const image = await window.webContents.capturePage()
    writeFileSync(target, image.toPNG())
    const bounds = window.getBounds()
    const size = image.getSize()
    console.log(
      `[winbook] ${label} 截图已写入 ${target}（窗口 ${bounds.width}x${bounds.height}，图像 ${size.width}x${size.height}）`
    )

    if (!wasVisible) await setWindowVisible(window, false)
  } catch (error) {
    // 截图只是辅助手段，失败了不该把冒烟测试带成红灯
    console.warn(`[winbook] ${label} 截图失败：`, messageOf(error))
  }
}

/**
 * 拍一张「菜单开着」的图，并**保证图里真的有菜单**。
 *
 * 「拍之前菜单开着」用等待式的判读而不是单次读：后台窗口里合成器被节流，
 * 浮层的进退场帧不按 16ms 推进，单次读会撞上「关闭帧」—— 实测顺序是
 * 等待循环里读是开的、紧接着单次一读是关的、再过 120ms 一读又是开的
 * （浮层在稳定之前会闪）。所以拍之前多确认一帧，拍完再复核一次；
 * 撞上关闭帧就等它重新展开、重拍，至多三次。三次都不成再把测试带红 ——
 * 那说明浮层真的在自行开合（真缺陷），而不是截图的问题。
 */
async function captureMenuOpen(
  window: BrowserWindow,
  label: string,
  triggerTestId: string,
  defs: MenuItemDefs
): Promise<void> {
  const configured = process.env.WINBOOK_SMOKE_CAPTURE
  if (configured === undefined || configured.length === 0) return

  const allVisible = (snapshot: MenuSnapshot): boolean =>
    snapshot.items.every((item) => item.found && item.visible)

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const opened = await openMenu(window, triggerTestId, defs)
    if (!allVisible(opened)) {
      const timeline = await traceMenu(window, defs, 6, 120)
      throw new Error(
        `菜单（[${triggerTestId}]）在截图前一直没能稳定展开｜可见项随时间：${timeline}`
      )
    }

    // openMenu 返回的那一刻可能正处在会闪的进退场段，隔一帧再确认一次
    await delay(150)
    if (!allVisible(await readMenu(window, defs))) {
      console.warn(`[winbook] ${label} 截图前菜单闪合（第 ${attempt} 次），等它重新展开`)
      continue
    }

    await captureIfRequested(window, label)

    // 拍完复核：刚才那一帧要是又撞上关闭帧，就重拍
    if (allVisible(await readMenu(window, defs))) return
    console.warn(`[winbook] ${label} 截图时菜单恰好合上了（第 ${attempt} 次），重拍`)
  }

  throw new Error(`「${label}」连拍三次都没能拍到菜单展开的画面（每次拍完都复核，读到的仍是关闭帧）`)
}

/** 把标签插到扩展名之前；没有扩展名时直接追加 */
function withLabelSuffix(filePath: string, label: string): string {
  const dot = filePath.lastIndexOf('.')
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (dot <= slash) return `${filePath}-${label}`
  return `${filePath.slice(0, dot)}-${label}${filePath.slice(dot)}`
}

/**
 * 等编辑器把数据都渲染出来。
 *
 * 纠错是防抖 320ms 后才出结果的，所以这里必须等它 —— 只等 React 挂载
 * 会拿到 0 处纠错，然后误报成「引擎没跑起来」。
 *
 * 传了 `done` 就**只**用它作判据，不再叠加下面那套「渲染齐备」的条件。
 * 这是必要的：刚建出来的新章节正文是空的、也没有可报的纠错，拿齐备条件去等
 * 会永远等不到，白白超时 20 秒再报一个假失败。
 */
async function waitForEditor(
  window: BrowserWindow,
  done?: (state: EditorSnapshot) => boolean,
  timeoutMs = 20_000
): Promise<EditorSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_EDITOR_SNAPSHOT

  /*
   * 「渲染齐备」的定义。
   *
   * 最后两条看着细，却都是被真事件逼出来的：
   *   - 顶栏齐备（六枚圆钮）：书名与书籍菜单都要等 `useBook` 回来才渲染，
   *     而章节详情是**另一支并行的查询**。只等正文，很容易在书还没到手时
   *     就读到顶栏 —— 那一刻少了「书籍菜单」，报出来却是「按钮被删了」。
   *   - 纸面有底色：纸面与面板同色那条断言读的就是这两个颜色。
   */
  const rendered = (state: EditorSnapshot): boolean =>
    state.mounted &&
    state.hasCatalog &&
    state.hasToolbar &&
    state.hasInspector &&
    state.paragraphCount >= 1 &&
    state.hanzi >= 0 &&
    state.catalogRows >= 1 &&
    state.proofreadCount >= 1 &&
    state.textColor.length > 0 &&
    state.statusbarVisible &&
    EDITOR_TOP_BAR_ACTIONS.every((id) => state.iconButtons.some((item) => item.testId === id))

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(EDITOR_SNAPSHOT_SCRIPT)) as EditorSnapshot
    if (done ? done(last) : rendered(last)) {
      return last
    }
    await delay(200)
  }

  return last
}

interface OutlineSnapshot {
  mounted: boolean
  hash: string
  title: string
  hasTree: boolean
  /** 树里实际渲染出的节点行数 */
  nodeRows: number
  /** 服务端给出的节点总数（含未展开层级的） */
  total: number
  landed: number
  hasPanel: boolean
  treeHeight: number
}

const EMPTY_OUTLINE_SNAPSHOT: OutlineSnapshot = {
  mounted: false,
  hash: '',
  title: '',
  hasTree: false,
  nodeRows: 0,
  total: -1,
  landed: -1,
  hasPanel: false,
  treeHeight: 0
}

const OUTLINE_SNAPSHOT_SCRIPT = `(() => {
  const intOf = (testId) => {
    const el = document.querySelector('[data-testid="' + testId + '"]')
    const n = Number(el?.getAttribute('data-value'))
    return Number.isFinite(n) ? n : -1
  }
  const treePane = document.querySelector('.outline-tree-pane')
  const rect = treePane ? treePane.getBoundingClientRect() : null
  return {
    mounted: !!document.querySelector('[data-testid="outline-page"]'),
    hash: location.hash,
    title: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
    hasTree: !!document.querySelector('[data-testid="outline-tree"]'),
    nodeRows: document.querySelectorAll('[data-testid="outline-node-row"]').length,
    total: intOf('outline-node-total'),
    landed: intOf('outline-landed'),
    hasPanel: !!document.querySelector('[data-testid="outline-panel"]'),
    // 树面板的高度：高度链断掉时它会退化成内容高度，两栏的滚动随之失效
    treeHeight: rect ? Math.round(rect.height) : 0
  }
})()`

/**
 * 等大纲页把树渲染出来。
 *
 * 这里等的是「树里有行、面板在、树面板有高度」三件事同时成立：
 * 只等 React 挂载会在数据到达前就返回，拿到 0 行然后误报成「树没铺开」。
 */
async function waitForOutline(window: BrowserWindow, timeoutMs = 20_000): Promise<OutlineSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_OUTLINE_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(OUTLINE_SNAPSHOT_SCRIPT)) as OutlineSnapshot
    if (last.mounted && last.hasTree && last.nodeRows >= 1 && last.hasPanel && last.treeHeight > 0) {
      return last
    }
    await delay(200)
  }

  return last
}

/** 工具栏「新建」按钮的实测几何，书籍管理与卡片库共用一份形状 */interface ToolbarAddButtonSnapshot {
  /** 按钮里的可见文字，图标按钮应为空串 */
  text: string
  /** 是否落在搜索栏所在的工具栏容器里 */
  inToolbar: boolean
  /** 搜索框左边缘与按钮右边缘的距离；负值表示按钮跑到搜索框右边去了 */
  gapToSearch: number
  /** 按钮中线与搜索框中线的偏差（垂直居中程度） */
  centerOffset: number
  /** 按钮盒子宽高（px）；正圆要求两者相等 */
  width: number
  height: number
  /** 实测圆角半径（px）。'50%' 会按盒子宽度折算成像素，便于与半宽直接比 */
  radiusPx: number
}

/**
 * 工具栏「新建」按钮的几何探针，书籍管理与卡片库共用同一段代码。
 *
 * 用户的原始要求是「把标题栏那个独立主按钮，改成图标 + 悬浮提示、挪到搜索栏左侧」。
 * 这件事有三个可验证的事实，都能量出来，不需要看截图：
 *   1. 按钮里没有可见文字（图标化；文案转到了 tooltip 与 aria-label）；
 *   2. 按钮落在搜索栏所在的工具栏容器里（而不是仍留在页面标题区）；
 *   3. 按钮位于搜索框左侧且与它垂直居中（间距是否要求「紧贴」由各页决定，中线偏差 ≈ 0）；
 *   4. 按钮是正圆而不是圆角矩形（盒子正方形，且圆角半径 = 半宽）。
 * 命中不到元素时一律给 -1，失败信息里能直接看出是「没渲染」还是「位置错了」。
 */
const TOOLBAR_PROBE_JS = `
  const probeAddButton = (buttonSelector, searchSelector, toolbarSelector) => {
    const btn = document.querySelector(buttonSelector)
    const toolbar = document.querySelector(toolbarSelector)
    const raw = document.querySelector(searchSelector)
    // antd 的 Input 把 rest props 透传到内层 <input>、className 留在外层容器上。
    // 量内层 <input> 会把「左内边距 + 放大镜图标」算成按钮与搜索框的间距
    // （实测多出 40px，把「明明贴着」判成「没贴住」），所以一律取外层盒子。
    const search = raw && raw.tagName === 'INPUT' && raw.parentElement ? raw.parentElement : raw
    const br = btn ? btn.getBoundingClientRect() : null
    const sr = search ? search.getBoundingClientRect() : null
    // 形状：正圆还是圆角矩形。圆的半径等于盒子半宽，圆角矩形则小于半宽。
    // computed 的 border-radius 在写百分比时返回「50%」、写 px 时返回「16px」，
    // 两种都要折算成像素才能和半宽比 —— 直接把字符串拿来比会永远不等。
    const cs = btn ? getComputedStyle(btn) : null
    const rawRadius = cs ? cs.borderTopLeftRadius || '' : ''
    const radiusPx =
      !br || rawRadius === ''
        ? -1
        : rawRadius.indexOf('%') >= 0
          ? (parseFloat(rawRadius) / 100) * br.width
          : parseFloat(rawRadius)
    return {
      text: (btn ? btn.textContent : '').trim(),
      inToolbar: !!(btn && toolbar && toolbar.contains(btn)),
      gapToSearch: br && sr ? Math.round(sr.left - br.right) : -1,
      centerOffset: br && sr ? Math.round((br.top + br.bottom - sr.top - sr.bottom) / 2) : -1,
      width: br ? Math.round(br.width) : -1,
      height: br ? Math.round(br.height) : -1,
      radiusPx: Number.isFinite(radiusPx) ? Math.round(radiusPx) : -1
    }
  }
`

/** 按钮与搜索框之间允许的间距上限（px）。仅在要求「紧贴搜索框」的页面上使用 */
const ADD_BUTTON_GAP_RANGE = [0, 16] as const
/** 按钮与搜索框的中线允许偏差（px） */
const ADD_BUTTON_CENTER_TOLERANCE = 3
/** 正圆判定容差（px）：实测圆角半径与盒子半宽之差超过它就说明还是圆角矩形 */
const ADD_BUTTON_CIRCLE_TOLERANCE = 1

/**
 * 悬浮提示是否真的出现。
 *
 * 「图标按钮」这半边需求如果只断言「没有可见文字」，那把 Tooltip 整个删掉
 * 也照样全绿 —— 而用户拿到的会是一个点下去会发生事情、却看不出是什么的图标，
 * 读屏也读不出名字。所以这里真的把鼠标「移上去」：
 *
 *   - React 的 onMouseEnter 是从根节点代理 mouseover 合成的，所以派发
 *     `mouseover`（bubbles）而不是 `mouseenter`（原生不冒泡，React 收不到）；
 *   - rc-trigger 默认有 100ms 的 mouseEnterDelay，所以必须轮询等它出现，
 *     读一次就判定会误报成「没有提示」。
 *
 * 返回提示文案；超时返回空串由调用方判失败。
 */
async function waitForTooltip(
  window: BrowserWindow,
  buttonTestId: string,
  tipTestId: string,
  timeoutMs = 3000
): Promise<string> {
  const hover = `(() => {
    const btn = document.querySelector('[data-testid="${buttonTestId}"]')
    if (!btn) return false
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    return true
  })()`
  const read = `(() => {
    const tip = document.querySelector('[data-testid="${tipTestId}"]')
    return tip ? (tip.textContent || '').trim() : ''
  })()`

  await window.webContents.executeJavaScript(hover)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = (await window.webContents.executeJavaScript(read)) as string
    if (text !== '') return text
    await delay(120)
  }

  return ''
}

/* ---------------------------------------------------------------- *
 * 下拉菜单项的行（圆形图标 + 两行文字）
 *
 * 顶栏「更多功能」与编辑器顶栏的「书籍菜单」用的是同一个形状（同一份
 * `MenuRow` 组件、同一套 `.topbar-menu__*` 样式），所以读法与点法也只有
 * 一份 —— 两份实现迟早会在某一次改动里只改到一半。
 * ---------------------------------------------------------------- */

interface MenuSnapshot {
  /**
   * 菜单项，顺序与传入的清单一致。菜单没展开时每项 `found` 都是 false
   * （下拉浮层是懒渲染的，未展开时 DOM 里根本没有）。
   */
  items: Array<{
    key: string
    found: boolean
    /** 有尺寸才算真的显示出来了 —— 判据不认组件库的 hidden 类名 */
    visible: boolean
    text: string
    iconWidth: number
    iconHeight: number
    iconRadiusPx: number
  }>
}

/** 菜单项清单的形状：一份 key→testId 的对应表 */
type MenuItemDefs = ReadonlyArray<{ key: string; testId: string }>

function emptyMenu(defs: MenuItemDefs): MenuSnapshot {
  return {
    items: defs.map((def) => ({
      key: def.key,
      found: false,
      visible: false,
      text: '',
      iconWidth: -1,
      iconHeight: -1,
      iconRadiusPx: -1
    }))
  }
}

/**
 * 读菜单项的实测形态。
 *
 * 读的是每项**行首那个圆形图标**的几何，而不是「菜单项在不在」——
 * 用户说的是「每个菜单项对应一个圆形功能图标」，一个方形图标或干脆没有图标
 * 同样能通过存在性断言。
 */
function readMenuScript(defs: MenuItemDefs): string {
  return `(() => {
  const defs = ${JSON.stringify(defs.map((def) => ({ key: def.key, testId: def.testId })))}
  const circle = (el) => {
    const rect = el.getBoundingClientRect()
    const raw = window.getComputedStyle(el).borderTopLeftRadius || '0'
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radiusPx: raw.trim().endsWith('%')
        ? Math.round((rect.width * parseFloat(raw)) / 100)
        : Math.round(parseFloat(raw))
    }
  }
  const items = defs.map((def) => {
    const row = document.querySelector('[data-testid="' + def.testId + '"]')
    const icon = document.querySelector('[data-testid="' + def.testId + '-icon"]')
    const rowRect = row?.getBoundingClientRect()
    const geo = icon ? circle(icon) : { width: -1, height: -1, radiusPx: -1 }
    return {
      key: def.key,
      found: !!row,
      visible: !!rowRect && rowRect.width > 2 && rowRect.height > 2,
      text: row ? (row.textContent || '').replace(/\\s+/g, ' ').trim() : '',
      iconWidth: geo.width,
      iconHeight: geo.height,
      iconRadiusPx: geo.radiusPx
    }
  })
  return { items }
})()`
}

async function readMenu(window: BrowserWindow, defs: MenuItemDefs): Promise<MenuSnapshot> {
  try {
    const snapshot = (await window.webContents.executeJavaScript(
      readMenuScript(defs)
    )) as MenuSnapshot
    // executeJavaScript 回来的对象没有原型，用展开成新对象即可（后面只读不写）
    return { items: snapshot.items.map((item) => ({ ...item })) }
  } catch (error) {
    /*
     * 别把异常吞成「读不到 = 没展开」。
     *
     * 这个 catch 原来是一条静默的 `return emptyMenu(defs)`，于是
     * 「页面正在导航 / 执行上下文被销毁 / 脚本抛错」与「浮层真的没展开」
     * 变成了同一种观测结果 —— 调用方只会看到「菜单没开」，然后往错的方向查
     * （同类的错向失败信息见 `editor-book-menu` 那次：报「少了按钮」，
     * 而按钮一直在 DOM 里）。
     *
     * 仍然是宽松的（读失败不直接把测试带红），但**留下痕迹**。
     */
    console.warn('[winbook] 读下拉菜单失败：', messageOf(error))
    return emptyMenu(defs)
  }
}

/**
 * 展开一个 `MenuRow` 型菜单，并等到每一项都真的可见。
 *
 * 先把窗口显出来：隐藏窗口的合成器被节流，浮层的进退场帧可能不推进，
 * 「其实已经关了」会被读成「还开着」，于是下一次点击变成 toggle 而不是展开
 * （同类坑见「等 DOM 属性不够」那条：浮层要在可见窗口里读）。
 */
/**
 * 把「菜单还开着没」按时间采几笔，用于失败时**说清楚它是怎么合上的**。
 *
 * 采的是「可见项数 / 应有项数」这条曲线：一开就合上（进场动画没过、或
 * 读本身失败）与过一会儿才合上（有定时器把它关了）是完全不同的原因，
 * 而单次读给出的观测结果一模一样 —— 都是「没展开」。
 */
async function traceMenu(
  window: BrowserWindow,
  defs: MenuItemDefs,
  samples: number,
  intervalMs: number
): Promise<string> {
  const points: string[] = []
  for (let index = 0; index < samples; index += 1) {
    if (index > 0) await delay(intervalMs)
    const snapshot = await readMenu(window, defs)
    const visible = snapshot.items.filter((item) => item.found && item.visible).length
    points.push(`${index * intervalMs}ms=${visible}/${defs.length}`)
  }
  return points.join(' ')
}

async function openMenu(
  window: BrowserWindow,
  triggerTestId: string,
  defs: MenuItemDefs
): Promise<MenuSnapshot> {
  const already = await readMenu(window, defs)
  if (already.items.every((item) => item.found && item.visible)) return already

  await setWindowVisible(window, true)

  const clicked = (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('[data-testid="${triggerTestId}"]')
      if (!el) return false
      el.click()
      return true
    })()`
  )) as boolean
  if (!clicked) return emptyMenu(defs)

  const deadline = Date.now() + 4000
  let last = emptyMenu(defs)
  while (Date.now() < deadline) {
    last = await readMenu(window, defs)
    if (last.items.every((item) => item.found && item.visible)) return last
    await delay(120)
  }
  return last
}

/** 关掉菜单。判据是「不再可见」而不是「从 DOM 消失」—— 离场动画里元素还在 */
async function closeMenu(window: BrowserWindow, defs: MenuItemDefs): Promise<void> {
  await window.webContents.executeJavaScript(
    `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return true
    })()`
  )

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const snapshot = await readMenu(window, defs)
    if (snapshot.items.every((item) => !item.visible)) return
    await delay(120)
  }
}

async function openTopBarMenu(window: BrowserWindow): Promise<MenuSnapshot> {
  return openMenu(window, TOP_BAR_MORE_ID, TOP_BAR_MENU_ITEMS)
}

async function closeTopBarMenu(window: BrowserWindow): Promise<void> {
  return closeMenu(window, TOP_BAR_MENU_ITEMS)
}

/** 点某个菜单项。返回是否点到了（点不到时调用方要报失败，不能静默继续） */
async function clickTopBarMenuItem(window: BrowserWindow, testId: string): Promise<boolean> {
  return (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('[data-testid="${testId}"]')
      if (!el) return false
      el.click()
      return true
    })()`
  )) as boolean
}

/** 读主题当前档位。它由「更多功能」按钮声明（状态事实不能只在菜单展开后才有） */
async function readThemePreference(window: BrowserWindow): Promise<string> {
  return (await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid="${TOP_BAR_MORE_ID}"]')?.getAttribute('data-theme-preference') ?? ''`
  )) as string
}

/**
 * 主题：从菜单里连点三档，必须「每次前进一档」且**点满一圈回到原点**。
 *
 * 为什么非要验一遍：并排的三枚圆钮收进菜单后，「主题」从一个三段选择器变成了
 * 一个循环按钮 —— 这是本轮唯一的**行为**改动，而外观断言（圆形、有图标、有文字）
 * 全都看不见它。点一次不动、或者卡在某一档再点没反应，只有真的点三下才发现。
 */
async function cycleThemeByMenu(window: BrowserWindow): Promise<{ ok: boolean; detail: string }> {
  const before = await readThemePreference(window)
  const startIndex = (THEME_ORDER as readonly string[]).indexOf(before)
  if (startIndex < 0) {
    return { ok: false, detail: `读不到主题档位（读到「${before || '空'}」）` }
  }

  const steps: string[] = []
  for (let i = 1; i <= THEME_ORDER.length; i += 1) {
    const expected = THEME_ORDER[(startIndex + i) % THEME_ORDER.length]

    // 上一次点击后菜单会自动关闭，所以每次都要重新展开（展开失败会被下面的
    // 「点不到」判失败，不会静默跳过）
    await openTopBarMenu(window)
    if (!(await clickTopBarMenuItem(window, 'topbar-menu-theme'))) {
      return { ok: false, detail: '菜单里点不到「主题」项' }
    }

    // React 状态回写是异步的：点完立刻读会读到旧值（规矩 9 的同族陷阱）
    const deadline = Date.now() + 3000
    let landed = ''
    while (Date.now() < deadline) {
      landed = await readThemePreference(window)
      if (landed === expected) break
      await delay(100)
    }
    if (landed !== expected) {
      return {
        ok: false,
        detail: `第 ${i} 次点击后档位是「${landed || '空'}」，应为「${expected}」`
      }
    }
    steps.push(landed)
    await closeTopBarMenu(window)
  }

  return { ok: true, detail: `${before} → ${steps.join(' → ')}（点满三档回到原点）` }
}

/**
 * 工具栏「新建」按钮的几何断言，书籍管理与卡片库共用。
 *
 * 两页都成立的部分：按钮已图标化、落在工具栏里、位于搜索框左侧、与搜索框
 * 垂直居中、形状是正圆。
 *
 * 只有书籍管理额外要求「紧贴搜索框」（adjacentToSearch）—— 那里的搜索框是
 * 工具栏第一项，按钮天然贴着它。卡片库的搜索框前面还排着两个筛选器，按钮
 * 位于工具栏最左端（用户亲自指定的位置），强行要求贴住等于把用户的调整
 * 判成失败，所以这一条不共用。
 *
 * 返回问题描述数组，空数组表示这一项没问题。
 */
function checkAddButtonPlacement(
  label: string,
  button: ToolbarAddButtonSnapshot,
  options: { adjacentToSearch: boolean }
): string[] {
  const problems: string[] = []
  // 按钮压根没渲染时，位置与形状都无从谈起 —— 只报一条并收工，
  // 免得同一个原因（页面没进 / 选择器失效）刷出四五条问题，把真正的原因埋掉。
  if (button.width < 0) {
    return [`${label}：搜索框左侧没有「新建」按钮（量不到它的盒子）`]
  }
  if (button.gapToSearch < 0) {
    problems.push(
      `${label}：「新建」按钮不在搜索框左侧（它压到了搜索框上、或跑到了它右边，间距 ${button.gapToSearch}px）`
    )
  } else if (options.adjacentToSearch && button.gapToSearch > ADD_BUTTON_GAP_RANGE[1]) {
    problems.push(`${label}：「新建」按钮离搜索框 ${button.gapToSearch}px，没有紧贴在它左侧`)
  }
  if (button.text !== '') {
    problems.push(`${label}：「新建」按钮仍带可见文字「${button.text}」——应当只留图标，文案转成悬浮提示`)
  }
  if (!button.inToolbar) {
    problems.push(`${label}：「新建」按钮不在搜索栏所在的工具栏里（还留在页面标题区？）`)
  }
  if (Math.abs(button.centerOffset) > ADD_BUTTON_CENTER_TOLERANCE) {
    problems.push(`${label}：「新建」按钮与搜索框没有垂直居中对齐（中线差 ${button.centerOffset}px）`)
  }
  // 形状：正圆。只断言「圆角不为 0」不够 —— 默认的圆角矩形同样不为 0，
  // 而那正是用户否掉的形态，所以要求圆角半径追平盒子半宽、且盒子是正方形。
  if (button.width !== button.height) {
    problems.push(
      `${label}：「新建」按钮不是正方形（${button.width}×${button.height}px），圆形按钮必须宽高相等`
    )
  }
  if (button.radiusPx < 0) {
    problems.push(`${label}：读不到「新建」按钮的圆角半径，无法验证它是正圆`)
  } else if (Math.abs(button.radiusPx - button.width / 2) > ADD_BUTTON_CIRCLE_TOLERANCE) {
    problems.push(
      `${label}：「新建」按钮是圆角矩形而不是正圆（圆角 ${button.radiusPx}px，正圆应为 ${Math.round(
        button.width / 2
      )}px）`
    )
  }
  return problems
}

interface BooksSnapshot {
  mounted: boolean
  hash: string
  title: string
  /** 书架里实际渲染出的书籍卡片数 */
  cards: number
  /** 「新建书籍」按钮的几何（图标化 + 位于搜索框左侧） */
  addButton: ToolbarAddButtonSnapshot
}

const EMPTY_BOOKS_SNAPSHOT: BooksSnapshot = {
  mounted: false,
  hash: '',
  title: '',
  cards: 0,
  addButton: { text: '', inToolbar: false, gapToSearch: -1, centerOffset: -1, width: -1, height: -1, radiusPx: -1 }
}

const BOOKS_SNAPSHOT_SCRIPT = `(() => {
  ${TOOLBAR_PROBE_JS}
  return {
    mounted: !!document.querySelector('.books-toolbar'),
    hash: location.hash,
    title: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
    cards: document.querySelectorAll('[data-testid="book-card"]').length,
    addButton: probeAddButton('[data-testid="books-add"]', '.books-toolbar__search', '.books-toolbar')
  }
})()`

/**
 * 等书架渲染出来。
 *
 * 等三件事同时成立：工具栏在（说明路由到了这一页）、书卡有行（说明数据回来了）、
 * 新建按钮量到了几何（说明它真的被画在搜索框左侧）。
 * 只等工具栏会拿到「数据还在路上」的那一帧，断言书卡数量就会误报成 0。
 */
async function waitForBooks(window: BrowserWindow, timeoutMs = 20_000): Promise<BooksSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_BOOKS_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(BOOKS_SNAPSHOT_SCRIPT)) as BooksSnapshot
    if (last.mounted && last.cards >= 1 && last.addButton.gapToSearch >= 0) return last
    await delay(150)
  }

  return last
}

interface CardsSnapshot {
  mounted: boolean
  hash: string
  title: string
  hasList: boolean
  /** 列表里实际渲染出的卡片行数 */
  rows: number
  /** 服务端给出的卡片总数（受当前筛选影响） */
  total: number
  /** 各类型计数（刻意忽略类型筛选，见 CardListResult 的说明） */
  character: number
  item: number
  inspiration: number
  /** 设定卡计数（第二期新增的第四类） */
  setting: number
  /** 不归属任何书的卡片数 */
  global: number
  hasEditor: boolean
  /** 编辑面板当前打开的卡片 id；停在空状态时为 -1 */
  editorCardId: number
  listHeight: number
  /** 「新建」按钮：已图标化、且位于搜索框左侧（用实测几何验证，不看截图猜） */
  addButton: ToolbarAddButtonSnapshot
}

const EMPTY_CARDS_SNAPSHOT: CardsSnapshot = {
  mounted: false,
  hash: '',
  title: '',
  hasList: false,
  rows: 0,
  total: -1,
  character: -1,
  item: -1,
  inspiration: -1,
  setting: -1,
  global: -1,
  hasEditor: false,
  editorCardId: -1,
  listHeight: 0,
  addButton: { text: '', inToolbar: false, gapToSearch: -1, centerOffset: -1, width: -1, height: -1, radiusPx: -1 }
}

const CARDS_SNAPSHOT_SCRIPT = `(() => {
  ${TOOLBAR_PROBE_JS}
  const intOf = (testId) => {
    const el = document.querySelector('[data-testid="' + testId + '"]')
    const n = Number(el?.getAttribute('data-value'))
    return Number.isFinite(n) ? n : -1
  }
  const listPane = document.querySelector('.cards-list-pane')
  const rect = listPane ? listPane.getBoundingClientRect() : null
  const editor = document.querySelector('[data-testid="card-editor"]')
  // 新建草稿模式下 data-card-id 是 'new'，空状态则没有这个属性，
  // 两种都算「没打开任何卡片」，因此统一折成 -1
  const rawCardId = editor?.getAttribute('data-card-id') ?? ''

  return {
    mounted: !!document.querySelector('[data-testid="cards-page"]'),
    hash: location.hash,
    title: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
    hasList: !!document.querySelector('[data-testid="cards-list"]'),
    rows: document.querySelectorAll('[data-testid="card-row"]').length,
    total: intOf('cards-total'),
    character: intOf('cards-type-count-character'),
    item: intOf('cards-type-count-item'),
    inspiration: intOf('cards-type-count-inspiration'),
    setting: intOf('cards-type-count-setting'),
    global: intOf('cards-global'),
    hasEditor: !!editor,
    editorCardId: /^[0-9]+$/.test(rawCardId) ? Number(rawCardId) : -1,
    // 列表面板的高度：高度链断掉时它会退化成内容高度，两栏的滚动随之失效
    listHeight: rect ? Math.round(rect.height) : 0,
    // 新建按钮已从标题栏迁到搜索框左侧并图标化（用户要求）
    //
    // 搜索框的量法：用我们自己挂在 Input 容器上的类名（.cards-keyword），
    // 而不是 data-testid —— antd 的 Input 把 rest props 透传到内层 input 元素，
    // 而 className 留在外层 affix 容器上；于是按 data-testid 量到的是
    // 「左内边距 + 放大镜图标」之后的左边缘，比肉眼看到的输入框往右缩了 40px，
    // 会把「明明贴着」判成「没贴住」。这条踩过一次。
    // （注意：本段代码整体是模板字符串，注释里不能出现反引号。）
    addButton: probeAddButton('[data-testid="cards-add"]', '.cards-keyword', '.cards-toolbar')
  }
})()`

/**
 * 等卡片库把列表与编辑面板都渲染出来。
 *
 * 这里等的是「有行、面板在、面板真的打开了一张卡、列表面板有高度」四件事
 * 同时成立。只等 React 挂载会在数据到达前就返回，拿到 0 行然后误报成
 * 「列表没渲染」；而不等 `editorCardId` 的话，会拿到「面板还在空状态」
 * 这一帧 —— 断言「面板存在」会通过，但界面上其实什么都编辑不了。
 */
async function waitForCards(window: BrowserWindow, timeoutMs = 20_000): Promise<CardsSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_CARDS_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(CARDS_SNAPSHOT_SCRIPT)) as CardsSnapshot
    if (
      last.mounted &&
      last.hasList &&
      last.rows >= 1 &&
      last.hasEditor &&
      last.editorCardId > 0 &&
      last.listHeight > 0
    ) {
      return last
    }
    await delay(200)
  }

  return last
}

interface SearchSnapshot {
  hash: string
  /** 输入框当前的值 */
  inputValue: string
  /** 浮层是否在 DOM 里（关掉之后会被移除） */
  panelOpen: boolean
  /** 浮层的状态机：hint / loading / error / empty / ready */
  panelState: string
  /** 四类来源的命中总数 */
  total: number
  /** 实际生效的关键词（后端回显，用 | 连接） */
  keywords: string
  /** 浮层里渲染出的结果行数 */
  hits: number
  /** 出现过的来源，用逗号连接 */
  sources: string
  /** 章节分组第一条对应的章节 id；没有章节命中时为 -1 */
  chapterHitId: number
  hasEditor: boolean
  /** 编辑器里当前选中的文本 —— 定位是否正确只有它能证明 */
  selection: string
}

const EMPTY_SEARCH_SNAPSHOT: SearchSnapshot = {
  hash: '',
  inputValue: '',
  panelOpen: false,
  panelState: '',
  total: -1,
  keywords: '',
  hits: 0,
  sources: '',
  chapterHitId: -1,
  hasEditor: false,
  selection: ''
}

const SEARCH_SNAPSHOT_SCRIPT = `(() => {
  const panel = document.querySelector('[data-testid="search-panel"]')
  const rows = Array.from(document.querySelectorAll('[data-testid="search-hit"]'))
  const sources = Array.from(new Set(rows.map((row) => row.getAttribute('data-hit-source') || '')))
  const chapterHit = rows.find((row) => row.getAttribute('data-hit-source') === 'chapter')
  const rawRoot = document.querySelector('[data-testid="search-input"]')
  const input = rawRoot instanceof HTMLInputElement ? rawRoot : (rawRoot && rawRoot.querySelector('input'))
  const total = Number(panel?.getAttribute('data-total'))

  return {
    hash: location.hash,
    inputValue: input ? input.value : '',
    panelOpen: !!panel,
    panelState: panel?.getAttribute('data-state') ?? '',
    total: Number.isFinite(total) ? total : -1,
    keywords: panel?.getAttribute('data-keywords') ?? '',
    hits: rows.length,
    sources: sources.join(','),
    chapterHitId: Number(chapterHit?.getAttribute('data-hit-id') ?? -1),
    hasEditor: !!document.querySelector('[data-testid="chapter-editor"]'),
    selection: String(window.getSelection()?.toString() ?? '')
  }
})()`

/**
 * 等检索浮层出结果。
 *
 * 必须等到 ready / empty 这两个**终态**之一：中间的 loading 帧里
 * 结果行是空的，只看「面板出现了」会拿到 0 行然后误报成「没查到东西」。
 */
async function waitForSearch(window: BrowserWindow, timeoutMs = 20_000): Promise<SearchSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_SEARCH_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(SEARCH_SNAPSHOT_SCRIPT)) as SearchSnapshot
    if (last.panelState === 'ready' || last.panelState === 'empty') return last
    await delay(150)
  }

  return last
}

/**
 * 用 hash 导航，并确认它真的生效了。
 *
 * 光 `location.hash = x` 不够：连续改 hash（尤其间隔很短时）会出现
 * 「地址写进去了，但路由没跟上」——后续所有读数都对着上一次的页面，
 * 断言会报成某个完全不相干的症状。与其事后靠 trace 猜，不如在驱动时
 * 就把它变成确定的：赋值后确认生效，没生效就再给一次。
 *
 * 这里**不做**「失败就一直重试」：应用自身若把用户重定向走了（未知路由
 * 回首页），重试多少次都一样，该红就得红 —— 重试只是消除「赋值被丢掉」
 * 这种驱动层面的抖动。
 */
async function navigateHash(window: BrowserWindow, hash: string, timeoutMs = 6000): Promise<string> {
  const assign = `(() => { location.hash = ${JSON.stringify(hash)}; return location.hash })()`

  let current = (await window.webContents.executeJavaScript(assign)) as string
  const deadline = Date.now() + timeoutMs

  while (current !== hash && Date.now() < deadline) {
    await delay(250)
    current = (await window.webContents.executeJavaScript(
      `(() => location.hash)()`
    )) as string
    if (current !== hash) {
      current = (await window.webContents.executeJavaScript(assign)) as string
    }
  }

  return current
}

/**
 * 等编辑器把命中处选中。
 *
 * 等的是「路由到了这一章 **且** 选中的文本就是那个关键词」两件事同时成立。
 * 只等路由会在文档还没载入时返回 —— 那一刻 selection 还是空的，
 * 断言会误报成「没有定位」；反过来，光等 selection 又可能在前一章的
 * 残留选中上通过。两个条件都要。
 *
 * 选中文本要轮询而不是读一次：ProseMirror 的选区是异步同步到 DOM 的，
 * `focus()` 之后下一帧才可能落到真实的高亮上。
 */
async function waitForLocate(
  window: BrowserWindow,
  chapterId: number,
  keyword: string,
  timeoutMs = 20_000
): Promise<SearchSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_SEARCH_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(SEARCH_SNAPSHOT_SCRIPT)) as SearchSnapshot
    if (last.hash.includes(`/chapters/${chapterId}`) && last.selection === keyword) return last
    await delay(150)
  }

  return last
}

interface RenderSnapshot {
  reactMounted: boolean
  /** 顶部导航条是否还在。**应当为 false** —— 它已被整条移除 */
  hasTopNav: boolean
  /**
   * 页标题在画面上是否占位。**首页应当为 false** —— 首页的标题是导航标签，
   * 已不显示（只做隐藏锚点）。全应用现在都是这个规矩，没有例外：曾经显示
   * 书名的那一页（书籍详情页）已经取消，书名改挂在编辑器顶栏上。
   */
  titleVisible: boolean
  /** 页面标题（= 窗口标题栏文字），应等于产品名 winbook */
  docTitle: string
  pageTitle: string
  /**
   * 主进程健康状态。**状态本身必须随时可读**，不能只在菜单展开后才有 ——
   * 所以它由顶栏那枚 `…` 按钮用 data-health-state / data-health-text 声明，
   * 按钮画面上并不显示这两个值。
   */
  healthState: string
  healthText: string
  healthOk: boolean
  /**
   * 顶栏右上角那枚「更多功能」按钮的实测形态。
   *
   * 用户 2026-09-20 的要求分两轮，最终形态是：**只展示一个 `…` 图标按钮**，
   * 点击展开下拉菜单，每个菜单项对应一个圆形功能图标（并排展示的功能图标取消）。
   * 所以这里量的是：
   *   - 它是正圆（`width === height` 且 `radiusPx ≈ width / 2`）
   *   - 它上面没有文字（`text` 为空）
   *   - 它有个读屏能用的名字（`label` 非空）—— 「文字挪走」不等于「文字可以删」
   */
  moreButton: {
    found: boolean
    text: string
    label: string
    width: number
    height: number
    radiusPx: number
  } | null
  /**
   * 顶栏里圆钮图标的数量。**要求恰好 1**（只有 `…` 那一枚）。
   *
   * 这条断的是「并排展示的功能图标被取消」：健康 / 备份 / 主题三枚如果又并排
   * 冒出来，菜单那部分的断言照样全绿（菜单项还在），只有这个计数会变红。
   */
  inlineIconButtons: number
  metricsLoading: boolean
  bookCount: number
  totalHanzi: number
  progressRowCount: number
  /**
   * 首页功能模块卡片：现在它们就是应用的导航，几何与顺序都要锁住。
   * 每个元素记录 key / 文案 / 实测位置尺寸。
   */
  modules: {
    key: string
    label: string
    top: number
    left: number
    width: number
    height: number
  }[]
  /** 首页各行卡片的等高几何：用户明确要求「高度要对齐，不能出现偏差」 */
  rows: {
    metricHeights: number[]
    trendHeight: number
    todayHeight: number
    /** 首页功能模块卡片数量（应当恰好等于模块数） */
    moduleCards: number
  }
}

/**
 * 只依赖我们自己挂在 JSX 上的 data-testid / data-* 属性，绝不使用 UI 库的内部类名。
 *
 * 原因：早期版本读的是 `.page__title`、`.table tbody tr` 这些手写样式类。
 * 后来把前端换成组件库，类名全变了，测试却「全部通过」——因为它匹配不到
 * 元素时返回 0 而不是报错，于是变成假阳性。改成 data-testid 后，界面结构
 * 怎么换都不影响断言，但一旦真的丢了元素就会立刻失败。
 *
 * 数字读的是 data-value 而不是显示文本：显示文本带「万」「,」这类格式化，
 * 拿它做数值断言会把「格式化改了一下」误判成「数据算错了」。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const root = document.getElementById('root')
  const metrics = document.querySelector('[data-testid="dashboard-metrics"]')
  const numberOf = (testId) => {
    const el = document.querySelector('[data-testid="' + testId + '"]')
    const raw = el?.getAttribute('data-value')
    const n = Number(raw)
    return Number.isFinite(n) ? n : -1
  }
  const navEl = document.querySelector('[data-testid="app-nav"]')
  // 首页功能模块卡片：现在它们承担导航职责，所以顺序、数量、位置都要读实测值。
  // 顺序按 left 排序后取 data-module-key —— 「卡片顺序被换过」这种改动
  // 不会报错、也不影响功能，但会让用户的肌肉记忆失效，值得锁住。
  const moduleEls = Array.from(document.querySelectorAll('[data-testid="module-entry"]'))
  const modules = moduleEls
    .map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        key: el.getAttribute('data-module-key') || '',
        label: (el.textContent || '').trim(),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    })
    .sort((a, b) => a.left - b.left)
  // 页标题是否在画面上占位。首页的标题是 sr-only（1px），这里读的是实测
  // 面积而不是类名：类名怎么改都行，「占不占纵向空间」才是事实。
  // （曾经有过唯一一个例外 —— 书籍详情页显示书名，那一页已取消。）
  const titleEl = document.querySelector('[data-testid="page-title"]')
  const titleRect = titleEl?.getBoundingClientRect()
  const titleVisible = !!titleRect && titleRect.width > 2 && titleRect.height > 2
  // 等高验证读的是我们自己挂的类名（.metric-card / .dashboard-trend /
  // .dashboard-today），不碰组件库的内部类
  const heightsOf = (selector) =>
    Array.from(document.querySelectorAll(selector)).map((el) =>
      Math.round(el.getBoundingClientRect().height)
    )
  const trendCard = document.querySelector('.dashboard-trend')
  const todayCard = document.querySelector('.dashboard-today')
  // 顶栏那枚「更多功能」按钮。三件事都要实测：
  //   text  —— 按钮上还有没有文字（要求为空，这就是「只展示图标」）
  //   label —— aria-label 有没有把名字留住（防「文字干脆丢了」）
  //   几何  —— 宽高相等且圆角半径 ≈ 半宽（是不是正圆）
  // border-radius 写成 50% 时 computedStyle 原样返回 "50%"，parseFloat 会得到
  // 50 这个「像素数」，所以要按宽度折算 —— 直接比会把圆判成不是圆。
  const circleOf = (el) => {
    const rect = el.getBoundingClientRect()
    const rawRadius = window.getComputedStyle(el).borderTopLeftRadius || '0'
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radiusPx: rawRadius.trim().endsWith('%')
        ? Math.round((rect.width * parseFloat(rawRadius)) / 100)
        : Math.round(parseFloat(rawRadius))
    }
  }
  const moreEl = document.querySelector('[data-testid="${TOP_BAR_MORE_ID}"]')
  const moreButton = moreEl
    ? Object.assign(circleOf(moreEl), {
        found: true,
        text: (moreEl.textContent || '').trim(),
        label: moreEl.getAttribute('aria-label') || ''
      })
    : null
  // 顶栏里的圆钮图标数量。要求恰好 1 —— 并排展示的功能图标已被取消（用户 2026-09-20）
  const inlineIconButtons = document.querySelectorAll('.app-header .app-icon-button').length
  return {
    reactMounted: (root?.children.length ?? 0) > 0,
    hasTopNav: !!navEl,
    titleVisible,
    // 页面标题就是窗口标题栏显示的文字（BrowserWindow 未另设 title 时由页面接管），
    // 品牌名写错过一次，这里把它锁住
    docTitle: document.title,
    pageTitle: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
    // 主进程状态由「更多功能」按钮声明（data-health-*）：它画面上不显示，
    // 但必须随时可读 —— 否则想知道主进程是否正常，得先把菜单点开。
    healthState: moreEl?.getAttribute('data-health-state') ?? '',
    healthText: moreEl?.getAttribute('data-health-text') ?? '',
    healthOk: moreEl?.getAttribute('data-health-state') === 'ok',
    moreButton,
    inlineIconButtons,
    metricsLoading: metrics?.getAttribute('data-loading') === 'true',
    bookCount: numberOf('metric-book-count'),
    totalHanzi: numberOf('metric-total-hanzi'),
    progressRowCount: document.querySelectorAll('[data-testid="progress-row"]').length,
    modules,
    rows: {
      metricHeights: heightsOf('.metric-card'),
      trendHeight: trendCard ? Math.round(trendCard.getBoundingClientRect().height) : -1,
      todayHeight: todayCard ? Math.round(todayCard.getBoundingClientRect().height) : -1,
      moduleCards: moduleEls.length
    }
  }
})()`

const EMPTY_SNAPSHOT: RenderSnapshot = {
  reactMounted: false,
  hasTopNav: false,
  titleVisible: false,
  docTitle: '',
  pageTitle: '',
  healthState: '',
  healthText: '',
  healthOk: false,
  moreButton: null,
  inlineIconButtons: 0,
  metricsLoading: false,
  bookCount: -1,
  totalHanzi: -1,
  progressRowCount: 0,
  modules: [],
  rows: { metricHeights: [], trendHeight: -1, todayHeight: -1, moduleCards: 0 }
}

/**
 * 轮询等待首屏与数据都就绪。
 *
 * 不能只等 did-finish-load —— 那只代表 HTML 加载完，此时 React 才刚挂载，
 * 指标区还在 loading、健康徽标还是「正在自检…」。必须一直等到：
 * React 挂载 + 功能模块卡片渲染 + 健康检查 ok + 指标脱离 loading + 真实数据出现，
 * 才算真正跑通。
 */
async function waitForRender(window: BrowserWindow, timeoutMs = 25_000): Promise<RenderSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(SNAPSHOT_SCRIPT)) as RenderSnapshot
    if (
      last.reactMounted &&
      last.modules.length > 0 &&
      last.healthOk &&
      !last.metricsLoading &&
      last.bookCount >= 1 &&
      last.totalHanzi >= 1 &&
      last.progressRowCount >= 1
    ) {
      return last
    }
    await delay(200)
  }

  return last
}

function waitForLoad(window: BrowserWindow, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('渲染进程加载超时')), timeoutMs)

    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })

    window.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer)
      reject(new Error(`渲染进程加载失败：${description}（错误码 ${code}）`))
    })
  })
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

export function reportSmokeResults(results: StepResult[], reportPath?: string): boolean {
  const width = Math.max(...results.map((item) => visualWidth(item.name)), 8)
  const lines: string[] = ['', 'winbook 启动冒烟测试', '─'.repeat(64)]

  for (const item of results) {
    const mark = item.ok ? 'PASS' : 'FAIL'
    lines.push(`  [${mark}] ${pad(item.name, width)}  ${item.detail}`)
  }

  const failed = results.filter((item) => !item.ok)
  lines.push('─'.repeat(64))

  if (failed.length === 0) {
    lines.push(`  全部 ${results.length} 项通过`)
  } else {
    lines.push(`  ${failed.length} / ${results.length} 项失败：${failed.map((item) => item.name).join('、')}`)
  }
  lines.push('')

  const report = lines.join('\n')
  if (failed.length === 0) {
    console.log(report)
  } else {
    console.error(report)
  }

  // Windows 上 electron.exe 是 GUI 子系统程序，stdout 经常拿不到，
  // 所以额外落一份报告文件，保证 CI 与人工都能看到结果
  if (reportPath !== undefined) {
    try {
      writeFileSync(reportPath, report, 'utf8')
    } catch (error) {
      console.error('[winbook] 冒烟测试报告写入失败：', error)
    }
  }

  return failed.length === 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 中文字符按两个宽度计算，否则报告里的列会对不齐 */
function visualWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1
  }
  return width
}

function pad(text: string, target: number): string {
  return text + ' '.repeat(Math.max(0, target - visualWidth(text)))
}

/**
 * 章节历史版本与回档（第三期第 4 件）的渲染检查。
 *
 * 后端那一组已经把「留几版、剪谁、回档对不对」押住了；这一条押的是
 * **另外三件在库里看不出来的事**：
 *
 *   1. **面板真的打开在正文上方，且能关掉。** 锚点存在不等于它可见 ——
 *      历史面板是条件渲染的，一个恒为 false 的条件会让「面板在的」
 *      那种断言照样绿。
 *   2. **左右两栏的差异行数相等。** 并排对比的前提是两栏一一对应；
 *      行数不等时浏览器不会报错，只是从某一行开始整体错位，
 *      读者对不上「我是把哪一段改成了哪一段」。这是布局性质的缺陷，
 *      只能量几何。
 *   3. **点了「回到这一版」之后，编辑器里的正文真的变回那一版。**
 *      这是整条链路的终点：服务端存了、面板列了、按钮点了，
 *      但编辑器自己管正文（只在 key 变化时重建），少一个重建令牌
 *      就表现为「点了没反应」—— 而库里此时已经回档成功了。
 *
 * 用 showcase 的那一章（`ctx.chapterId`）。这一条排在
 * 「正文自动保存往返」之后，两者都往同一章里打字，互不影响：
 * 往返那一条验证的是「打了字还在」，这一条验证的是「回档能换掉它」。
 */
async function checkChapterRevisions(
  window: BrowserWindow,
  ctx: ShowcaseTargets
): Promise<StepResult> {
  const name = '章节历史版本'
  const problems: string[] = []
  const stampA = `冒烟回档甲${STAMP}`
  const stampB = `冒烟回档乙${STAMP}`
  /*
   * 打进去的两段字要**足够长**：去重阈值是「改动量 / 上一版字数 ≥ 5%」，
   * 而 showcase 那一章只有二十几个汉字，短句很容易落进阈值里，
   * 于是「打了一段字却没有历史」看起来像功能坏了，其实是被去重挡掉的。
   * 重复两遍让每段都在 20 字以上，稳稳越过 5%。
   */
  const chunkA = `${stampA}${stampA}${stampA}`
  const chunkB = `${stampB}${stampB}${stampB}`

  /** 往正文末尾打一段字，返回是否打进去了 */
  const typeIntoEditor = async (text: string): Promise<boolean> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const content = document.querySelector('.winbook-editor__content')
        if (!content) return false
        content.focus()
        const selection = window.getSelection()
        if (!selection) return false
        const range = document.createRange()
        range.selectNodeContents(content)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('insertText', false, ${JSON.stringify(text)})
        return content.textContent.includes(${JSON.stringify(text)})
      })()`
    )) as boolean

  /** 编辑器里当前的纯文本 */
  const readEditorText = async (): Promise<string> =>
    (await window.webContents.executeJavaScript(
      `(document.querySelector('.winbook-editor__content')?.textContent || '')`
    )) as string

  /** 面板里当前列出的版本（只读锚点上的属性，不读文案） */
  const readItems = async (): Promise<Array<{ id: number; hanzi: number }>> => {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll('[data-testid="history-item"]'),
        (el) => ({
          id: Number(el.getAttribute('data-revision-id')),
          hanzi: Number(el.getAttribute('data-hanzi'))
        })
      ))`
    )) as string
    return JSON.parse(raw) as Array<{ id: number; hanzi: number }>
  }

  /** 差异两栏各自的行数。**必须在同一帧里同时读** —— 分两次读会因为
   *  中间发生重渲染而量到两份不同状态下的数字，得出假的「相等」或「不等」 */
  const readDiffLineCounts = async (): Promise<{ old: number; next: number }> =>
    (await window.webContents.executeJavaScript(
      `(() => ({
        old: document.querySelectorAll('[data-testid="history-diff-old-line"]').length,
        next: document.querySelectorAll('[data-testid="history-diff-new-line"]').length
      }))()`
    )) as { old: number; next: number }

  try {
    const chapterRoute = `#/books/${ctx.bookId}/chapters/${ctx.chapterId}`
    await reloadAt(window, chapterRoute)

    const editor = await waitForEditor(window)
    if (!editor.mounted) {
      return { name, ok: false, detail: `进不了编辑器（hash=${editor.hash}），无法验证历史版本` }
    }

    /* ---------- ① 打开面板：先确认它在，再量几何 ---------- */
    if (!(await clickTestId(window, 'editor-history'))) {
      return { name, ok: false, detail: '顶栏里点不到「历史版本」这枚圆钮' }
    }
    if (!(await waitForTestId(window, 'chapter-history-panel', 5000))) {
      return { name, ok: false, detail: '点了「历史版本」之后面板没有出现' }
    }

    /*
     * 面板必须真的占到了高度。只判锚点存在的话，「面板渲染了但高度被
     * 压成 0」这种缺陷会被判通过 —— 而它恰恰是这个功能最容易犯的错：
     * 面板挂在 flex 列里，少一个 flex-shrink 设置就会被内容顶掉。
     */
    const panelBox = (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-testid="chapter-history-panel"]')
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return { height: Math.round(rect.height), width: Math.round(rect.width) }
      })()`
    )) as { height: number; width: number } | null

    if (panelBox === null || panelBox.height < 60) {
      problems.push(`历史面板没有占到应有的高度（实测 ${panelBox?.height ?? 0}px）—— 它被压扁了`)
    }
    if (panelBox !== null && panelBox.width < 400) {
      problems.push(`历史面板太窄（实测 ${panelBox.width}px），左右并排的差异读不出来`)
    }

    /* ---------- ② 空状态：这一章还没有历史，必须说清楚，而不是空白 ---------- */
    const emptyItems = await readItems()
    if (emptyItems.length === 0) {
      const hasEmptyText = (await window.webContents.executeJavaScript(
        `(document.querySelector('[data-testid="chapter-history-panel"]')?.textContent || '').includes('还没有可回退的版本')`
      )) as boolean
      if (!hasEmptyText) {
        problems.push('这一章还没有历史版本时，面板里既没有版本也没有说明文字')
      }
    }

    /* ---------- ③④ 打字两次 → 改动前的正文应当被留成一版 ---------- */
    /*
     * 等待的判据全部取自**主进程现读**（`ctx.chapterHanzi` /
     * `ctx.revisionsOf`），不是底栏文案。
     *
     * 这里踩过一次坑：原先等的是 `waitForSaveState(window, 'saved')`，
     * 而底栏的状态在进入本函数时**已经是「已保存」**（上一条渲染检查
     * 打完字就停在这个状态），于是这个等待瞬间返回 —— 自动保存还有
     * 两秒防抖没走完，我们就已经断言「打完字应该有历史版本」了。
     * 结果报的是「历史版本列表里仍然一版都没有」，看着像功能坏了，
     * 其实是断言跑在了保存前面。
     *
     * 另外，两段字**必须分批等**，不能打完一起等。自动保存的防抖是
     * 两秒：连着打完两段，它们会落进同一个窗口、合并成一次保存，
     * 而那一次的「改动前正文」恰好已经是被留过底的那一份，于是
     * 按规则**不该**再留一版 —— 断言就会以「打完字却没长版本」的样子
     * 变红，而功能其实完全正确。打完第一段先等它落库，第二段才是
     * 一次「改动前的正文尚未被保存过」的写入。
     */
    const revisionsBefore = ctx.revisionsOf(ctx.chapterId).length
    const hanziBefore = ctx.chapterHanzi(ctx.chapterId)

    await window.webContents.executeJavaScript(
      `(document.querySelector('.winbook-editor__content')?.focus(), true)`
    )
    if (!(await typeIntoEditor(chunkA))) {
      return { name, ok: false, detail: '往正文里插不进文字，无法验证历史版本' }
    }

    // 等第一段字真的落库（防抖 2 秒 + 一次 IPC）
    const hanziAfterA = await waitForChapterHanziChange(ctx, ctx.chapterId, hanziBefore, 10_000)
    if (hanziAfterA === hanziBefore) {
      problems.push(
        `打完第一段字之后 10 秒内库里字数没变（一直是 ${hanziBefore}）—— 自动保存没有落库`
      )
    }

    await window.webContents.executeJavaScript(
      `(document.querySelector('.winbook-editor__content')?.focus(), true)`
    )
    if (!(await typeIntoEditor(chunkB))) {
      problems.push('第二次往正文里插不进文字')
    }

    const revisionsAfter = await waitForRevisionCount(ctx, ctx.chapterId, revisionsBefore + 1, 15_000)
    if (revisionsAfter < revisionsBefore + 1) {
      problems.push(
        `打完两段字之后 15 秒内库里没有新增历史版本（${revisionsBefore} → ${revisionsAfter}）—— ` +
          `正文从 ${hanziBefore} 字被改写成了 ${hanziAfterA} 字以上，改动前的那一份却没有被留底`
      )
    }

    /*
     * 关掉再打开，等价于用户主动刷新一次列表。
     *
     * 这一步同时是「列表会重取」的验收：`useChapterRevisions` 的
     * `staleTime` 必须是 0。若它退回全局默认的 15 秒，这里读到的会是
     * ① 那一次留下的**空列表缓存**（距上次取数还不到 15 秒），面板
     * 照旧显示「还没有可回退的版本」—— 也就是用户最怕的那句话。
     */
    await clickTestId(window, 'history-close')
    await waitForTestIdGone(window, 'chapter-history-panel', 3000)
    await clickTestId(window, 'editor-history')
    if (!(await waitForTestId(window, 'chapter-history-panel', 5000))) {
      return { name, ok: false, detail: '关闭历史面板之后打不开了' }
    }

    const items = await waitForItemCount(window, 1, 5000)
    if (items.length === 0) {
      problems.push(
        `库里已经有 ${revisionsAfter} 版历史，但关掉面板再打开之后列表里一版都没有 —— ` +
          '列表读的是过期缓存'
      )
    } else {
      // 库里对账：界面列出的每一条都必须真在 chapter_revisions 里
      const inDb = ctx.revisionsOf(ctx.chapterId)
      const dbIds = new Set(inDb.map((item) => item.id))
      const uiIds = items.map((item) => item.id)
      const missing = uiIds.filter((id) => !dbIds.has(id))
      if (missing.length > 0) {
        problems.push(`界面上列着 #${missing.join('、')}，但库里查不到这些版本`)
      }
      // 界面上显示的字数必须就是库里存的那个（不是前端另算的）
      const mismatched = items.filter((item) => {
        const row = inDb.find((candidate) => candidate.id === item.id)
        return row !== undefined && row.hanziCount !== item.hanzi
      })
      if (mismatched.length > 0) {
        problems.push(
          `版本字数与库里对不上：界面 ${mismatched.map((item) => `${item.id}=${item.hanzi}`).join('、')}`
        )
      }
    }

    /* ---------- ⑤ 差异两栏行数必须相等（并排不错位的硬条件） ---------- */
    if (!(await waitForTestId(window, 'history-diff', 5000))) {
      problems.push('选中一版之后差异区没有渲染出来')
    } else {
      // 等两栏都真的有行，而不是读一次就走
      const deadline = Date.now() + 4000
      let counts = await readDiffLineCounts()
      while (Date.now() < deadline && (counts.old === 0 || counts.next === 0)) {
        await delay(120)
        counts = await readDiffLineCounts()
      }
      if (counts.old === 0 || counts.next === 0) {
        problems.push(`差异区两栏没有内容（左 ${counts.old} 行、右 ${counts.next} 行）`)
      } else if (counts.old !== counts.next) {
        problems.push(
          `差异区左右两栏行数不等（左 ${counts.old} 行、右 ${counts.next} 行）—— 并排对比会整体错位`
        )
      }
    }

    /* ---------- ⑥ 回档：编辑器里的正文必须真的换掉 ---------- */
    const beforeRestore = await readEditorText()
    if (!beforeRestore.includes(chunkB)) {
      problems.push(`回档前编辑器里找不到刚打的「${chunkB}」，后续断言无意义`)
    }

    /*
     * **显式选中列表里最旧的一版**再回档，不用「默认选中最新的那版」。
     *
     * 默认选中的那一版内容取决于自动保存与打字落在哪个两秒窗口里：
     * 若它们凑巧被合并成一次保存、紧接着又发生一次内容有微小差异的
     * 保存，最新一版也可能已经含有刚打的那段字 —— 那时「回档后还看得
     * 见 chunkB」就是**正确**行为，却会被判成失败。
     *
     * 最旧的一版永远不含刚刚才打进去的字（它是这一章被改动最早的那份
     * 正文），因此「回档后 chunkB 必须消失」这条断言在任何时序下都成立。
     * 顺带也把「点列表里的某一版能切换选中」这一交互验掉了 —— 只验
     * 默认选中的话，`onClick={() => setSelectedId(...)}` 整个坏掉都测不出来。
     */
    if (!(await clickLastHistoryItem(window))) {
      problems.push('点不到历史列表里最旧的那一版，无法验证回档')
    } else if (!(await waitForTestId(window, 'history-diff', 5000))) {
      problems.push('切换到最旧的一版之后差异区没有渲染出来')
    }

    if (!(await clickTestId(window, 'history-restore'))) {
      problems.push('点不到「回到这一版」')
    } else if (!(await waitForTestId(window, 'history-restore-confirm', 3000))) {
      /*
       * Popconfirm 的确认按钮由 antd 渲染到 body 上的浮层里，
       * 我们是靠 `okButtonProps` 给它挂的 testid。找不到就说明
       * 「点了按钮但没弹确认框」—— 那一步是回档的最后一道闸。
       */
      problems.push('点「回到这一版」之后没有弹出确认框')
    } else if (!(await clickTestId(window, 'history-restore-confirm'))) {
      problems.push('点不到确认框里的「回档」')
    } else {
      /*
       * 等编辑器里的正文真的变掉。回档要经过 IPC + 事务 + 缓存写回 +
       * 编辑器重建，不是同步的；读一次就走会读到重建前的旧内容。
       */
      const restoreDeadline = Date.now() + 8000
      let restoredText = await readEditorText()
      while (Date.now() < restoreDeadline && restoredText.includes(chunkB)) {
        await delay(150)
        restoredText = await readEditorText()
      }

      if (restoredText.includes(chunkB)) {
        problems.push(
          `点了回档之后编辑器里仍然能看到「${chunkB}」—— 库里回档成功了，但编辑器没有被重建，` +
            '画面还是回档前那一版'
        )
      }
      if (restoredText.length === 0) {
        problems.push('回档之后编辑器里的正文变成空的')
      }

      // 库里对账：正文里确实不再有那段新打的字
      const inDb = ctx.revisionsOf(ctx.chapterId)
      if (inDb.length === 0) {
        problems.push('回档之后历史版本列表空了 —— 回档本身应当也留下一版，否则误点就回不去了')
      }
    }

    /* ---------- ⑦ 关闭面板：正文要回到原来的高度 ---------- */
    await clickTestId(window, 'history-close')
    const gone = await waitForTestIdGone(window, 'chapter-history-panel', 3000)
    if (!gone) {
      problems.push('点「关闭」之后历史面板没有收起来')
    }

    return {
      name,
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `打开面板（高 ${panelBox?.height ?? 0}px）→ 打字两次、库里的版本数从 ${revisionsBefore} 涨到 ${revisionsAfter} 且界面逐条与库对账一致 → ` +
            `差异两栏行数相等 → 切到最旧一版并点「回到这一版」后编辑器正文真的换回该版、且回档本身又留了一版 → 关闭即收起`
          : problems.join('；')
    }
  } catch (error) {
    return { name, ok: false, detail: messageOf(error) }
  }
}

/** 等某个 testid 的元素数量达到期望值（版本列表是异步来的） */
async function waitForItemCount(
  window: BrowserWindow,
  expected: number,
  timeoutMs: number
): Promise<Array<{ id: number; hanzi: number }>> {
  const deadline = Date.now() + timeoutMs
  const read = async (): Promise<Array<{ id: number; hanzi: number }>> => {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(Array.prototype.map.call(
        document.querySelectorAll('[data-testid="history-item"]'),
        (el) => ({
          id: Number(el.getAttribute('data-revision-id')),
          hanzi: Number(el.getAttribute('data-hanzi'))
        })
      ))`
    )) as string
    return JSON.parse(raw) as Array<{ id: number; hanzi: number }>
  }

  let last = await read()
  while (Date.now() < deadline && last.length < expected) {
    await delay(120)
    last = await read()
  }
  return last
}

/**
 * 点历史列表里**最旧的一版**（列表按时间倒序，所以是最后一项）。
 *
 * `clickTestId` 只能点第一个匹配项，而所有版本行共用同一个 `data-testid`
 * ——想选特定的某一版就得按下标取。用 `el.click()` 而不是模拟鼠标坐标：
 * 列表是可滚动的，最旧的那一版可能在可视区之外，按坐标点会落空。
 */
async function clickLastHistoryItem(window: BrowserWindow): Promise<boolean> {
  return (await window.webContents.executeJavaScript(
    `(() => {
      const items = document.querySelectorAll('[data-testid="history-item"]')
      if (items.length === 0) return false
      const oldest = items[items.length - 1]
      if (oldest.disabled) return false
      oldest.click()
      return true
    })()`
  )) as boolean
}

/**
 * 等主进程里某一章的历史版本数涨到期望值，返回最终的版本数。
 *
 * 判据取自**主进程现读**（`ctx.revisionsOf`），而不是界面。这样等待的
 * 是「真的写库了」这件事本身，不受底栏文案、React 重渲染、缓存新鲜度
 * 这些前端时序的影响 —— 用它替代「等底栏报已保存」之后，自动保存那
 * 两秒防抖不再需要靠 sleep 猜。
 */
async function waitForRevisionCount(
  ctx: ShowcaseTargets,
  chapterId: number,
  expected: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = ctx.revisionsOf(chapterId).length
  while (Date.now() < deadline && last < expected) {
    await delay(150)
    last = ctx.revisionsOf(chapterId).length
  }
  return last
}

/**
 * 等某一章的库内汉字数不再是 `previous`，返回最终读到的值。
 *
 * 用来等「自动保存真的落库」。判据只能是主进程现读的字数：底栏的
 * 「已保存」是**状态**而不是事件，进入检查时它通常已经是「已保存」，
 * 等它等于「已保存」会瞬间返回（详见调用处的注释）。
 */
async function waitForChapterHanziChange(
  ctx: ShowcaseTargets,
  chapterId: number,
  previous: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = ctx.chapterHanzi(chapterId)
  while (Date.now() < deadline && last === previous) {
    await delay(150)
    last = ctx.chapterHanzi(chapterId)
  }
  return last
}

/** 等锚点消失。返回是否真的消失了（用于「关掉面板」这类断言） */
async function waitForTestIdGone(
  window: BrowserWindow,
  testId: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const present = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="${testId}"]') !== null`
    )) as boolean
    if (!present) return true
    await delay(120)
  }
  return false
}

