import { describe, expect, test } from 'vitest'
import { countHanzi, countNonWhitespace, htmlToText, measureHtml, measureText } from './text'

describe('countHanzi', () => {
  test('counts only Han characters, ignoring punctuation/digits/letters', () => {
    expect(countHanzi('你好，world 123！')).toBe(2)
  })

  test('counts rare Han characters outside the BMP (Extension B and beyond)', () => {
    expect(countHanzi('\u{20000}\u{2A6DF}')).toBe(2)
  })

  test('returns 0 for empty string', () => {
    expect(countHanzi('')).toBe(0)
  })

  test('returns 0 when there is no Han character', () => {
    expect(countHanzi('hello, world! 123')).toBe(0)
  })
})

describe('countNonWhitespace', () => {
  test('counts punctuation and letters but not spaces', () => {
    expect(countNonWhitespace('a b  c')).toBe(3)
  })

  test('treats the non-breaking space (\\u00a0) as whitespace', () => {
    expect(countNonWhitespace('a b')).toBe(2)
  })

  test('returns 0 for empty string', () => {
    expect(countNonWhitespace('')).toBe(0)
  })
})

describe('measureText', () => {
  test('reports both hanzi and character counts together', () => {
    expect(measureText('你好 world')).toEqual({ hanzi: 2, characters: 7 })
  })
})

describe('htmlToText', () => {
  test('turns block tag boundaries into newlines (each open+close tag contributes one)', () => {
    expect(htmlToText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段')
  })

  test('turns <br> into a newline', () => {
    expect(htmlToText('一行<br>二行')).toBe('一行\n二行')
  })

  test('strips inline tags without inserting whitespace', () => {
    expect(htmlToText('<p>粗体<strong>字</strong>结束</p>')).toBe('粗体字结束')
  })

  test('decodes named entities', () => {
    expect(htmlToText('<p>A &amp; B &lt;tag&gt;</p>')).toBe('A & B <tag>')
  })

  test('decodes numeric and hex entities', () => {
    expect(htmlToText('<p>&#20320;&#x597d;</p>')).toBe('你好')
  })

  test('strips tags before decoding entities, so literal &lt;p&gt; in text is not re-parsed as a tag', () => {
    expect(htmlToText('<p>示例：&lt;p&gt;标签&lt;/p&gt;</p>')).toBe('示例：<p>标签</p>')
  })

  test('collapses 3+ consecutive blank lines down to at most one blank line', () => {
    expect(htmlToText('<p>A</p><p></p><p></p><p></p><p>B</p>')).toBe('A\n\nB')
  })

  test('trims leading/trailing whitespace from the result', () => {
    expect(htmlToText('<p>  内容  </p>')).toBe('内容')
  })

  test('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('')
  })
})

describe('measureHtml', () => {
  test('measures the plain-text projection of the HTML, not the markup', () => {
    expect(measureHtml('<p>你好 <strong>world</strong></p>')).toEqual({ hanzi: 2, characters: 7 })
  })
})
