import type { AppConfig } from '../config/env'
import { logger } from '../core/logger'
import { getDatabase } from '../db/connection'
import { BookRepository } from '../modules/books/book.repository'
import { BookService } from '../modules/books/book.service'
import { registerBookHandlers } from '../modules/books/book.controller'
import { VolumeRepository } from '../modules/volumes/volume.repository'
import { VolumeService } from '../modules/volumes/volume.service'
import { registerVolumeHandlers } from '../modules/volumes/volume.controller'
import { ChapterRepository } from '../modules/chapters/chapter.repository'
import { ChapterService } from '../modules/chapters/chapter.service'
import { registerChapterHandlers } from '../modules/chapters/chapter.controller'
import { OutlineRepository } from '../modules/outline/outline.repository'
import { OutlineService } from '../modules/outline/outline.service'
import { registerOutlineHandlers } from '../modules/outline/outline.controller'
import { CardRepository } from '../modules/cards/card.repository'
import { CardService } from '../modules/cards/card.service'
import { registerCardHandlers } from '../modules/cards/card.controller'
import { SearchRepository } from '../modules/search/search.repository'
import { SearchService } from '../modules/search/search.service'
import { registerSearchHandlers } from '../modules/search/search.controller'
import { SessionRepository } from '../modules/sessions/session.repository'
import { SessionService } from '../modules/sessions/session.service'
import { registerSessionHandlers } from '../modules/sessions/session.controller'
import { StatsService } from '../modules/stats/stats.service'
import { registerStatsHandlers } from '../modules/stats/stats.controller'
import { ExportService } from '../modules/exporter/export.service'
import { registerExportHandlers } from '../modules/exporter/export.controller'
import { HealthService } from '../modules/health/health.service'
import { registerHealthHandlers } from '../modules/health/health.controller'

/**
 * 组合根（composition root）。
 *
 * 依赖在这里手工装配 —— 桌面应用规模下，手写装配比引入 DI 容器更透明：
 * 谁依赖谁一眼可见，出问题也只需要看这一个文件。
 * 各层内部一律不自己 new 依赖（除纯值对象外）。
 *
 * 注意仓储是**单例复用**的：统计模块刻意不自己写 SQL，而是复用书籍、
 * 章节、会话三个仓储，因此统计口径只有一份实现。这也是为什么下面
 * 先建仓储、再建服务，而不是每个模块各自建一套。
 */
export function registerAllIpcHandlers(config: AppConfig): void {
  const db = getDatabase()

  /* ---------------- 仓储（跨模块共享） ---------------- */
  const bookRepository = new BookRepository(db)
  const volumeRepository = new VolumeRepository(db)
  const chapterRepository = new ChapterRepository(db)
  const sessionRepository = new SessionRepository(db)
  const outlineRepository = new OutlineRepository(db)
  const cardRepository = new CardRepository(db)
  /*
   * 检索仓储刻意自己持有一份 db，而不是复用上面几张表的仓储。
   *
   * 它要做的是「跨四张表各扫一遍」，任何单表仓储都不提供这个能力；
   * 而把四张表的 SQL 塞进书籍 / 章节 / 卡片仓储里，等于让这些仓储
   * 各自多出一个与自身领域无关的方法。这里的重复只是「拿到同一个 db」，
   * 不带任何业务规则 —— 检索的规则全部在 SearchService 与服务层的
   * 共享纯函数里，没有第二份实现。
   */
  const searchRepository = new SearchRepository(db)

  /* ---------------- 服务 ---------------- */
  const bookService = new BookService(bookRepository, db)
  const volumeService = new VolumeService(volumeRepository, bookRepository)
  const chapterService = new ChapterService(chapterRepository, bookRepository, volumeRepository)
  const sessionService = new SessionService(sessionRepository, bookRepository, chapterRepository)
  // 大纲复用了章节服务：「落地成章节」走的就是创建章节那条业务路径，
  // 不另写一份 INSERT —— 那会让章节的创建规则出现两个版本
  const outlineService = new OutlineService(
    outlineRepository,
    bookRepository,
    chapterRepository,
    chapterService
  )
  // 卡片只需要校验「归属书籍是否存在」，因此复用书籍仓储，不另开查询路径
  const cardService = new CardService(cardRepository, bookRepository)
  const statsService = new StatsService(bookRepository, chapterRepository, sessionRepository)
  const searchService = new SearchService(searchRepository)

  // 导出模块需要书名与正文字数，因此复用书籍、章节两个仓储，不另开查询路径
  const exportService = new ExportService(chapterRepository, bookRepository)

  /* ---------------- 控制器 ---------------- */
  registerBookHandlers(bookService)
  registerVolumeHandlers(volumeService)
  registerChapterHandlers(chapterService)
  registerOutlineHandlers(outlineService)
  registerCardHandlers(cardService)
  registerSearchHandlers(searchService)
  registerSessionHandlers(sessionService)
  registerStatsHandlers(statsService)
  registerExportHandlers(exportService)

  // 健康检查复用书籍与章节仓储做计数，不额外开一条查询路径
  const healthService = new HealthService(config, db, bookRepository, chapterRepository)
  registerHealthHandlers(healthService)

  logger.info('IPC 通道注册完成')
}
