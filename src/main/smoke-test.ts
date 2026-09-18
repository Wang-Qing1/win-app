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
  chapterId: number
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
  let showcaseChapterId: number | null = null

  try {
    /* ---- 建书 ---- */
    const book = bookService.create({
      title: `冒烟-星海归途-${STAMP}`,
      penName: '冒烟作者',
      genre: '科幻',
      status: 'serializing',
      summary: '由 npm run smoke 创建',
      targetWords: 200_000,
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
        accentColor: '#0f6cbd'
      })
    } catch (error) {
      conflictBlocked = error instanceof AppError && error.code === 'CONFLICT'
    }

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
      accentColor: '#0f7b0f'
    })
    showcaseBookId = showcase.id

    const showcaseChapter = chapterService.create({
      bookId: showcase.id,
      volumeId: null,
      title: '第一章 开场',
      targetWords: 2000
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
      showcaseBookId !== null && showcaseChapterId !== null
        ? { bookId: showcaseBookId, chapterId: showcaseChapterId }
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
      { name: '大纲管理', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '卡片库', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '全库检索', ok: false, detail: '渲染进程未能加载，无法继续' },
      { name: '章节编辑器', ok: false, detail: '渲染进程未能加载，无法继续' }
    ]
  }

  results.push(await checkDashboard(window))
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
    if (!rendered.hasNav) problems.push('缺少顶部导航条')
    if (rendered.pageTitle !== '首页') problems.push(`页面标题异常：${rendered.pageTitle}`)
    if (!rendered.healthOk) problems.push(`健康检查未通过：${rendered.healthText}`)
    // 指标区必须已经脱离 loading，否则会在数据到达之前就误判为通过
    if (rendered.metricsLoading) problems.push('指标区仍处于加载中（loading 未结束）')
    // 真实数字必须出现，这是「preload 桥 → IPC → 主进程 → SQLite」整条链路的证据
    if (rendered.bookCount < 1) problems.push(`书籍数未渲染出真实数据：${rendered.bookCount}`)
    if (rendered.totalHanzi < 1) problems.push(`总字数未渲染出真实数据：${rendered.totalHanzi}`)
    if (rendered.progressRowCount < 1) problems.push('在写书籍列表没有渲染出任何数据行')

    // 导航布局量几何：上下结构的证据是「所有标签同一行、导航条横贯窗口、
    // 且整条压在内容区上方」。改回左右结构时这三条会同时被打破 ——
    // 标签纵向堆叠、条宽只有侧栏的 208px、内容区被挤到右侧。
    // 等宽分布是产品要求：五个标签平分整行宽度，与文字长短无关。
    const nav = rendered.nav
    if (nav) {
      const sameRow = Math.max(...nav.itemTops) - Math.min(...nav.itemTops) <= 2
      const orderedLeftToRight = nav.itemLefts.every((left, i) => i === 0 || left > nav.itemLefts[i - 1])
      const spansWindow = nav.width >= nav.windowWidth * 0.9
      const aboveContent = nav.bottom <= nav.contentTop + 1
      const equalWidth =
        nav.itemWidths.length > 1 && Math.max(...nav.itemWidths) - Math.min(...nav.itemWidths) <= 2
      if (!sameRow) problems.push(`导航标签不在同一行（top 坐标 ${nav.itemTops.join('/')}）——像是侧栏的纵向堆叠`)
      if (!orderedLeftToRight) problems.push(`导航标签从左到右的顺序乱了（left 坐标 ${nav.itemLefts.join('/')}）`)
      if (!spansWindow) problems.push(`导航条宽 ${nav.width}px，不足窗口宽（${nav.windowWidth}px）——像是侧栏`)
      if (!aboveContent) problems.push(`导航条底 ${nav.bottom}px 超过了内容区顶 ${nav.contentTop}px`)
      if (!equalWidth) {
        problems.push(
          `导航标签没有平分整行宽度（各格宽 ${nav.itemWidths.join('/')}px）—— 挤在左侧或是随文字长短伸缩`
        )
      }
    } else if (rendered.hasNav) {
      problems.push('导航元素存在但读不到几何信息')
    }

    await captureIfRequested(window, 'dashboard')

    return {
      name: '渲染进程',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `React 已挂载，顶部导航 ${rendered.nav ? `${rendered.nav.itemTops.length} 个标签等宽同一行（各 ${rendered.nav.itemWidths[0]}px）、条宽 ${rendered.nav.width}px` : '存在'}，首页渲染 ${rendered.bookCount} 本书 / ${rendered.totalHanzi} 汉字 / ${rendered.progressRowCount} 行进度，健康状态「${rendered.healthText}」`
          : // 失败时把实测快照一并打出来。否则只有一句「没有渲染出数据行」，
            // 还得回头改代码加日志才能知道到底是没挂载、还在 loading 还是选择器写错了
            `${problems.join('；')}｜实测：React ${
              rendered.reactMounted ? '已挂载' : '未挂载'
            }，导航 ${rendered.hasNav ? '有' : '无'}，标题「${rendered.pageTitle}」，loading=${
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
}

const EMPTY_EDITOR_SNAPSHOT: EditorSnapshot = {
  mounted: false,
  hash: '',
  title: '',
  paragraphCount: 0,
  hanzi: -1,
  catalogRows: 0,
  proofreadCount: -1,
  paperInk: '',
  textColor: '',
  statusbarVisible: false,
  geometry: '',
  hasCatalog: false,
  hasToolbar: false,
  hasInspector: false
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
  const chain = ['#root', '.app-shell', '.app-shell__body', '.app-main', '.editor-page', '.editor-body', '.editor-main', '.wapp-editor', '.editor-stage', '.editor-statusbar']
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

  return {
    mounted: !!document.querySelector('[data-testid="chapter-editor"]'),
    hash: location.hash,
    // 题名从 input 的 value 读：antd 的 Input 不回填 textContent
    title: (titleInput && 'value' in titleInput ? titleInput.value : '') || '',
    paragraphCount: document.querySelectorAll('[data-testid="editor-content"] p').length,
    hanzi: intOf('editor-hanzi'),
    catalogRows: document.querySelectorAll('[data-testid="catalog-row"]').length,
    proofreadCount: intOf('editor-proofread-count'),
    paperInk: surface?.getAttribute('data-paper-ink') ?? '',
    textColor: column ? getComputedStyle(column).color : '',
    statusbarVisible:
      !!statusbarRect && statusbarRect.height > 0 && statusbarRect.bottom <= window.innerHeight + 1,
    geometry: '视口=' + window.innerHeight + ' ' + geometry,
    hasCatalog: !!document.querySelector('[data-testid="chapter-catalog"]'),
    hasToolbar: !!document.querySelector('[data-testid="editor-toolbar"]'),
    hasInspector: !!document.querySelector('[data-testid="editor-inspector"]')
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

    // 正文必须是看得见的：字色的深浅方向要和纸面声明的墨色一致。
    // 这一条是被真事故逼出来的 —— 素白纸上配了近白色的字，正文整段不可见，
    // 而元素在、字数对、纠错也在，前面所有断言照样全绿。
    const textIsLight = isLightColor(snap.textColor)
    if (snap.paperInk !== 'dark' && snap.paperInk !== 'light') {
      problems.push(`纸面没有声明墨色取向（data-paper-ink=${snap.paperInk || '缺失'}）`)
    } else if (textIsLight === null) {
      problems.push(`读不到正文字色（${snap.textColor || '空'}）`)
    } else if (snap.paperInk === 'dark' && textIsLight) {
      problems.push(`深色墨却算出了浅色字（${snap.textColor}），正文在浅色纸上会看不见`)
    } else if (snap.paperInk === 'light' && !textIsLight) {
      problems.push(`浅色墨却算出了深色字（${snap.textColor}），正文在深色纸上会看不见`)
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
          ? `进入 ${route}，题名「${snap.title}」，三栏齐备，正文 ${snap.paragraphCount} 段 / ${snap.hanzi} 汉字，目录 ${snap.catalogRows} 行，纠错 ${snap.proofreadCount} 处，墨色 ${snap.paperInk === 'dark' ? '深' : '浅'}（字色 ${snap.textColor}）`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，题名「${snap.title}」，目录=${
              snap.hasCatalog ? '有' : '无'
            }，工具栏=${snap.hasToolbar ? '有' : '无'}，检查器=${
              snap.hasInspector ? '有' : '无'
            }，段落=${snap.paragraphCount}，汉字=${snap.hanzi}，目录行=${snap.catalogRows}，纠错=${snap.proofreadCount}，墨色=${snap.paperInk || '缺失'}，字色=${snap.textColor || '空'}` +
            (problems.length === 0 ? '' : `｜高度链：${snap.geometry}`)
    }
  } catch (error) {
    return { name: '章节编辑器', ok: false, detail: messageOf(error) }
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

    await captureIfRequested(window, 'cards')

    return {
      name: '卡片库',
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? `进入 ${route}，标题「${snap.title}」，渲染 ${snap.rows} 行 / 共 ${snap.total} 张（人物 ${snap.character} / 物品 ${snap.item} / 灵感 ${snap.inspiration}，其中通用 ${snap.global}），编辑面板已打开卡片 #${snap.editorCardId}，列表面板高 ${snap.listHeight}px`
          : `${problems.join('；')}｜实测：hash=${snap.hash}，标题「${snap.title}」，列表=${
              snap.hasList ? '有' : '无'
            }，行数=${snap.rows}，总数=${snap.total}，人物=${snap.character}，物品=${snap.item}，灵感=${snap.inspiration}，通用=${snap.global}，面板=${
              snap.hasEditor ? '有' : '无'
            }，面板卡片=${snap.editorCardId}，列表高=${snap.listHeight}`
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
     * 不设 WAPP_SMOKE_CAPTURE 时 captureIfRequested 直接返回，
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
 *   WAPP_SMOKE_CAPTURE=D:\shots\page.png npm run smoke
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
  const configured = process.env.WAPP_SMOKE_CAPTURE
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
      `[wapp] ${label} 截图已写入 ${target}（窗口 ${bounds.width}x${bounds.height}，图像 ${size.width}x${size.height}）`
    )

    if (!wasVisible) await setWindowVisible(window, false)
  } catch (error) {
    // 截图只是辅助手段，失败了不该把冒烟测试带成红灯
    console.warn(`[wapp] ${label} 截图失败：`, messageOf(error))
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
 */
async function waitForEditor(window: BrowserWindow, timeoutMs = 20_000): Promise<EditorSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_EDITOR_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(EDITOR_SNAPSHOT_SCRIPT)) as EditorSnapshot
    if (
      last.mounted &&
      last.hasCatalog &&
      last.hasToolbar &&
      last.hasInspector &&
      last.paragraphCount >= 1 &&
      last.hanzi >= 0 &&
      last.catalogRows >= 1 &&
      last.proofreadCount >= 1 &&
      last.textColor.length > 0 &&
      last.statusbarVisible
    ) {
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
  listHeight: 0
}

const CARDS_SNAPSHOT_SCRIPT = `(() => {
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
    listHeight: rect ? Math.round(rect.height) : 0
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
  hasNav: boolean
  pageTitle: string
  healthText: string
  healthOk: boolean
  metricsLoading: boolean
  bookCount: number
  totalHanzi: number
  progressRowCount: number
  /** 导航条几何：验证「上下结构」用的是实测坐标，不是看截图猜的 */
  nav: {
    top: number
    bottom: number
    width: number
    itemTops: number[]
    itemLefts: number[]
    itemWidths: number[]
    contentTop: number
    windowWidth: number
  } | null
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
  const nav = navEl ? (() => {
    const navRect = navEl.getBoundingClientRect()
    const items = Array.from(navEl.querySelectorAll('button')).map((b) => b.getBoundingClientRect())
    const main = document.querySelector('.app-main')
    return {
      top: Math.round(navRect.top),
      bottom: Math.round(navRect.bottom),
      width: Math.round(navRect.width),
      itemTops: items.map((r) => Math.round(r.top)),
      itemLefts: items.map((r) => Math.round(r.left)),
      itemWidths: items.map((r) => Math.round(r.width)),
      contentTop: main ? Math.round(main.getBoundingClientRect().top) : -1,
      windowWidth: window.innerWidth
    }
  })() : null
  return {
    reactMounted: (root?.children.length ?? 0) > 0,
    hasNav: !!navEl,
    pageTitle: document.querySelector('[data-testid="page-title"]')?.textContent ?? '',
    healthText: badge?.textContent ?? '',
    healthOk: badge?.getAttribute('data-state') === 'ok',
    metricsLoading: metrics?.getAttribute('data-loading') === 'true',
    bookCount: numberOf('metric-book-count'),
    totalHanzi: numberOf('metric-total-hanzi'),
    progressRowCount: document.querySelectorAll('[data-testid="progress-row"]').length,
    nav
  }
})()`

const EMPTY_SNAPSHOT: RenderSnapshot = {
  reactMounted: false,
  hasNav: false,
  pageTitle: '',
  healthText: '',
  healthOk: false,
  metricsLoading: false,
  bookCount: -1,
  totalHanzi: -1,
  progressRowCount: 0,
  nav: null
}

/**
 * 轮询等待首屏与数据都就绪。
 *
 * 不能只等 did-finish-load —— 那只代表 HTML 加载完，此时 React 才刚挂载，
 * 指标区还在 loading、健康徽标还是「正在自检…」。必须一直等到：
 * React 挂载 + 导航渲染 + 健康检查 ok + 指标脱离 loading + 真实数据出现，
 * 才算真正跑通。
 */
async function waitForRender(window: BrowserWindow, timeoutMs = 25_000): Promise<RenderSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last = EMPTY_SNAPSHOT

  while (Date.now() < deadline) {
    last = (await window.webContents.executeJavaScript(SNAPSHOT_SCRIPT)) as RenderSnapshot
    if (
      last.reactMounted &&
      last.hasNav &&
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
  const lines: string[] = ['', 'wapp 启动冒烟测试', '─'.repeat(64)]

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
      console.error('[wapp] 冒烟测试报告写入失败：', error)
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
