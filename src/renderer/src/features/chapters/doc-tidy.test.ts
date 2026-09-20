import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { describe, expect, test } from 'vitest'
import { tidyDocument } from './doc-tidy'

/**
 * 迷你 schema：只保留整理要用到的结构。
 * 用自己声明的 schema 而不是 TipTap 的完整 StarterKit，是为了让测试
 * 只依赖「文档形状」这件事本身 —— 富文本库换版本不会波及这里。
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false }
  },
  marks: {
    bold: {}
  }
})

function doc(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return schema.node('doc', null, blocks)
}

function p(text: string, marks?: string[]): ProseMirrorNode {
  if (text.length === 0) return schema.node('paragraph', null, [])
  const markList = (marks ?? []).map((name) => schema.marks[name].create())
  return schema.node('paragraph', null, [schema.text(text, markList)])
}

/** 段落文本数组，便于一句断言看全整篇结构 */
function textsOf(node: ProseMirrorNode): string[] {
  const out: string[] = []
  node.forEach((child) => out.push(child.textContent))
  return out
}

describe('tidyDocument', () => {
  test('去掉段落首尾的空白，含全角空格与零宽空格', () => {
    const result = tidyDocument(doc(p('　  他说：「走吧」 　'), p('\uFEFF风停了。\uFEFF')))
    expect(textsOf(result)).toEqual(['他说：「走吧」', '风停了。'])
  })

  test('段落内部的空格原样保留', () => {
    // 作者可能真的在用空格排对话、排落款，折叠它们等于替人改稿
    const result = tidyDocument(doc(p('「 走 吧 」'), p('地　点：客栈')))
    expect(textsOf(result)).toEqual(['「 走 吧 」', '地　点：客栈'])
  })

  test('连续空段折叠成一个', () => {
    const result = tidyDocument(doc(p('第一段'), p(''), p(''), p(''), p('第二段')))
    expect(textsOf(result)).toEqual(['第一段', '', '第二段'])
  })

  test('开头与结尾的空段全部去掉', () => {
    const result = tidyDocument(doc(p(''), p(''), p('正文'), p(''), p('')))
    expect(textsOf(result)).toEqual(['正文'])
  })

  test('整篇都是空白时留一个空段，不返回空文档', () => {
    // doc 的 content 是 block+，返回零个块会让编辑器直接塌掉
    const result = tidyDocument(doc(p('   '), p('')))
    expect(textsOf(result)).toEqual([''])
    expect(result.childCount).toBe(1)
  })

  test('已经干净的文档返回同一个对象（调用方据此跳过一次提交）', () => {
    const before = doc(p('第一段'), p('第二段'))
    expect(tidyDocument(before)).toBe(before)
  })

  test('只裁文本、不动标记：加粗与下划线不会丢', () => {
    const result = tidyDocument(doc(p('  重点  ', ['bold'])))
    const paragraph = result.child(0)
    expect(paragraph.textContent).toBe('重点')
    expect(paragraph.child(0).marks.map((mark) => mark.type.name)).toEqual(['bold'])
  })

  test('硬换行不会被当成段落首尾空白裁掉中间的部分', () => {
    const withBreak = schema.node('paragraph', null, [
      schema.text(' 上'),
      schema.node('hardBreak'),
      schema.text('下 ')
    ])
    const result = tidyDocument(doc(withBreak))
    const paragraph = result.child(0)
    expect(paragraph.textContent).toBe('上下')
    // 结构还在：换行节点没有被抹平
    expect(paragraph.child(1).type.name).toBe('hardBreak')
  })

  test('列表 / 引用这类容器只做递归裁剪，不折叠其内部空段', () => {
    const quote = schema.node('blockquote', null, [p('  引文  '), p('')])
    const result = tidyDocument(doc(quote, p('正文')))
    expect(result.childCount).toBe(2)
    const inner = result.child(0)
    expect(inner.childCount).toBe(2)
    expect(inner.child(0).textContent).toBe('引文')
  })
})
