import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

/**
 * ProseMirror 文档 ↔ 纯文本的双向映射。
 *
 * 为什么需要它：校对规则工作在**纯文本下标**上（这样规则引擎不依赖任何
 * 富文本库，可以在主进程里单独测），而高亮装饰需要的是 **ProseMirror 的
 * 文档位置**。两者之间的换算没有现成 API，只能自己走一遍文档树把它建出来。
 *
 * 关键点：文本与映射必须**在同一次遍历里**生成。若先取文本再单独定位，
 * 两边的段落分隔符约定稍有出入，所有位置就会整体偏移——而偏移的错误
 * 表现得非常隐蔽：下划线落在错误的字上，用户只会觉得「这软件标错了」。
 */

export interface TextSpan {
  /** 该文本片段对应的 ProseMirror 起止位置（半开区间） */
  from: number
  to: number
  /** 该片段在纯文本中的起始下标 */
  start: number
}

export interface DocText {
  text: string
  spans: TextSpan[]
}

/** 段落之间的分隔符。与 TipTap 的 getText 默认值一致 */
const BLOCK_SEPARATOR = '\n\n'

export function extractDocText(doc: ProseMirrorNode): DocText {
  const spans: TextSpan[] = []
  const parts: string[] = []
  let length = 0
  /** 最近一次压入的片段。用来判断末尾是否已经是分隔符，避免重复插入 */
  let tail = ''

  const push = (value: string, from: number, to: number): void => {
    if (value.length === 0) return
    spans.push({ from, to, start: length })
    parts.push(value)
    length += value.length
    tail = value
  }

  const walk = (node: ProseMirrorNode, pos: number): void => {
    if (node.isText) {
      const value = node.text ?? ''
      push(value, pos, pos + value.length)
      return
    }

    if (node.isLeaf) {
      // 硬换行在纯文本里就是一个换行符；其余内联叶子（图片等）没有文本表示
      if (node.type.name === 'hardBreak') {
        push('\n', pos, pos + node.nodeSize)
      }
      return
    }

    let seenChild = false
    node.forEach((child, offset) => {
      const childPos = pos + 1 + offset
      // 只在块级子节点之间插分隔符：段落内部是若干内联节点，
      // 在它们之间插换行会把一个句子切成几段，校对结果随之错乱。
      // 末尾的守卫避免嵌套容器连续插入两遍分隔符。
      if (seenChild && child.isBlock && tail !== BLOCK_SEPARATOR) {
        parts.push(BLOCK_SEPARATOR)
        length += BLOCK_SEPARATOR.length
        tail = BLOCK_SEPARATOR
      }
      seenChild = true
      walk(child, childPos)
    })
  }

  /*
   * 起点必须是 -1，不是 0。
   *
   * `walk` 里 `pos + 1 + offset` 算的是子节点「正前方」那个位置（等于 ProseMirror
   * 给这个子节点自己的位置），所以需要传进来的 pos 是**父节点内容起点的前一位**。
   * 文档顶层内容从位置 0 开始，于是这里要用 -1。
   *
   * 举例：`<p>abc</p>` 里，段落自身在 0、它的内容从 1 开始、第一个字 'a' 占据
   * [1, 2]。从 0 起步的话每个 span 都会整体偏后一位，表现是「从检索跳过来选中的
   * 是旁边那个字」「查找替换把邻字替掉了」—— 元素都在、流程也不报错，
   * 只有把选中的文本读出来才看得见。
   */
  walk(doc, -1)
  return { text: parts.join(''), spans }
}

/**
 * 把纯文本区间换算回 ProseMirror 位置。
 *
 * 两端分别定位：起点向「后」取（落在段落间的分隔符里时贴到下一段开头），
 * 终点向「前」取（贴到上一段末尾）。这样即使命中片段恰好跨越了段落边界，
 * 也能得到一个合法的、不越界的区间，而不是抛错。
 *
 * 返回 null 表示这段文本在文档里找不到对应位置（例如文档已被整体替换）。
 */
export function mapTextRange(
  docText: DocText,
  start: number,
  end: number
): { from: number; to: number } | null {
  if (docText.spans.length === 0) return null

  const fromSpan = locate(docText.spans, start, 'start')
  if (!fromSpan) return null

  const toSpan = locate(docText.spans, end, 'end') ?? fromSpan

  const from = clamp(fromSpan.from + (start - fromSpan.start), fromSpan.from, fromSpan.to)
  const to = clamp(toSpan.from + (end - toSpan.start), toSpan.from, toSpan.to)

  // 空区间或反序区间在 ProseMirror 里会产生非法装饰，直接丢掉
  if (to <= from) return null
  return { from, to }
}

function locate(spans: readonly TextSpan[], offset: number, side: 'start' | 'end'): TextSpan | null {
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]
    const spanEnd = span.start + (span.to - span.from)

    if (offset < span.start) {
      // 落在段落之间的分隔符里：起点归这一段，终点归前一段
      return side === 'start' ? span : (spans[index - 1] ?? span)
    }

    if (offset <= spanEnd) {
      // 恰好落在末尾时，作为起点应归下一段，作为终点则正好
      if (offset === spanEnd && side === 'start') continue
      return span
    }
  }

  return side === 'end' ? spans[spans.length - 1] : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/* ------------------------------------------------------------------ *
 * 纯文本查找
 * ------------------------------------------------------------------ */

export interface TextRange {
  start: number
  end: number
}

/**
 * 在纯文本里找出某个关键词的全部出现位置。
 *
 * 提出来共用，是被一个具体问题逼出来的：编辑器内的查找替换（Ctrl+F）
 * 与「从全库检索跳过来并定位」要做同一件事 —— 在正文里找到第 N 处关键词。
 * 两处各写一份的话，同一句话在两个功能里会指向不同的位置，
 * 而作者只会觉得软件精神分裂。
 *
 * 用 `indexOf` 逐段推进而不是正则：关键词是用户随手输入的，里面可能带
 * `(`、`*`、`?`、`\` 这些元字符。转义一遍当然也行，但那是在「用正则做
 * 字符串查找」—— 直接把正则去掉，从根上避免这类 bug。
 *
 * 重叠匹配（「哈哈哈」里找「哈哈」）只取第一次，与主流编辑器一致：
 * 允许重叠的话，「全部替换」的结果会依赖于匹配策略，很难解释。
 *
 * 大小写不敏感时用小写副本比对，但 `toLowerCase()` 对个别字符会改变长度
 * （`İ` → 两个码元），长度一变所有下标就整体错位。因此长度不一致时
 * 退回区分大小写 —— 宁可少匹配，也不能把位置标错。
 */
export function findTextRanges(text: string, needle: string, caseSensitive = false): TextRange[] {
  if (text.length === 0 || needle.length === 0) return []

  const lowered = text.toLowerCase()
  const insensitive = !caseSensitive && lowered.length === text.length
  const haystack = insensitive ? lowered : text
  const search = insensitive ? needle.toLowerCase() : needle
  if (search.length === 0) return []

  const ranges: TextRange[] = []
  let index = haystack.indexOf(search)
  while (index !== -1) {
    ranges.push({ start: index, end: index + search.length })
    index = haystack.indexOf(search, index + search.length)
  }

  return ranges
}

/** 在若干候选区间里挑出离目标偏移最近的一个。用于「跳过去定位」时消歧 */
export function nearestRange(
  ranges: readonly TextRange[],
  offset: number
): TextRange | null {
  let best: TextRange | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const range of ranges) {
    const distance = Math.abs(range.start - offset)
    if (distance < bestDistance) {
      bestDistance = distance
      best = range
    }
  }

  return best
}

/* ------------------------------------------------------------------ *
 * 段落定位
 *
 * 预览面板与正文之间要能互相「跳过去」。两者的坐标系不同：预览按段落
 * 序号排，正文按纯文本下标排。下面几个函数是这两个坐标系之间的换算，
 * 放在这里与上面那套映射作伴，因为它们必须遵守同一个分隔符约定。
 * ------------------------------------------------------------------ */

/** 单个纯文本下标 → ProseMirror 位置。落在段落间隙时贴到下一段开头 */
export function positionOfOffset(docText: DocText, offset: number): number | null {
  const span = locate(docText.spans, offset, 'start')
  if (!span) return null
  return clamp(span.from + (offset - span.start), span.from, span.to)
}

/** ProseMirror 位置 → 纯文本下标。用于把光标位置换算成「第几段」 */
export function offsetOfPosition(docText: DocText, position: number): number | null {
  for (const span of docText.spans) {
    if (position >= span.from && position <= span.to) {
      return span.start + (position - span.from)
    }
  }
  return null
}

/** 段落分隔符。与 extractDocText 里的约定必须一致 */
const PARAGRAPH_BREAK = /\n\s*\n/g

/** 纯文本下标 → 它在第几段（从 0 开始） */
export function paragraphIndexOfOffset(text: string, offset: number): number {
  let index = 0
  // matchAll 会从正则当前的 lastIndex 开始，共享的正则对象必须先归零
  PARAGRAPH_BREAK.lastIndex = 0

  for (const match of text.matchAll(PARAGRAPH_BREAK)) {
    if (match.index >= offset) break
    index += 1
  }

  return index
}

/** 第 N 段的纯文本起止下标。越界时返回 null */
export function paragraphRange(text: string, index: number): { start: number; end: number } | null {
  if (index < 0) return null

  const boundaries: Array<{ start: number; end: number }> = []
  let cursor = 0
  PARAGRAPH_BREAK.lastIndex = 0

  for (const match of text.matchAll(PARAGRAPH_BREAK)) {
    boundaries.push({ start: cursor, end: match.index })
    cursor = match.index + match[0].length
  }
  boundaries.push({ start: cursor, end: text.length })

  return boundaries[index] ?? null
}
