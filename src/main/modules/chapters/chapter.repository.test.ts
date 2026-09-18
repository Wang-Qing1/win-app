import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { migrations } from '../../db/migrations'
import type { Db } from '../../db/types'
import { ChapterRepository } from './chapter.repository'

let db: Db
let repository: ChapterRepository

function insertBook(id: number, title: string): void {
  db.prepare(
    `INSERT INTO books (id, title, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, title)
}

function insertVolume(id: number, bookId: number, title: string, orderIndex: number): void {
  db.prepare(
    `INSERT INTO volumes (id, book_id, title, order_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, bookId, title, orderIndex)
}

function insertChapter(
  id: number,
  bookId: number,
  volumeId: number | null,
  title: string,
  contentText: string,
  orderIndex: number
): void {
  db.prepare(
    `INSERT INTO chapters (id, book_id, volume_id, title, content_text, order_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, bookId, volumeId, title, contentText, orderIndex)
}

beforeEach(() => {
  db = new Database(':memory:')
  for (const migration of migrations) migration.up(db)
  repository = new ChapterRepository(db)

  insertBook(1, '星海归途')
  insertVolume(10, 1, '第一卷', 0)
  insertVolume(20, 1, '第二卷', 1)
  insertChapter(101, 1, 10, '第一章', 'A', 0)
  insertChapter(102, 1, 10, '第二章', 'B', 1)
  insertChapter(201, 1, 20, '第三章', 'D', 0)
  insertChapter(301, 1, null, '番外', 'C', 0)
})

describe('ChapterRepository.listWithContent', () => {
  test('whole-book query (volumeId undefined) returns every chapter with its content, volumes first in order then unassigned last', () => {
    const rows = repository.listWithContent({ bookId: 1, volumeId: undefined })
    expect(rows.map((row) => row.id)).toEqual([101, 102, 201, 301])
    expect(rows.map((row) => row.contentText)).toEqual(['A', 'B', 'D', 'C'])
  })

  test('scoping to one volume returns only that volume\'s chapters, in order_index order', () => {
    const rows = repository.listWithContent({ bookId: 1, volumeId: 10 })
    expect(rows.map((row) => row.id)).toEqual([101, 102])
    expect(rows.every((row) => row.volumeId === 10)).toBe(true)
  })

  test('volumeId: null returns only the unassigned chapters', () => {
    const rows = repository.listWithContent({ bookId: 1, volumeId: null })
    expect(rows.map((row) => row.id)).toEqual([301])
  })

  test('returns an empty array for a book with no chapters', () => {
    insertBook(2, '无章书')
    expect(repository.listWithContent({ bookId: 2, volumeId: undefined })).toEqual([])
  })

  test('each row carries the same metadata shape as ChapterListItem, plus contentText', () => {
    const [row] = repository.listWithContent({ bookId: 1, volumeId: 10 })
    expect(row).toMatchObject({
      id: 101,
      bookId: 1,
      volumeId: 10,
      title: '第一章',
      orderIndex: 0,
      contentText: 'A'
    })
    expect(typeof row.hanziCount).toBe('number')
  })
})
