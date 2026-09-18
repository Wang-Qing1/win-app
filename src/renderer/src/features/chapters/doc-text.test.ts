import { Schema } from '@tiptap/pm/model'
import { describe, expect, test } from 'vitest'
import {
  extractDocText,
  findTextRanges,
  mapTextRange,
  nearestRange,
  offsetOfPosition,
  paragraphIndexOfOffset,
  paragraphRange,
  positionOfOffset
} from './doc-text'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false }
  }
})

/** 两个段落，第二段中间带一个硬换行——同时覆盖“段间分隔”与“行内硬换行”两种情况 */
function buildTwoParagraphDoc() {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('abc')]),
    schema.node('paragraph', null, [schema.text('def'), schema.node('hardBreak'), schema.text('ghi')])
  ])
}

function buildSingleParagraphDoc(text: string) {
  return schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
}

describe('extractDocText', () => {
  test('joins block siblings with the block separator and renders hardBreak as a single newline', () => {
    const doc = buildTwoParagraphDoc()
    const { text } = extractDocText(doc)
    expect(text).toBe('abc\n\ndef\nghi')
  })

  test('matches ProseMirror\'s own textBetween using the same separators (independent oracle check)', () => {
    const doc = buildTwoParagraphDoc()
    const { text } = extractDocText(doc)
    expect(text).toBe(doc.textBetween(0, doc.content.size, '\n\n', '\n'))
  })

  test('every span slice of the plain text equals doc.textBetween for that span\'s PM range', () => {
    const doc = buildTwoParagraphDoc()
    const { text, spans } = extractDocText(doc)
    for (const span of spans) {
      const plain = text.slice(span.start, span.start + (span.to - span.from))
      expect(doc.textBetween(span.from, span.to, undefined, '\n')).toBe(plain)
    }
  })

  test('produces one span per text/hardBreak leaf (no span for the inserted separator itself)', () => {
    const doc = buildTwoParagraphDoc()
    const { spans } = extractDocText(doc)
    expect(spans).toHaveLength(4)
  })
})

describe('mapTextRange', () => {
  test('maps a plain-text range back to a PM range whose textBetween matches the original slice', () => {
    const doc = buildSingleParagraphDoc('hello world')
    const docText = extractDocText(doc)
    const range = mapTextRange(docText, 0, 5)
    expect(range).not.toBeNull()
    expect(doc.textBetween(range!.from, range!.to)).toBe('hello')
  })

  test('maps a range in the middle of the text', () => {
    const doc = buildSingleParagraphDoc('hello world')
    const docText = extractDocText(doc)
    const range = mapTextRange(docText, 6, 11)
    expect(range).not.toBeNull()
    expect(doc.textBetween(range!.from, range!.to)).toBe('world')
  })

  test('returns null for an empty (start === end) range', () => {
    const doc = buildSingleParagraphDoc('hello world')
    const docText = extractDocText(doc)
    expect(mapTextRange(docText, 5, 5)).toBeNull()
  })

  test('returns null when the document has no spans at all', () => {
    expect(mapTextRange({ text: '', spans: [] }, 0, 1)).toBeNull()
  })
})

describe('positionOfOffset / offsetOfPosition round-trip', () => {
  test('round-trips an interior offset back to itself through a PM position', () => {
    const doc = buildSingleParagraphDoc('hello world')
    const docText = extractDocText(doc)
    const position = positionOfOffset(docText, 5)
    expect(position).not.toBeNull()
    expect(offsetOfPosition(docText, position!)).toBe(5)
  })

  test('positionOfOffset returns null for an out-of-range offset', () => {
    const doc = buildSingleParagraphDoc('hi')
    const docText = extractDocText(doc)
    expect(positionOfOffset(docText, 999)).toBeNull()
  })
})

describe('findTextRanges', () => {
  test('finds all non-overlapping occurrences, case-insensitively by default', () => {
    expect(findTextRanges('Hello world, hello again', 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 13, end: 18 }
    ])
  })

  test('does not find overlapping matches (first match wins, like mainstream editors)', () => {
    expect(findTextRanges('哈哈哈', '哈哈')).toEqual([{ start: 0, end: 2 }])
  })

  test('respects caseSensitive: true', () => {
    expect(findTextRanges('Hello', 'hello', true)).toEqual([])
  })

  test('returns an empty array for an empty needle or empty haystack', () => {
    expect(findTextRanges('', 'a')).toEqual([])
    expect(findTextRanges('abc', '')).toEqual([])
  })
})

describe('nearestRange', () => {
  test('picks the range whose start is closest to the given offset', () => {
    const ranges = [
      { start: 0, end: 2 },
      { start: 10, end: 12 }
    ]
    expect(nearestRange(ranges, 9)).toEqual({ start: 10, end: 12 })
  })

  test('returns null for an empty candidate list', () => {
    expect(nearestRange([], 5)).toBeNull()
  })
})

describe('paragraphIndexOfOffset / paragraphRange', () => {
  const text = 'abc\n\ndef\nghi'

  test('a hardBreak\'s single newline does not count as a paragraph boundary, only the double newline does', () => {
    expect(paragraphIndexOfOffset(text, 9)).toBe(1)
  })

  test('an offset before the first paragraph break is paragraph 0', () => {
    expect(paragraphIndexOfOffset(text, 1)).toBe(0)
  })

  test('paragraphRange returns the plain-text bounds of a paragraph, hardBreak included', () => {
    expect(paragraphRange(text, 1)).toEqual({ start: 5, end: 12 })
    expect(text.slice(5, 12)).toBe('def\nghi')
  })

  test('paragraphRange returns null for a negative or out-of-range index', () => {
    expect(paragraphRange(text, -1)).toBeNull()
    expect(paragraphRange(text, 99)).toBeNull()
  })
})
