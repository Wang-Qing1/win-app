import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'

/**
 * 一键格式整理。
 *
 * 处理的是「从别处粘贴进来」和「手敲回车敲多了」留下的两类噪音：
 *   1. 段落首尾的空白 —— 全角空格（U+3000）、零宽不换行空格（U+FEFF）
 *      这些从网页与 Word 粘进来时几乎每段都有，肉眼看不见，
 *      但会让首行缩进变成三格、让平台的字数校验莫名多出几百；
 *   2. 连续空段与首尾空段 —— 空段不承担任何语义，只会让「按下回车没反应」
 *      的错觉反复出现。
 *
 * 刻意不做的事：
 *   - 不改标点。把「...」换成「……」看着很爽，但那是在替作者改稿，
 *     而这一键的定位是「排版清理」，不是「文字润色」。
 *   - 不折叠段落**内部**的空格。作者可能真的在用空格排版对话与落款。
 *   - 不拆列表与引用的结构。列表项里的空段落是结构的一部分，
 *     折叠它会让列表断成两截。
 *
 * 实现上按「返回同一个节点表示没改动」写：调用方靠 `next !== current`
 * 判断要不要提交事务，这样点一次空按钮不会白白写入一次撤销历史。
 *
 * 纯函数、不碰 DOM —— 这样它能和 doc-text 一样在主进程外单独测。
 */
export function tidyDocument(doc: ProseMirrorNode): ProseMirrorNode {
  // 原节点与整理结果各存一份：判断「有没有改动」必须拿**原节点**比，
  // 拿整理结果自己比永远相等，容器内部的裁剪会被这一句吃掉（踩过）。
  const originals: ProseMirrorNode[] = []
  const blocks: ProseMirrorNode[] = []
  doc.forEach((child) => {
    originals.push(child)
    blocks.push(trimDeep(child))
  })

  const kept: ProseMirrorNode[] = []
  for (const block of blocks) {
    if (isBlank(block)) {
      // 开头的空段丢掉；连续的空段只留一个
      if (kept.length === 0 || isBlank(kept[kept.length - 1])) continue
      kept.push(block)
      continue
    }
    kept.push(block)
  }
  // 文末的空段全部丢掉
  while (kept.length > 0 && isBlank(kept[kept.length - 1])) kept.pop()

  // 整篇都是空白时留一个空段：文档必须有内容，否则编辑器会塌成一行
  if (kept.length === 0) kept.push(emptyParagraph(doc))

  if (kept.length === originals.length && kept.every((node, index) => node === originals[index])) {
    return doc
  }
  return doc.copy(Fragment.fromArray(kept))
}

/** 只有文本块才有「空段」一说。列表、引用即使没字也不该被当成空段拆掉 */
function isBlank(node: ProseMirrorNode): boolean {
  return node.isTextblock && node.textContent.trim().length === 0
}

/**
 * 递归去首尾空白。
 *
 * 文本块直接裁；含块子节点的容器（引用、列表、列表项）递归下去再原样装回，
 * 这样引文里的段落也能被整理到，而列表项之间的空段落保持不动。
 */
function trimDeep(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isTextblock) return trimBlock(node)
  if (node.childCount === 0) return node

  const children: ProseMirrorNode[] = []
  let changed = false
  node.forEach((child) => {
    const next = trimDeep(child)
    if (next !== child) changed = true
    children.push(next)
  })

  return changed ? node.copy(Fragment.fromArray(children)) : node
}

function trimBlock(node: ProseMirrorNode): ProseMirrorNode {
  if (node.childCount === 0) return node

  const children: ProseMirrorNode[] = []
  node.forEach((child) => {
    children.push(child)
  })

  // 只在最外侧的两个文本节点上下刀。若改成「取 textContent 再拼回一个文本节点」，
  // 整段的加粗、下划线、高亮会一起被抹掉 —— 那是在改内容，不是在整理排版。
  let firstText = -1
  let lastText = -1
  children.forEach((child, index) => {
    if (!child.isText) return
    if (firstText < 0) firstText = index
    lastText = index
  })
  if (firstText < 0) return node

  const transformOf = (index: number): ((value: string) => string) => {
    if (firstText === lastText) return (value) => value.trim()
    if (index === firstText) return (value) => value.replace(/^\s+/, '')
    if (index === lastText) return (value) => value.replace(/\s+$/, '')
    return (value) => value
  }

  const content: ProseMirrorNode[] = []
  children.forEach((child, index) => {
    if (!child.isText) {
      content.push(child)
      return
    }
    const before = child.text ?? ''
    const after = transformOf(index)(before)
    // 被裁空（整段只有一个空白字符）的文本节点必须摘掉：
    // ProseMirror 不允许零长度文本节点，建一个空的会直接抛错。
    if (after.length === 0) return
    // 没变的节点原样复用 —— 外部靠「返回的节点是否还是原来那个」判断有没有改动，
    // 每次重建会让「点一下什么都没发生」也走一遍提交与撤销历史
    content.push(after === before ? child : child.type.schema.text(after, child.marks))
  })

  if (content.length === children.length && content.every((child, index) => child === children[index])) {
    return node
  }
  return node.copy(Fragment.fromArray(content))
}

function emptyParagraph(doc: ProseMirrorNode): ProseMirrorNode {
  return doc.type.schema.nodes.paragraph.create()
}
