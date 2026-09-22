import type {
  Chapter,
  ChapterCreateInput,
  ChapterListItem,
  ChapterListQuery,
  ChapterMoveInput,
  ChapterReorderInput,
  ChapterRestoreInput,
  ChapterRestoreResult,
  ChapterRevision,
  ChapterRevisionSummary,
  ChapterSaveContentInput,
  ChapterSaveResult,
  ChapterUpdateInput
} from '@shared/modules/chapters'
import { CHAPTER_LIMITS, CHAPTER_REVISION_LIMITS } from '@shared/modules/chapters'
import { htmlToText, measureText } from '@shared/text'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import { runInTransaction } from '../../db/connection'
import type { BookRepository } from '../books/book.repository'
import type { VolumeRepository } from '../volumes/volume.repository'
import type { ChapterRepository } from './chapter.repository'
import type { ChapterRevisionRepository } from './chapter-revision.repository'

export class ChapterService {
  /**
   * 上一次**真正留版**时被替换掉的那份正文，按章节 id 索引。
   *
   * 存在的唯一理由是给版本去重提供基准 —— 详见 `keepSnapshot` 的注释：
   * 基准既不能用「最新一版快照」（被拒的改动不留快照，基准会越来越旧），
   * 也不能用「上一次见过的正文」（基准会随每次保存前移，小改动永远累积
   * 不到阈值）。只有「留版那一刻的正文」才能让比较有意义。
   *
   * 只存一章一份，因此内存占用与「正在被编辑的章节数」同阶，
   * 而不是与全书章节数同阶。进程重启后为空，由首次调用就地初始化。
   * **不做持久化**：它只是一个比较用的缓存，丢了最坏是多留一版重复内容，
   * 不值得为它加一张表或一列。
   */
  private readonly revisionBaseline = new Map<number, { contentHtml: string; hanziCount: number }>()

  constructor(
    private readonly repository: ChapterRepository,
    private readonly bookRepository: BookRepository,
    private readonly volumeRepository: VolumeRepository,
    private readonly revisionRepository: ChapterRevisionRepository
  ) {}

  list(query: ChapterListQuery): ChapterListItem[] {
    this.assertBookExists(query.bookId)
    if (typeof query.volumeId === 'number') {
      this.assertVolumeInBook(query.volumeId, query.bookId)
    }
    return this.repository.list(query)
  }

  getById(id: number): Chapter {
    const chapter = this.repository.findById(id)
    if (!chapter) {
      throw AppError.notFound(`章节不存在（ID: ${id}）`)
    }
    return chapter
  }

  create(input: ChapterCreateInput): ChapterListItem {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)
      if (input.volumeId !== null) {
        this.assertVolumeInBook(input.volumeId, input.bookId)
      }

      if (this.repository.countByBook(input.bookId) >= CHAPTER_LIMITS.perBook) {
        throw AppError.validation(`单本书的章节数量不能超过 ${CHAPTER_LIMITS.perBook} 章`)
      }

      // 章节标题刻意不强制唯一：多篇「番外」、分上下篇用同名标题
      // 在真实创作里都是合理的，强制唯一只会逼作者加无意义的编号后缀。
      const now = new Date().toISOString()
      const created = this.repository.insert(
        input,
        this.repository.nextOrderIndex(input.bookId, input.volumeId),
        now
      )

      this.bookRepository.touch(input.bookId, now)
      logger.info('章节已创建', { id: created.id, bookId: created.bookId })
      return created
    })
  }

  /**
   * 更新元数据。若同时改变了所属分卷，等价于一次「移动」——
   * 但它应该落到目标容器的末尾，因为用户是在编辑弹窗里改归属，
   * 不是在列表里拖拽，没有落点信息。
   */
  update(input: ChapterUpdateInput): ChapterListItem {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${input.id}）`)
      }

      const targetVolumeId = input.volumeId
      if (targetVolumeId !== null) {
        this.assertVolumeInBook(targetVolumeId, existing.bookId)
      }

      const now = new Date().toISOString()
      const containerChanged = targetVolumeId !== existing.volumeId

      if (containerChanged) {
        const targetIds = this.repository
          .listIdsInContainer(existing.bookId, targetVolumeId)
          .filter((id) => id !== input.id)

        this.repository.applyMove(
          { id: input.id, volumeId: targetVolumeId, targetIndex: targetIds.length },
          // 源容器的重排序列必须在移动**之前**取，且要包含自己——
          // applyMove 内部会把它过滤掉，再合拢剩下的空位
          this.repository.listIdsInContainer(existing.bookId, existing.volumeId),
          [...targetIds, input.id],
          now
        )
      }

      const updated = this.repository.updateMeta(input, now)
      if (!updated) {
        throw AppError.internal(`章节更新失败（ID: ${input.id}）`)
      }

      this.bookRepository.touch(existing.bookId, now)
      logger.info('章节已更新', { id: updated.id, containerChanged })
      return updated
    })
  }

  /**
   * 保存正文。
   *
   * 这是全应用写入最频繁的接口（编辑器自动保存）。三个派生值由主进程
   * 从 HTML 现算，而不是让渲染进程把算好的字数一并送过来——派生数据
   * 只允许有一个产生它的地方，否则迟早出现「正文和字数对不上」的记录。
   *
   * 顺带留一份历史版本：抓的是**被替换掉的旧正文**，也就是作者后悔时
   * 想退回的那一版。详见 keepSnapshot 的注释。
   */
  saveContent(input: ChapterSaveContentInput): ChapterSaveResult {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${input.id}）`)
      }

      // 只转一次文本：measureHtml 内部也要走一遍 htmlToText，
      // 两者都调用等于把同一份 HTML 解析两次
      const contentText = htmlToText(input.contentHtml)
      const metrics = measureText(contentText)
      const now = new Date().toISOString()

      // 留快照必须在覆盖之前，此时 existing 里还是旧正文
      const snapshotKept = this.keepSnapshot(existing, now)

      const saved = this.repository.saveContent(
        input,
        {
          contentText,
          hanziCount: metrics.hanzi,
          charCount: metrics.characters
        },
        now
      )

      if (!saved) {
        throw AppError.internal(`章节正文保存失败（ID: ${input.id}）`)
      }

      // 碰一下书，让书架按「最近写作」排序而不是按创建时间
      this.bookRepository.touch(existing.bookId, now)

      logger.debug('章节正文已保存', {
        id: saved.id,
        hanzi: saved.hanziCount,
        chars: saved.charCount,
        snapshotKept
      })
      return saved
    })
  }

  /* ---------------- 历史版本 ---------------- */

  listRevisions(chapterId: number): ChapterRevisionSummary[] {
    // 章节不存在就报错，而不是返回空数组：前者是调用方 bug，
    // 后者会让界面显示「暂无历史版本」这个误导性的空状态
    if (!this.repository.exists(chapterId)) {
      throw AppError.notFound(`章节不存在（ID: ${chapterId}）`)
    }
    return this.revisionRepository.listByChapter(chapterId)
  }

  getRevision(id: number): ChapterRevision {
    const revision = this.revisionRepository.findById(id)
    if (!revision) {
      throw AppError.notFound(`历史版本不存在（ID: ${id}）`)
    }
    return revision
  }

  /**
   * 回档到某一版。
   *
   * 关键性质：**回档本身也是可以再回档的**。执行前先把当前正文按
   * 正常规则留一份快照，于是「误点回档」不会造成新的不可逆损失 ——
   * 作者再回一次就能回到回档之前。少了这一步，回档就成了整个功能里
   * 唯一一个会真丢数据的地方，而它恰恰是用户最紧张时点的按钮。
   */
  restoreRevision(input: ChapterRestoreInput): ChapterRestoreResult {
    return runInTransaction(() => {
      const chapter = this.repository.findById(input.chapterId)
      if (!chapter) {
        throw AppError.notFound(`章节不存在（ID: ${input.chapterId}）`)
      }

      const revision = this.revisionRepository.findById(input.revisionId)
      if (!revision) {
        throw AppError.notFound(`历史版本不存在（ID: ${input.revisionId}）`)
      }
      // 版本 id 与章节 id 是两个独立的自增序列，用户传任意组合都能过 schema。
      // 不做这一步校验的话，A 章的版本能被灌进 B 章，造成跨章节的静默污染。
      if (revision.chapterId !== input.chapterId) {
        throw AppError.validation('该版本不属于此章节，无法回档')
      }

      const now = new Date().toISOString()

      // 先留当前版本 —— 回档是可撤销的（见方法注释）
      const snapshotKept = this.keepSnapshot(chapter, now)

      /*
       * 正文与三个派生值同样取自快照，**不重算** hanzi / char。
       *
       * 重算在正常情况下会得到同样的数字，但快照存的正是「当时正文 +
       * 当时算出的字数」，两者一致；一旦重算，任何一次度量口径的调整
       * 都会让回档后的字数与历史列表里显示的对不上，看着像回档没生效。
       * 直接搬运保持这一版的自我一致。
       */
      const restored = this.repository.saveContent(
        { id: input.chapterId, contentHtml: revision.contentHtml },
        {
          contentText: revision.contentText,
          hanziCount: revision.hanziCount,
          charCount: revision.charCount
        },
        now
      )

      if (!restored) {
        throw AppError.internal(`章节回档失败（ID: ${input.chapterId}）`)
      }

      // 回档也是一次写作上的改动，书架排序应当跟上
      this.bookRepository.touch(chapter.bookId, now)

      logger.info('章节已回档', {
        chapterId: input.chapterId,
        revisionId: input.revisionId,
        hanzi: restored.hanziCount,
        snapshotKept
      })

      return { ...restored, snapshotKept }
    })
  }

  /**
   * 把「当前这一版」留一份快照，返回是否真的留了。
   *
   * `chapter` 是**本次改动之前**的正文（调用方在写入前读的）。留的正是
   * 这一份 —— 作者后悔时想退回的那一版。
   *
   * 三条留版路径 + 三个跳过条件：
   *
   *  留：
   *   A. **首次见到这一章有正文**（内存里还没有基准）。无条件留 ——
   *      理由见函数体，这一条防的是「重启应用后把一章旧正文覆盖掉」。
   *   B. 与基准的差异 ≥ minDeltaRatio（按汉字数）。
   *   C. 与基准完全相同或差异过小时**不**留（见下）。
   *
   *  跳过：
   *   1. 正文过短（< minHanzi）或为空。新建的章第一次保存就是这种情况 ——
   *      改动前是空正文，留下来只会让列表首行是一条空记录，而空版本
   *      永远没人回退到。这一条**同时不记基准**，理由见函数体。
   *   2. 与**基准正文**完全相同。手动保存与自动保存常常在
   *      几秒内连着触发，两次提交同一份正文；不留这一条，列表会被重复项撑满。
   *   3. 与**基准正文**的差异小于 minDeltaRatio。这是最关键的一条：
   *      自动保存两秒一次，作者敲两三个字就会触发一次。每次都留版的话，
   *      50 版的配额两分钟内就被「多了一个字」填满，而真正想找的
   *      「半小时前那一大段」早在剪枝时被挤掉了。详见该常量的注释。
   *
   * **基准是「上一次真正留版时被替换掉的那份正文」，而不是「最新一版快照」，
   * 也不是「上一次见过的正文」** —— 这两条都是踩出来的：
   *
   *  - 拿**快照表**当基准：被条件 3 拒掉的改动不会留下快照，快照表停在
   *    更早的位置；接下来每一次改动都在跟一个越来越旧的版本比，比例越算
   *    越大，最后「每敲一个字都留一版」。界面上表现为配额被瞬间填满，
   *    剪枝把真正有价值的版本挤出去。
   *  - 拿**上一次见过的正文**当基准（即每次保存后无条件前移）：基准变
   *    「新」得太快。作者写满一整段（够留下）之后又敲了几个字，基准已经被
   *    推到「写满那一版」，于是那几个字是在跟仅仅两秒前的自己比 ——
   *    比例必然很小，永远留不下来。**小改动必须能跨多次保存累积**，
   *    否则「持续小改」这类真实写作节奏永远等不到一次留版。
   *
   * 因此基准只在**真的留版时**（路径 A 与 B）才前移到刚存进快照的那一份；
   * 被跳过时保留旧基准，让差距一路累积到下一次判定。
   *
   * 顺带按 perChapter 剪枝 —— 放在这里而不是定时任务里，因为插入
   * 是唯一让版本数增长的入口，就地剪枝不可能漏；也不用为它起一个
   * 只在小数据量下才需要的后台调度。
   */
  private keepSnapshot(chapter: Chapter, now: string): boolean {
    const metrics = measureText(chapter.contentText)
    const baseline = this.revisionBaseline.get(chapter.id)

    /*
     * 正文过短：**不记基准**。
     *
     * 短正文（新建的章第一次保存，改动前是空正文）没有保存价值，而它
     * 恰恰是基准最容易被一个无意义的值占住的时刻 —— 章刚建好，作者的
     * 输入集中在开头几秒，而自动保存两秒一次，很容易把「空正文」或
     * 「三个字」记成基准。此后每一次真实输入都在跟这个几乎为零的分母比，
     * 比例必然巨大，于是**开头连着留好几版碎片**。
     * 不记基准，等于把基准的初始化推迟到「正文已经写得像样」之后。
     */
    if (metrics.hanzi === 0 || metrics.hanzi < CHAPTER_REVISION_LIMITS.minHanzi) {
      return false
    }

    /*
     * `baseline === undefined`：**首次见到这一章的正文，无条件留下。**
     *
     * 这一条看着像「多留一版」，其实是整个功能里最有价值的一版。进程
     * 重启后 `revisionBaseline` 是空的，而内存里那份基准一旦丢失，
     * 也就无从计算「改了多少」—— 此时若按「没有可比对象就跳过」处理，
     * 后果是：作者重启应用 → 打开一章几千字的旧正文 → 全选删掉重写 →
     * 自动保存 ->代码认为「没什么可比的，跳过」→ **那几千字当场永久消失**，
     * 而历史面板里一版都没有。这恰恰是本功能要解决的那个问题本身，
     * 却在最需要它的时刻失灵。
     *
     * 所以首次见到就留底：这份正文此前从未被保存过，先存下来再覆盖，
     * 代价最多是偶尔多出一版与当前正文相同的记录（作者看得懂，也不碍事），
     * 而收益是「任何一次覆盖之前，原文都已经有一份」。
     */
    if (baseline === undefined) {
      this.insertSnapshotOf(chapter, metrics, now)
      this.revisionBaseline.set(chapter.id, {
        contentHtml: chapter.contentHtml,
        hanziCount: metrics.hanzi
      })
      this.revisionRepository.prune(chapter.id, CHAPTER_REVISION_LIMITS.perChapter)
      return true
    }

    /*
     * 与基准完全相同：连着两次提交同一份正文（手动保存撞上自动保存）。
     * **不更新基准** —— 基准描述的是「上一版留存时的正文」，而这份正文
     * 并没有成为一版，前移会让它被当成「上一版」，把它后面那些小改动
     * 的累积量全部清掉。
     */
    if (baseline.contentHtml === chapter.contentHtml) {
      return false
    }

    /*
     * 差异太小：按**汉字数的差距**占基准的比例判断。
     *
     * 用汉字数而不是字符串长度：正文字数与作者的心智一致（他数的就是字），
     * 而 HTML 长度会被标签与样式带偏，「调了一下行距」不该算作
     * 一次有意义的改动。
     *
     * 分母用基准字数并预留下限 1，避免短正文时除零。
     *
     * 注意分母是**基准**而不是「改动前的正文」：基准是上一次留版时留下的
     * 那一份，因此这里量的是「自上一版留存至今累计改了多少」。单次敲三个字
     * 不达标，但连敲二十次就是一大段 —— 累积量越线时自然会被留下。
     * 若改成跟「两秒前的自己」比，比例永远很小，作者持续小改就永远
     * 等不到一次留版。
     */
    const reference = Math.max(baseline.hanziCount, 1)
    const delta = Math.abs(metrics.hanzi - baseline.hanziCount)
    if (delta / reference < CHAPTER_REVISION_LIMITS.minDeltaRatio) {
      // 不达标：**保留旧基准**，让差距继续累积到下一次
      return false
    }

    this.insertSnapshotOf(chapter, metrics, now)

    /*
     * 基准前移到**刚刚存进快照的这一份**：它正是「现在可以用回档换回来的
     * 那一版」。下一次判定就是拿候选正文与它比 —— 这样每一次留版之间
     * 至少隔着一个阈值，50 个槽位留给真正有跨度的改动。
     */
    this.revisionBaseline.set(chapter.id, {
      contentHtml: chapter.contentHtml,
      hanziCount: metrics.hanzi
    })

    this.revisionRepository.prune(chapter.id, CHAPTER_REVISION_LIMITS.perChapter)
    return true
  }

  /** 把这一份正文写成一版快照。抽出来只为让 `keepSnapshot` 的三条留版路径共用 */
  private insertSnapshotOf(
    chapter: Chapter,
    metrics: { hanzi: number; characters: number },
    now: string
  ): void {
    this.revisionRepository.insertSnapshot({
      chapterId: chapter.id,
      contentHtml: chapter.contentHtml,
      contentText: chapter.contentText,
      hanziCount: metrics.hanzi,
      charCount: metrics.characters,
      createdAt: now
    })
  }

  remove(id: number): { id: number } {
    return runInTransaction(() => {
      const existing = this.repository.findById(id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${id}）`)
      }

      if (!this.repository.deleteById(id)) {
        throw AppError.internal(`章节删除失败（ID: ${id}）`)
      }

      const now = new Date().toISOString()
      // 删掉中间一章后要合拢空位，否则 order_index 出现空洞，
      // 下次拖拽移动时基于顺序的计算会带上这些幽灵下标
      this.reindexContainer(existing.bookId, existing.volumeId, now)
      this.bookRepository.touch(existing.bookId, now)

      logger.info('章节已删除', { id, bookId: existing.bookId })
      return { id }
    })
  }

  reorder(input: ChapterReorderInput): { count: number } {
    return runInTransaction(() => {
      this.assertBookExists(input.bookId)
      if (input.volumeId !== null) {
        this.assertVolumeInBook(input.volumeId, input.bookId)
      }

      const total = this.repository.countInContainer(input.bookId, input.volumeId)

      // 与分卷重排同样的约束：必须提交完整顺序，否则未提交的条目保留旧下标，
      // 产生重复的 order_index，最终顺序取决于 SQLite 的返回顺序而变得不确定
      if (input.orderedIds.length !== total) {
        throw AppError.validation('章节顺序提交不完整，请刷新页面后重试')
      }

      const currentIds = new Set(this.repository.listIdsInContainer(input.bookId, input.volumeId))
      const submitted = new Set(input.orderedIds)
      const sameSet =
        currentIds.size === submitted.size && [...currentIds].every((id) => submitted.has(id))
      if (!sameSet) {
        throw AppError.validation('提交的章节与当前列表不匹配，请刷新页面后重试')
      }

      const changed = this.repository.reorder(input, new Date().toISOString())
      logger.info('章节顺序已更新', { bookId: input.bookId, changed })
      return { count: changed }
    })
  }

  /**
   * 把一章移动到另一个容器（或同容器内换位置）。
   *
   * 这是拖拽落点的实现：调用方只给「目标容器 + 目标下标」，
   * 两份新顺序都由服务层基于当前数据库状态算出来，不接受客户端提交顺序——
   * 否则并发拖拽时客户端手里的旧列表会覆盖掉别人的改动。
   */
  move(input: ChapterMoveInput): ChapterListItem {
    return runInTransaction(() => {
      const existing = this.repository.findById(input.id)
      if (!existing) {
        throw AppError.notFound(`章节不存在（ID: ${input.id}）`)
      }

      if (input.volumeId !== null) {
        this.assertVolumeInBook(input.volumeId, existing.bookId)
      }

      // 目标容器内除自己以外的顺序，然后把自己插到目标下标处
      const targetIds = this.repository
        .listIdsInContainer(existing.bookId, input.volumeId)
        .filter((id) => id !== input.id)

      const targetIndex = Math.max(0, Math.min(input.targetIndex, targetIds.length))
      const nextTargetIds = [
        ...targetIds.slice(0, targetIndex),
        input.id,
        ...targetIds.slice(targetIndex)
      ]

      /*
       * 源容器需要「合拢被抽走留下的空位」—— 但**仅当容器真的换了**。
       *
       * 同容器内换位时不能再压缩一次源：此时 nextTargetIds 已经包含全部兄弟
       * 节点并编号为 0..n-1，若再拿「去掉自己的旧列表」按 0..n-2 编一遍，
       * 就会把它前面那些节点的下标覆盖回去，出现两个相同的 order_index。
       * 结果取决于 SQLite 的返回顺序 —— 把末位节点往前移就会排错。
       * 传空数组表示「源容器没有需要压缩的东西」。
       */
      const sourceIds =
        input.volumeId === existing.volumeId
          ? []
          : this.repository.listIdsInContainer(existing.bookId, existing.volumeId)

      const now = new Date().toISOString()
      this.repository.applyMove(input, sourceIds, nextTargetIds, now)
      this.bookRepository.touch(existing.bookId, now)

      const updated = this.repository.findListItemById(input.id)
      if (!updated) {
        throw AppError.internal(`章节移动后无法回读（ID: ${input.id}）`)
      }

      logger.info('章节已移动', {
        id: updated.id,
        bookId: existing.bookId,
        targetIndex
      })
      return updated
    })
  }

  /* ------------------------------------------------------------------ */

  private reindexContainer(bookId: number, volumeId: number | null, now: string): void {
    const ids = this.repository.listIdsInContainer(bookId, volumeId)
    if (ids.length === 0) return
    this.repository.reorder({ bookId, volumeId, orderedIds: ids }, now)
  }

  private assertBookExists(bookId: number): void {
    if (!this.bookRepository.exists(bookId)) {
      throw AppError.notFound(`书籍不存在（ID: ${bookId}）`)
    }
  }

  private assertVolumeInBook(volumeId: number, bookId: number): void {
    const volume = this.volumeRepository.findById(volumeId)
    if (!volume) {
      throw AppError.notFound(`分卷不存在（ID: ${volumeId}）`)
    }
    // 跨书挂载是典型的越权写入：会让 A 书的章节出现在 B 书的目录里。
    // 校验归属而不是只校验存在，是这类 bug 的唯一防线。
    if (volume.bookId !== bookId) {
      throw AppError.validation('分卷不属于当前书籍，无法挂载章节')
    }
  }
}
