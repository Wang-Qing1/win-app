import { describe, expect, test } from 'vitest'
import { diffParagraphs, splitParagraphs } from './revision-diff'

/**
 * 差异对比是回档功能里唯一「算错了也看不出来」的地方：结果偏了，界面上
 * 只是某几段底色不对，没人会写 bug report。所以对齐算法的几条性质
 * 必须逐条钉住。
 */

describe('splitParagraphs', () => {
  test('丢掉空行与首尾空白', () => {
    expect(splitParagraphs('第一段\n\n  第二段  \n\n\n第三段')).toEqual(['第一段', '第二段', '第三段'])
  })

  test('只有空白时得到空数组', () => {
    expect(splitParagraphs('\n\n   \n')).toEqual([])
  })
})

describe('diffParagraphs', () => {
  test('两边相同：全部是 same，且两栏逐行对齐', () => {
    const text = '第一段\n第二段\n第三段'
    const rows = diffParagraphs(text, text)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.kind === 'same')).toBe(true)
    // 两栏都必须有内容：任何一侧为 null 都会让并排的两栏错位
    expect(rows.every((row) => row.old !== null && row.new !== null)).toBe(true)
  })

  test('两边都空：没有任何行', () => {
    expect(diffParagraphs('', '')).toEqual([])
  })

  test('新增一段：只有新版那一侧有内容，标为 added', () => {
    const rows = diffParagraphs('第一段\n第三段', '第一段\n第二段\n第三段')
    const added = rows.filter((row) => row.kind === 'added')
    expect(added).toHaveLength(1)
    expect(added[0].new).toBe('第二段')
    expect(added[0].old).toBeNull()
  })

  test('删除一段：只有旧版那一侧有内容，标为 removed', () => {
    const rows = diffParagraphs('第一段\n第二段\n第三段', '第一段\n第三段')
    const removed = rows.filter((row) => row.kind === 'removed')
    expect(removed).toHaveLength(1)
    expect(removed[0].old).toBe('第二段')
    expect(removed[0].new).toBeNull()
  })

  test('改写一段：两侧同一位置都有内容，标为 changed', () => {
    const rows = diffParagraphs('他走进了房间。', '她冲进了房间。')
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('changed')
    expect(rows[0].old).toBe('他走进了房间。')
    expect(rows[0].new).toBe('她冲进了房间。')
  })

  test('「误删一大段」是它要回答的那个场景：删掉的每一段都要出现', () => {
    const before = '甲\n乙\n丙\n丁\n戊'
    const after = '甲\n戊'
    const rows = diffParagraphs(before, after)
    const lost = rows.filter((row) => row.kind === 'removed').map((row) => row.old)
    expect(lost).toEqual(['乙', '丙', '丁'])
  })

  test('两栏行数永远相等（并排不错位的硬条件）', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['甲', ''],
      ['', '甲'],
      ['甲\n乙\n丙', '丙\n甲'],
      ['甲\n乙', '甲\n乙\n丙\n丁\n戊'],
      ['甲\n乙\n丙\n丁\n戊', '甲\n乙'],
      ['一段\n完全\n不同的\n文字\n在这里', '另一份\n完全\n不一样\n的\n内容']
    ]
    for (const [before, after] of cases) {
      const rows = diffParagraphs(before, after)
      const oldCount = rows.filter((row) => row.old !== null).length
      const newCount = rows.filter((row) => row.new !== null).length
      // 每一行至少有一侧有内容（否则就是凭空多出一条空行）
      expect(rows.every((row) => row.old !== null || row.new !== null)).toBe(true)
      // 出现过的段落一个不少：少了说明对齐算法吞掉了内容
      expect(oldCount).toBe(splitParagraphs(before).length)
      expect(newCount).toBe(splitParagraphs(after).length)
    }
  })

  test('不改动的内容保持 same，不因为前后有改动而误判', () => {
    const rows = diffParagraphs('开头\n中间\n结尾', '开头\n中间改过\n结尾')
    expect(rows.map((row) => row.kind)).toEqual(['same', 'changed', 'same'])
  })

  test('段落顺序整体互换：不丢内容，全部落在两栏里', () => {
    const rows = diffParagraphs('甲\n乙', '乙\n甲')
    const oldTexts = rows.filter((row) => row.old !== null).map((row) => row.old)
    const newTexts = rows.filter((row) => row.new !== null).map((row) => row.new)
    expect(oldTexts).toEqual(['甲', '乙'])
    expect(newTexts).toEqual(['乙', '甲'])
  })

  test('超大输入退化成整块替换，而不是卡死', () => {
    // 2,100 × 2,100 = 4,410,000 > 4,000,000 的阈值
    const before = new Array(2100).fill('旧').join('\n')
    const after = new Array(2100).fill('新').join('\n')
    const started = Date.now()
    const rows = diffParagraphs(before, after)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rows.filter((row) => row.kind === 'removed')).toHaveLength(2100)
    expect(rows.filter((row) => row.kind === 'added')).toHaveLength(2100)
    // 退化的结果同样是两栏行数相等（各占一侧，错位排列）
    expect(rows).toHaveLength(4200)
  })
})
