import { z } from 'zod'

/**
 * 草稿导出模块的领域契约。
 *
 * 名字虽然叫 export，但它做的其实是「把一章正文写成磁盘上的纯文本文件」。
 * 之所以仍然值得单开一个模块而不是塞进 chapters：它需要主进程的
 * 系统能力（文件对话框、写文件），而 chapters 模块是纯数据操作，
 * 两者混在一起会让章节服务意外依赖 Electron 的窗口对象。
 *
 * 关于 txt 与 md 的区别：这里不做 Markdown 语法转换，只影响标题行
 * 与段落之间的排版。网文平台接收的是纯文本，所以 txt 是主路径。
 */

export const EXPORT_FORMATS = ['txt', 'md'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  txt: '纯文本（.txt）',
  md: 'Markdown（.md）'
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)
}

export const exportChapterSchema = z.object({
  chapterId: z.number().int().positive('章节 ID 非法'),
  format: z.string().refine(isExportFormat, '导出格式不支持').default('txt')
})

export type ExportChapterInput = z.infer<typeof exportChapterSchema>

/**
 * 导出回执。
 *
 * canceled 单独成字段而不是靠 filePath === null 判断：用户主动取消
 * 与「写文件失败」是两件事，前者不该弹错误提示。把它们混成一种状态
 * 会让每次取消都冒出一条红字，用户会以为出了问题。
 */
export interface ExportChapterResult {
  canceled: boolean
  filePath: string | null
  bytes: number
  /** 建议的文件名（导出前的默认名），取消时也返回，便于界面提示 */
  suggestedName: string
}

/** 导出时的默认文件名：书名-章节标题.txt。非法字符由主进程统一清洗 */
export const EXPORT_FILENAME_MAX = 120
