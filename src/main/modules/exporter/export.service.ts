import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, type WebContents } from 'electron'
import type { ExportChapterInput, ExportChapterResult, ExportFormat } from '@shared/modules/exporter'
import { EXPORT_FILENAME_MAX } from '@shared/modules/exporter'
import { AppError } from '../../core/errors'
import { logger } from '../../core/logger'
import type { BookRepository } from '../books/book.repository'
import type { ChapterRepository } from '../chapters/chapter.repository'

/**
 * 草稿导出服务。
 *
 * 这是全项目唯一会碰系统文件对话框的模块，因此也是唯一需要 Electron
 * 运行时对象的服务（其余服务都只依赖仓储，纯数据）。把它单独隔离出来，
 * 是为了让 chapters 那套核心服务保持「可脱离 Electron 单测」的性质。
 */
export class ExportService {
  constructor(
    private readonly chapterRepository: ChapterRepository,
    private readonly bookRepository: BookRepository
  ) {}

  async exportChapter(
    input: ExportChapterInput,
    sender: WebContents
  ): Promise<ExportChapterResult> {
    const chapter = this.chapterRepository.findById(input.chapterId)
    if (!chapter) {
      throw AppError.notFound(`章节不存在（ID: ${input.chapterId}）`)
    }

    const book = this.bookRepository.findById(chapter.bookId)
    const bookTitle = book?.title ?? '未命名书籍'
    const suggestedName = `${sanitizeFileName(bookTitle)}-${sanitizeFileName(chapter.title)}.${input.format}`

    const content = renderDraft(chapter.title, chapter.contentText, input.format)

    // 用发起请求的那个窗口当父窗口，对话框才会是应用内的模态框；
    // 不传的话在 Windows 上会变成一个可以被主窗口盖住的游离窗口
    const parent = BrowserWindow.fromWebContents(sender)
    const options = {
      title: '发布草稿',
      defaultPath: suggestedName,
      filters:
        input.format === 'md'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: '纯文本', extensions: ['txt'] }]
    }

    const result =
      parent !== null
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)

    if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
      // 取消不是错误：调用方据此安静地什么都不做
      return { canceled: true, filePath: null, bytes: 0, suggestedName }
    }

    await writeFile(result.filePath, content, 'utf8')

    const bytes = Buffer.byteLength(content, 'utf8')
    logger.info('草稿已导出', { chapterId: chapter.id, bytes, format: input.format })

    return { canceled: false, filePath: result.filePath, bytes, suggestedName }
  }
}

/**
 * 组装导出内容。
 *
 * 正文用 contentText（HTML 的纯文本投影）而不是现解析 contentHtml：
 * 那份投影在每次保存正文时已经算好并落库，它与界面显示的字数出自
 * 同一次计算，用它导出能保证「导出的字数」和「应用里显示的字数」一致。
 */
function renderDraft(chapterTitle: string, contentText: string, format: ExportFormat): string {
  const body = contentText.replace(/\r\n?/g, '\n').trim()
  const header = format === 'md' ? `# ${chapterTitle}` : `${chapterTitle}`

  // 末尾补一个换行：老式编辑器（记事本、部分投稿后台的粘贴框）
  // 在文件末尾没有换行时会把最后一段和后续内容粘在一起
  return `${header}\n\n${body}\n`
}

/**
 * 清洗文件名。
 *
 * Windows 的文件名禁用字符比 POSIX 多得多（: * ? " < > | 以及路径分隔符），
 * 而书名里出现「？」「：」的概率极高——网文标题里这两种标点几乎是标配。
 * 不清洗的话保存对话框会直接报错，用户完全不知道哪里出了问题。
 */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 不允许文件名以点或空格结尾
    .replace(/[. ]+$/, '')

  const fallback = cleaned.length > 0 ? cleaned : '未命名'
  return fallback.length > EXPORT_FILENAME_MAX ? fallback.slice(0, EXPORT_FILENAME_MAX) : fallback
}
