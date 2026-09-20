import { writeFileSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc-channels'
import { htmlToText, countHanzi, countNonWhitespace } from '@shared/text'
import { OUTLINE_LIMITS, type OutlineTreeNode } from '@shared/modules/outline'
import {
  CARD_LIMITS,
  DEFAULT_CARD_QUERY,
  type CardListQuery,
  type CardListResult
} from '@shared/modules/cards'
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
import { VolumeRepository } from './modules/volumes/volume.repository'
import { VolumeService } from './modules/volumes/volume.service'
import { ChapterRepository } from './modules/chapters/chapter.repository'
import { ChapterService } from './modules/chapters/chapter.service'
import { SessionRepository } from './modules/sessions/session.repository'
import { SessionService } from './modules/sessions/session.service'
import { OutlineRepository } from './modules/outline/outline.repository'
import { OutlineService } from './modules/outline/outline.service'
import { CardRepository } from './modules/cards/card.repository'
import { CardService } from './modules/cards/card.service'
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
  /** 展示书籍的书名。书籍详情页的页标题读的就是它（页标题已改为隐藏锚点） */
  bookTitle: string
  chapterId: number
  /** 展示书籍里的一个分卷。新建章弹窗靠它验证「选的分卷真的落库了」 */
  volumeId: number
  volumeTitle: string
  /** 展示书籍的「每章最少字数」。底栏「计划」的口径断言按它算期望值 */
  chapterWords: number
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
  const sessionRepository = new SessionRepository(db)
  const outlineRepository = new OutlineRepository(db)
  const cardRepository = new CardRepository(db)

  const bookService = new BookService(bookRepository, db)
  const volumeService = new VolumeService(volumeRepository, bookRepository)
  const chapterService = new ChapterService(chapterRepository, bookRepository, volumeRepository)
  const sessionService = new SessionService(sessionRepository, bookRepository, chapterRepository)
  const outlineService = new OutlineService(
    outlineRepository,
    bookRepository,
    chapterRepository,
    chapterService
  )
  const statsService = new StatsService(bookRepository, chapterRepository, sessionRepository)
  const cardService = new CardService(cardRepository, bookRepository)
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
      extra: {
        identity: '星舰领航员',
        affiliation: '星海联邦第七舰队',
        appearance: '左手有一道旧伤',
        relationship: '与主角亦师亦友'
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
        extra: { identity: '', affiliation: '', appearance: '', relationship: '' }
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
      extra: { identity: '另一本书里的同名角色', affiliation: '', appearance: '', relationship: '' }
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
      cardCharacter.extra.relationship === '与主角亦师亦友' &&
      cardItem.extra.grade === '传说级' &&
      cardItem.extra.origin === '遗迹出土' &&
      cardGlobal.bookId === null &&
      cardGlobal.extra.usage === '哪本书都能用'

    const cardChecks: Array<[string, boolean, string]> = [
      [
        '卡片专属字段落库',
        extraRoundTripOk,
        extraRoundTripOk
          ? `人物卡（身份「${cardCharacter.extra.identity}」/ 关系「${cardCharacter.extra.relationship}」）、物品卡（品阶「${cardItem.extra.grade}」）、通用灵感卡（bookId=null）的专属字段写读一致`
          : `人物卡 identity=${cardCharacter.extra.identity}，物品卡 grade=${cardItem.extra.grade}，通用卡 bookId=${cardGlobal.bookId}`
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
        cardsAll.total === 4 && cardsOfBook.total === 3 && cardsGlobal.total === 1,
        `全部 ${cardsAll.total} 张 / 本书 ${cardsOfBook.total} 张 / 通用 ${cardsGlobal.total} 张（预期 4 / 3 / 1）`
      ],
      [
        '卡片类型筛选与计数',
        cardsCharacter.total === 1 &&
          characterQueryCounts.character === 1 &&
          characterQueryCounts.item === 1 &&
          characterQueryCounts.inspiration === 2,
        cardsCharacter.total === 1 && characterQueryCounts.item === 1
          ? `筛出人物卡 ${cardsCharacter.total} 张，而类型计数仍给全量口径（人物 ${characterQueryCounts.character} / 物品 ${characterQueryCounts.item} / 灵感 ${characterQueryCounts.inspiration}）`
          : `筛出 ${cardsCharacter.total} 张，计数 人物 ${characterQueryCounts.character} / 物品 ${characterQueryCounts.item} / 灵感 ${characterQueryCounts.inspiration}`
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
        cardCopyRemoval.id === cardCopy.id && cardsAfterCopyRemoval.total === 3,
        `删除副本后本书卡片回到 ${cardsAfterCopyRemoval.total} 张（预期 3）`
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

  // 供渲染检查使用：确认至少有一本书 + 一章可供展示
  if (showcaseBookId === null || showcaseChapterId === null) {
    push('冒烟数据准备', false, '未能为渲染检查准备出可见的数据')
  }

  return {
    results,
    showcase:
      showcaseBookId !== null && showcaseChapterId !== null && showcaseVolumeId !== null
        ? {
            bookId: showcaseBookId,
            bookTitle: showcaseBookTitle,
            chapterId: showcaseChapterId,
            volumeId: showcaseVolumeId,
            volumeTitle: showcaseVolumeTitle,
            chapterWords: SHOWCASE_CHAPTER_WORDS,
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
            }
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
      { name: '大纲管理', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '卡片库', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '全库检索', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '章节编辑器', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '编辑器工具栏', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '新建章弹窗', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '目录右键菜单', ok: false, detail: '渲染进程未能加载，无法继续' }
    ]
  }

  results.push(await checkDashboard(window))
  /*
   * 启动台检查紧跟首页之后：它从首页出发、四个模块各走一遍「卡片 → 模块页 →
   * 返回首页」的往返，跑完会回到首页。放在这里它拿到的正是首页的初始状态，
   * 而后面几条检查各自用改 hash 的方式进自己的页面，互不干扰。
   */
  results.push(await checkHomeNavigation(window))
  results.push(await checkBooks(window, showcase))
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
    // **唯一的例外是书籍详情页**（那里的标题是书名，是内容），它在 checkBooks
    // 里反向断言。读的是实测面积，不是类名：类名可以随便改，「占不占地方」
    // 才是事实。下面 `pageTitle` 那一行同时证明了隐藏的锚点还在（否则它会
    // 读成空字符串）。
    if (rendered.titleVisible) {
      problems.push('页标题在画面上占位了，它应当只是给读屏与测试用的隐藏锚点')
    }

    if (rendered.pageTitle !== '首页') problems.push(`页面标题异常：${rendered.pageTitle}`)
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

    return {
      name: '渲染进程',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `React 已挂载，顶部无导航条，首页 ${rendered.modules.length} 张功能卡片一行等宽（各 ${rendered.modules[0].width}px，顺序 ${rendered.modules
              .map((item) => item.key)
              .join('→')}），渲染 ${rendered.bookCount} 本书 / ${rendered.totalHanzi} 汉字 / ${rendered.progressRowCount} 行进度，健康状态「${rendered.healthText}」，行内卡片等高（指标 ${rendered.rows.metricHeights[0]}px / 趋势与今日 ${rendered.rows.trendHeight}px）`
          : // 失败时把实测快照一并打出来。否则只有一句「没有渲染出数据行」，
            // 还得回头改代码加日志才能知道到底是没挂载、还在 loading 还是选择器写错了
            `${problems.join('；')}｜实测：React ${
              rendered.reactMounted ? '已挂载' : '未挂载'
            }，顶部导航条 ${rendered.hasTopNav ? '还在' : '已移除'}，标题${
              rendered.titleVisible ? '可见' : '隐藏'
            }，功能卡片=${rendered.modules.length} 张（${rendered.modules
              .map((item) => item.key || '?')
              .join('/')}），标题「${rendered.pageTitle}」，loading=${
              rendered.metricsLoading
            }，书籍数=${rendered.bookCount}，总字数=${rendered.totalHanzi}，进度行=${
              rendered.progressRowCount
            }，健康「${rendered.healthText}」`
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
    // 目录栏里的新建入口只该有头部那两个。分卷行上的 + 与列表底部的
    // 新建章节都已被删掉：同一件事在一屏里给三个入口，只让人每次先做一次
    // 无意义的选择，而目录栏很窄，这些按钮还挤掉了章节标题的宽度。
    catalogNewTriggers: (() => {
      const catalog = document.querySelector('[data-testid="chapter-catalog"]')
      if (!catalog) return -1
      return Array.prototype.filter.call(catalog.querySelectorAll('button'), (el) =>
        /新建/.test(el.textContent || '')
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
  await closeCatalogMenu(window)

  const dispatched = (await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector(
      '[data-testid="catalog-row"][data-chapter-id="${chapterId}"]'
    )
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
   * 用户 2026-09-20 先要求「页标题移除，不要展示」，随后又追加了唯一的例外：
   * 「书籍详情页需要显示书籍名称，原标题的位置应该显示书籍名称」。
   * 所以这个值**按页给结论**，不是一刀切：
   *   - 首页与四个模块页（书籍管理 / 大纲管理 / 卡片库 / 统计）：必须 false。
   *     这些标题是导航标签，内容本身已经说明了这是哪一页；
   *   - 书籍详情页：必须 true。那里的标题是**书名**，是内容，页面里没有别处写着它。
   *
   * 判据是**实测面积**而不是类名：类名怎么改都行，「占不占画面」才是事实。
   * 两个方向都留了断言 —— 该隐的没隐（回去了）与该显的没显（书名丢了）都会红。
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
  moduleCount: 0
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
    moduleCount: document.querySelectorAll('[data-testid="module-entry"]').length
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
    const home = await readRouteState(window, (state) => state.moduleCount > 0)

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
      // 唯一的例外是书籍详情页的书名（那一个是内容，见 checkBooks 里的反向断言）；
      // 「哪些页该显、哪些页该隐」于是两边都有守卫，不会一起漂。
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
          ? `${trips.length} 个模块各自走通「卡片 → 模块页（页标题已移除、右下角悬浮返回按钮）→ 返回首页」：${trips.join(' → ')}；首页上无返回按钮，全程无顶部导航条、无可见页标题、无空壳标题行，顶栏未被挤动（品牌左坐标恒为 ${brandLeftOnHome}px）；${floatingDetail}`
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

    return {
      name: '大纲管理',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，标题「${snap.title}」，树渲染 ${snap.nodeRows} 行 / 共 ${snap.total} 个节点，已落地 ${snap.landed} 个，树面板高 ${snap.treeHeight}px`
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
 * 书籍管理页：书架真的渲染出书，且「新建书籍」按钮已图标化并挪到搜索框左侧。
 *
 * 这一页此前没有独立检查 —— 首页只覆盖了列表接口（BookProgress），
 * 而书架页读的是另一支接口（BookList）并带分页 / 筛选 / 排序。
 * 现在补上，顺带把「独立主按钮 → 工具栏图标按钮」这条界面约定锁住：
 * 它属于「用户肉眼能看到、但 DOM 查询与接口断言都覆盖不到」的那类事实。
 */
async function checkBooks(window: BrowserWindow, ctx: ShowcaseTargets | null): Promise<StepResult> {
  const route = '#/books'
  /** 书籍详情页那一段的实测结论，拼进结果里 */
  let detailNote = '书籍详情页未覆盖（本轮没有拿到书名上下文）'

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

    /*
     * 顺带把**书籍详情页**也走一遍。
     *
     * 这一页此前在冒烟里完全没有覆盖（只能从书架的「打开」进，没有可直接点到的
     * 路由），而它是全应用唯一**把标题显示出来**的一页（用户 2026-09-20：
     * 「书籍详情页需要显示书籍名称，原标题的位置应该显示书籍名称」）。
     * 判断依据不是「哪一页更特殊」，而是这个字符串是不是内容：模块页的标题是
     * 导航标签（内容已经说明了自己），这一页的标题是**书名** —— 它是这本书的
     * 身份，页面里没有别处写着它。
     *
     * 等待判据用的是书名而不是「hash 变了」：改 hash 是同步的，React 还停在
     * 上一页时 `pageTitle` 里是「书籍管理」—— 拿非空当判据会立刻通过，
     * 断言看着全绿而读的其实是上一页。
     */
    if (ctx !== null && ctx.bookId > 0 && ctx.bookTitle.length > 0) {
      const detailRoute = `#/books/${ctx.bookId}`
      await window.webContents.executeJavaScript(
        `(() => { location.hash = ${JSON.stringify(detailRoute)}; return true })()`
      )
      const detail = await readRouteState(
        window,
        (state) => state.hash === detailRoute && state.pageTitle === ctx.bookTitle
      )

      if (detail.hash !== detailRoute) {
        problems.push(`进入书籍详情页失败（hash 停在 ${detail.hash || '空'}）`)
      } else if (detail.pageTitle !== ctx.bookTitle) {
        problems.push(
          `书籍详情页读到的页面标识是「${detail.pageTitle}」（应为书名「${ctx.bookTitle}」）—— 标题元素丢了，读屏会读不出这是哪本书`
        )
      } else {
        /*
         * 书名必须**显示在画面上、且在操作按钮左侧**。
         *
         * 这一条是上一版断言的反转：上一版认为书名只该做隐藏锚点，需求翻过来
         * 之后旧断言不能直接删 —— 删了就没人拦得住它被改回隐藏。反向那一条
         * （模块页不得显示标题）仍由首页与模块往返那两步守着，两边都有断言。
         *
         * 只断 `titleVisible` 不够：标题被挪到页面底部另起一行、或塞到按钮右边，
         * 存在性断言照样全绿，但「原标题的位置」已经不成立。所以量的是
         * 同一行（top 接近）且书名在左、操作区在右。
         */
        if (!detail.titleVisible) {
          problems.push(
            '书籍详情页没有显示书名 —— 这一页的标题是内容（书名），不属于「页标题不展示」的范围'
          )
        } else if (detail.actionsLeft >= 0 && detail.titleLeft >= detail.actionsLeft) {
          problems.push(
            `书籍详情页的书名没有排在操作按钮左侧（标题 left=${detail.titleLeft}，操作区 left=${detail.actionsLeft}）—— 它应当仍在原来那一行的左端`
          )
        } else if (detail.actionsTop >= 0 && Math.abs(detail.titleTop - detail.actionsTop) > 8) {
          problems.push(
            `书籍详情页的书名与操作按钮不在同一行（top ${detail.titleTop} vs ${detail.actionsTop}）`
          )
        }
        if (detail.emptyHeaderRows > 0) {
          problems.push(`书籍详情页有 ${detail.emptyHeaderRows} 行只剩外壳的标题行，会在页顶撑出空白`)
        }
        detailNote = `书籍详情页书名「${detail.pageTitle}」显示在标题位（可见、在操作按钮左侧 ${
          detail.actionsLeft - detail.titleLeft
        }px，同一行 top 差 ${Math.abs(detail.titleTop - detail.actionsTop)}px）`
        await captureIfRequested(window, 'book-detail')
      }
    }

    return {
      name: '书籍管理',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，标题「${snap.title}」，书架渲染 ${snap.cards} 本书，新建按钮为 ${snap.addButton.width}px 正圆图标（圆角 ${snap.addButton.radiusPx}px）且在搜索框左侧 ${snap.addButton.gapToSearch}px，悬浮提示「${tip}」；${detailNote}`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，标题「${snap.title}」，书籍卡片=${snap.cards}，新建按钮文字「${snap.addButton.text}」间距=${snap.addButton.gapToSearch} 中线差=${snap.addButton.centerOffset} 在工具栏=${snap.addButton.inToolbar} 尺寸=${snap.addButton.width}×${snap.addButton.height} 圆角=${snap.addButton.radiusPx}；${detailNote}`
    }
  } catch (error) {
    return { name: '书籍管理', ok: false, detail: messageOf(error) }
  }
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
    // 后端为这本书留了 3 张卡，另加 1 张通用卡；默认「全部书籍」范围应看到 4 行
    if (snap.rows !== 4) problems.push(`列表渲染出 ${snap.rows} 行，预期 4 行`)
    if (snap.total !== 4) problems.push(`卡片总数应为 4，实得 ${snap.total}`)
    if (snap.character !== 1) problems.push(`人物卡计数应为 1，实得 ${snap.character}`)
    if (snap.item !== 1) problems.push(`物品卡计数应为 1，实得 ${snap.item}`)
    if (snap.inspiration !== 2) problems.push(`灵感卡计数应为 2，实得 ${snap.inspiration}`)
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
          ? `进入 ${route}，标题「${snap.title}」，渲染 ${snap.rows} 行 / 共 ${snap.total} 张（人物 ${snap.character} / 物品 ${snap.item} / 灵感 ${snap.inspiration}，其中通用 ${snap.global}），编辑面板已打开卡片 #${snap.editorCardId}，列表面板高 ${snap.listHeight}px，新建按钮为 ${snap.addButton.width}px 正圆图标（圆角 ${snap.addButton.radiusPx}px），位于工具栏最左端、在搜索框左侧 ${snap.addButton.gapToSearch}px，悬浮提示「${tip}」`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，标题「${snap.title}」，列表=${
              snap.hasList ? '有' : '无'
            }，行数=${snap.rows}，总数=${snap.total}，人物=${snap.character}，物品=${snap.item}，灵感=${snap.inspiration}，通用=${snap.global}，面板=${
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
    state.statusbarVisible

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
   * 已不显示（只做隐藏锚点）。唯一显示标题的是书籍详情页（书名是内容），
   * 那一步不在这个快照里，走 checkBooks 的断言。
   */
  titleVisible: boolean
  /** 页面标题（= 窗口标题栏文字），应等于产品名 winbook */
  docTitle: string
  pageTitle: string
  healthText: string
  healthOk: boolean
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
  const badge = document.querySelector('[data-testid="health-badge"]')
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
  // （书籍详情页是例外 —— 那里显示书名，由 checkBooks 单独断言。）
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
  return {
    reactMounted: (root?.children.length ?? 0) > 0,
    hasTopNav: !!navEl,
    titleVisible,
    // 页面标题就是窗口标题栏显示的文字（BrowserWindow 未另设 title 时由页面接管），
    // 品牌名写错过一次，这里把它锁住
    docTitle: document.title,
    pageTitle: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
    healthText: badge?.textContent ?? '',
    healthOk: badge?.getAttribute('data-state') === 'ok',
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
  healthText: '',
  healthOk: false,
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
}

function messageOf(error: unknown): string {
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
