import { IpcChannel } from '@shared/ipc-channels'
import { exportBookSchema, exportChapterSchema, exportVolumeSchema } from '@shared/modules/exporter'
import { registerHandler } from '../../core/ipc-handler'
import type { ExportService } from './export.service'

/**
 * 控制器层。
 *
 * 这里比别的控制器多了一件事：把 ctx.event.sender 透传给服务。
 * 导出要弹系统保存对话框，而对话框需要一个父窗口 —— 父窗口只能从
 * 「是谁发起的这次调用」推出来。把 sender 而不是 BrowserWindow 传下去，
 * 是因为服务层据此自己解析窗口，控制器不必知道窗口构造的细节。
 */
export function registerExportHandlers(service: ExportService): void {
  registerHandler(IpcChannel.ExporterChapter, {
    label: '导出章节草稿',
    parse: (raw) => exportChapterSchema.parse(raw),
    handle: (input, ctx) => service.exportChapter(input, ctx.event.sender)
  })

  registerHandler(IpcChannel.ExporterBook, {
    label: '导出整本书草稿',
    parse: (raw) => exportBookSchema.parse(raw),
    handle: (input, ctx) => service.exportBook(input, ctx.event.sender)
  })

  registerHandler(IpcChannel.ExporterVolume, {
    label: '导出整卷草稿',
    parse: (raw) => exportVolumeSchema.parse(raw),
    handle: (input, ctx) => service.exportVolume(input, ctx.event.sender)
  })
}
