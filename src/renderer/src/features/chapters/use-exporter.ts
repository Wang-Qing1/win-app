import { useMutation } from '@tanstack/react-query'
import type {
  ExportBatchResult,
  ExportBookInput,
  ExportChapterInput,
  ExportChapterResult,
  ExportVolumeInput
} from '@shared/modules/exporter'
import { ApiError, getBridge, invoke } from '../../lib/api-client'

/**
 * 导出章节草稿。
 *
 * 没有 onSuccess 缓存失效：导出是只读操作，不改动任何数据。
 * 唯一需要反应的是「用户取消了对话框」，那由返回值里的 canceled 表达，
 * 而不是异常 —— 取消是正常操作，不该走错误路径。
 */
export function useExportChapter() {
  return useMutation<ExportChapterResult, ApiError, ExportChapterInput>({
    mutationFn: (input) => invoke(() => getBridge().exporter.chapter(input))
  })
}

/** 导出整本书（含未分卷），同样只需处理 canceled，不需要失效任何缓存 */
export function useExportBook() {
  return useMutation<ExportBatchResult, ApiError, ExportBookInput>({
    mutationFn: (input) => invoke(() => getBridge().exporter.book(input))
  })
}

/** 导出整卷 */
export function useExportVolume() {
  return useMutation<ExportBatchResult, ApiError, ExportVolumeInput>({
    mutationFn: (input) => invoke(() => getBridge().exporter.volume(input))
  })
}
