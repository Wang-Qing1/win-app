import { describe, expect, test, vi, beforeEach } from 'vitest'

const showSaveDialog = vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>()

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) }
}))

const writeFile = vi.fn<(...args: unknown[]) => Promise<void>>()
vi.mock('node:fs/promises', () => ({ writeFile: (...args: unknown[]) => writeFile(...args) }))

const { ExportService } = await import('./export.service')
type ChapterWithContent = { id: number; bookId: number; volumeId: number | null; title: string; contentText: string }

function makeChapterRepository(overrides: {
  findById?: (id: number) => unknown
  listWithContent?: (query: { bookId: number; volumeId?: number | null }) => ChapterWithContent[]
} = {}) {
  return {
    findById: overrides.findById ?? (() => null),
    listWithContent: overrides.listWithContent ?? (() => [])
  }
}

function makeBookRepository(overrides: { findById?: (id: number) => unknown } = {}) {
  return { findById: overrides.findById ?? (() => null) }
}

function makeVolumeRepository(overrides: { findById?: (id: number) => unknown } = {}) {
  return { findById: overrides.findById ?? (() => null) }
}

const fakeSender = {} as never

beforeEach(() => {
  showSaveDialog.mockReset()
  writeFile.mockClear()
})

describe('ExportService.exportBook', () => {
  test('throws NOT_FOUND when the book does not exist', async () => {
    const service = new ExportService(
      makeChapterRepository() as never,
      makeBookRepository() as never,
      makeVolumeRepository() as never
    )

    await expect(service.exportBook({ bookId: 1, format: 'txt' }, fakeSender)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  test('throws VALIDATION_ERROR when the book has no chapters', async () => {
    const service = new ExportService(
      makeChapterRepository({ listWithContent: () => [] }) as never,
      makeBookRepository({ findById: () => ({ id: 1, title: '星河旅人' }) }) as never,
      makeVolumeRepository() as never
    )

    await expect(service.exportBook({ bookId: 1, format: 'txt' }, fakeSender)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
  })

  test('joins every chapter in repository order into one file and reports canceled:false with the write result', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\out\\星河旅人.txt' })
    const chapters: ChapterWithContent[] = [
      { id: 1, bookId: 1, volumeId: null, title: '第一章', contentText: '开头' },
      { id: 2, bookId: 1, volumeId: null, title: '第二章', contentText: '结尾' }
    ]
    const service = new ExportService(
      makeChapterRepository({ listWithContent: () => chapters }) as never,
      makeBookRepository({ findById: () => ({ id: 1, title: '星河旅人' }) }) as never,
      makeVolumeRepository() as never
    )

    const result = await service.exportBook({ bookId: 1, format: 'txt' }, fakeSender)

    expect(result.canceled).toBe(false)
    expect(result.chapterCount).toBe(2)
    expect(result.filePath).toBe('C:\\out\\星河旅人.txt')
    expect(writeFile).toHaveBeenCalledTimes(1)
    const written = writeFile.mock.calls[0][1] as string
    expect(written).toContain('第一章')
    expect(written).toContain('开头')
    expect(written).toContain('第二章')
    expect(written).toContain('结尾')
    expect(written.indexOf('第一章')).toBeLessThan(written.indexOf('第二章'))
  })

  test('uses the sanitized book title as the suggested file name', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\out\\x.txt' })
    const service = new ExportService(
      makeChapterRepository({ listWithContent: () => [{ id: 1, bookId: 1, volumeId: null, title: '章', contentText: '文' }] }) as never,
      makeBookRepository({ findById: () => ({ id: 1, title: '书名：星海?' }) }) as never,
      makeVolumeRepository() as never
    )

    const result = await service.exportBook({ bookId: 1, format: 'txt' }, fakeSender)
    expect(result.suggestedName).toBe('书名：星海.txt')
  })

  test('returns canceled:true without writing a file when the user cancels the save dialog', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const service = new ExportService(
      makeChapterRepository({ listWithContent: () => [{ id: 1, bookId: 1, volumeId: null, title: '章', contentText: '文' }] }) as never,
      makeBookRepository({ findById: () => ({ id: 1, title: '书' }) }) as never,
      makeVolumeRepository() as never
    )

    const result = await service.exportBook({ bookId: 1, format: 'txt' }, fakeSender)
    expect(result).toMatchObject({ canceled: true, filePath: null, bytes: 0 })
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe('ExportService.exportVolume', () => {
  test('throws NOT_FOUND when the volume does not exist', async () => {
    const service = new ExportService(
      makeChapterRepository() as never,
      makeBookRepository() as never,
      makeVolumeRepository() as never
    )

    await expect(service.exportVolume({ volumeId: 9, format: 'txt' }, fakeSender)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  test('throws VALIDATION_ERROR when the volume has no chapters', async () => {
    const service = new ExportService(
      makeChapterRepository({ listWithContent: () => [] }) as never,
      makeBookRepository({ findById: () => ({ id: 1, title: '书' }) }) as never,
      makeVolumeRepository({ findById: () => ({ id: 9, bookId: 1, title: '第一卷' }) }) as never
    )

    await expect(service.exportVolume({ volumeId: 9, format: 'txt' }, fakeSender)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR'
    })
  })

  test('only queries chapters scoped to that volume, and names the file book-volume', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\out\\x.txt' })
    let receivedQuery: { bookId: number; volumeId?: number | null } | null = null
    const service = new ExportService(
      makeChapterRepository({
        listWithContent: (query) => {
          receivedQuery = query
          return [{ id: 5, bookId: 1, volumeId: 9, title: '章', contentText: '文' }]
        }
      }) as never,
      makeBookRepository({ findById: () => ({ id: 1, title: '星海旅人' }) }) as never,
      makeVolumeRepository({ findById: () => ({ id: 9, bookId: 1, title: '第一卷 启程' }) }) as never
    )

    const result = await service.exportVolume({ volumeId: 9, format: 'txt' }, fakeSender)

    expect(receivedQuery).toEqual({ bookId: 1, volumeId: 9 })
    expect(result.chapterCount).toBe(1)
    expect(result.suggestedName).toBe('星海旅人-第一卷 启程.txt')
  })
})
