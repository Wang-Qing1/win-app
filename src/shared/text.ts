/**
 * 文本度量与 HTML 转纯文本。
 *
 * 这个文件被主进程与渲染进程共用，这一点是刻意的：
 * 编辑器里实时显示的字数、主进程落库的 hanzi_count、统计页聚合出的总数，
 * 必须来自同一个函数。若两侧各写一份实现，界面上显示的字数会和统计页对不上，
 * 而且这种偏差很难被发现——用户只会觉得「这个软件的数字不准」。
 */

/** 中日韩统一表意文字，\p{Script=Han} 已覆盖 CJK 各扩展平面（含生僻字） */
const HAN_PATTERN = /\p{Script=Han}/gu

/** 非空白字符。注意 JS 的 \s 包含 \u00a0（不间断空格），因此它不会被计入 */
const NON_WHITESPACE_PATTERN = /\S/gu

export interface TextMetrics {
  /** 汉字数：不计标点、数字、字母、空格 */
  hanzi: number
  /** 非空白字符数（含标点与字母数字），用于与网文平台显示的字数对照 */
  characters: number
}

/**
 * 统计汉字数 —— 本项目的主口径。
 *
 * 用 Unicode Script 属性而不是 `[\u4e00-\u9fa5]` 这类区间：
 * 后者漏掉扩展 B 区之后的生僻字，而这些字在小说的人名、古籍风设定里很常见，
 * 一旦漏算，作者会发现某些章节的字数「莫名其妙少了几百」。
 */
export function countHanzi(text: string): number {
  if (text.length === 0) return 0
  return text.match(HAN_PATTERN)?.length ?? 0
}

/** 统计非空白字符数 —— 起点、番茄等平台显示的字数口径更接近这个 */
export function countNonWhitespace(text: string): number {
  if (text.length === 0) return 0
  return text.match(NON_WHITESPACE_PATTERN)?.length ?? 0
}

export function measureText(text: string): TextMetrics {
  return { hanzi: countHanzi(text), characters: countNonWhitespace(text) }
}

/* ------------------------------------------------------------------ *
 * HTML → 纯文本
 *
 * 富文本编辑器产出的是 HTML，但字数统计与全文搜索都只需要文本。
 * 与其在各个调用点零散地写「去标签」，不如集中在这里做一次，
 * 让 content_text 成为 content_html 的一个确定、可复现的函数结果。
 * ------------------------------------------------------------------ */

/**
 * 块级标签：它们的边界应当转换为换行。
 * 少了这一步，两段之间的字会被当成同一行连起来，虽然不影响汉字总数，
 * 但会让基于 content_text 的搜索结果难以阅读。
 */
const BLOCK_TAG_NAMES = 'p|div|h[1-6]|li|blockquote|pre|tr|section|article|figure|figcaption'

const BR_TAG = /<br\s*\/?>/gi
const BLOCK_CLOSE_TAG = new RegExp(`</(?:${BLOCK_TAG_NAMES})\\s*>`, 'gi')
const BLOCK_OPEN_TAG = new RegExp(`<(?:${BLOCK_TAG_NAMES})\\b[^>]*>`, 'gi')
const ANY_TAG = /<[^>]*>/g

/** 常用的命名实体。不在表里的实体会原样保留，不会被悄悄吃掉 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×'
}

const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

function safeFromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null
  // 代理区（0xD800-0xDFFF）单独出现时 fromCodePoint 会产出非法字符
  if (code >= 0xd800 && code <= 0xdfff) return null
  try {
    return String.fromCodePoint(code)
  } catch {
    return null
  }
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return safeFromCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole
    }
    if (body.startsWith('#')) {
      return safeFromCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * 把编辑器产出的 HTML 转成纯文本。
 *
 * 顺序很重要：必须**先剥标签再解实体**。反过来的话，正文里字面写出的
 * `&lt;p&gt;` 会在解码后变成 `<p>`，然后在下一步被当成标签删掉——
 * 作者写的示例标记就凭空消失了。
 */
export function htmlToText(html: string): string {
  if (html.length === 0) return ''

  return decodeEntities(
    html.replace(BR_TAG, '\n').replace(BLOCK_CLOSE_TAG, '\n').replace(BLOCK_OPEN_TAG, '\n').replace(ANY_TAG, '')
  )
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 HTML 直接算出两个字数，省掉调用方自己转文本的一步 */
export function measureHtml(html: string): TextMetrics {
  return measureText(htmlToText(html))
}
