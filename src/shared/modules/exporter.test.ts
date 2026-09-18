import { describe, expect, test } from 'vitest'
import { exportBookSchema, exportChapterSchema, exportVolumeSchema, isExportFormat } from './exporter'

describe('isExportFormat', () => {
  test('accepts txt and md', () => {
    expect(isExportFormat('txt')).toBe(true)
    expect(isExportFormat('md')).toBe(true)
  })

  test('rejects unsupported formats and non-strings', () => {
    expect(isExportFormat('docx')).toBe(false)
    expect(isExportFormat(1)).toBe(false)
  })
})

describe('exportChapterSchema', () => {
  test('defaults format to txt when omitted', () => {
    expect(exportChapterSchema.parse({ chapterId: 1 })).toEqual({ chapterId: 1, format: 'txt' })
  })

  test('rejects a non-positive chapterId', () => {
    expect(() => exportChapterSchema.parse({ chapterId: 0 })).toThrow()
  })
})

describe('exportBookSchema', () => {
  test('accepts a positive bookId and defaults format to txt', () => {
    expect(exportBookSchema.parse({ bookId: 3 })).toEqual({ bookId: 3, format: 'txt' })
  })

  test('accepts an explicit md format', () => {
    expect(exportBookSchema.parse({ bookId: 3, format: 'md' })).toEqual({ bookId: 3, format: 'md' })
  })

  test('rejects a non-positive bookId', () => {
    expect(() => exportBookSchema.parse({ bookId: 0 })).toThrow()
  })

  test('rejects an unsupported format', () => {
    expect(() => exportBookSchema.parse({ bookId: 3, format: 'epub' })).toThrow()
  })
})

describe('exportVolumeSchema', () => {
  test('accepts a positive volumeId and defaults format to txt', () => {
    expect(exportVolumeSchema.parse({ volumeId: 7 })).toEqual({ volumeId: 7, format: 'txt' })
  })

  test('rejects a non-positive volumeId', () => {
    expect(() => exportVolumeSchema.parse({ volumeId: -1 })).toThrow()
  })

  test('rejects an unsupported format', () => {
    expect(() => exportVolumeSchema.parse({ volumeId: 7, format: 'pdf' })).toThrow()
  })
})
