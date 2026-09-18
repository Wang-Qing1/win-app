import { describe, expect, test } from 'vitest'
import { proofread, summarizeProofread } from './proofread'

describe('proofread - punctuation', () => {
  test('flags repeated Chinese commas/periods as an error', () => {
    const result = proofread('他说，，你好')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ category: 'punctuation', severity: 'error', text: '，，' })
  })

  test('flags 3+ repeated ! or ? as a suggestion, not an error', () => {
    const result = proofread('好啊！！！')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('suggestion')
  })

  test('does not flag two repeated ! (a common emphatic style in web fiction)', () => {
    const result = proofread('好啊！！')
    expect(result.issues).toHaveLength(0)
  })

  test('flags a lone two-dot ellipsis as an error (should be six-dot ……)', () => {
    const result = proofread('等等…')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ category: 'punctuation', severity: 'error' })
  })

  test('does not flag a correct six-dot ellipsis', () => {
    const result = proofread('等等……')
    expect(result.issues).toHaveLength(0)
  })

  test('flags ASCII ... as a suggestion to use …… (and also flags the leading dot as mixed-script, since it directly follows a Han character)', () => {
    const result = proofread('等等...')
    const punctuationIssue = result.issues.find((i) => i.category === 'punctuation')
    expect(punctuationIssue?.severity).toBe('suggestion')
    expect(result.issues.some((i) => i.category === 'mixedScript')).toBe(true)
  })

  test('flags a lone single-width dash as a suggestion (should be double-width ——)', () => {
    const result = proofread('继续—说')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('suggestion')
  })
})

describe('proofread - duplicate particles', () => {
  test('flags a repeated function word like 的的 as an error', () => {
    const result = proofread('这是他的的书')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ category: 'duplicate', text: '的的' })
  })

  test('does not flag a legitimately repeated content word like 慢慢 or 妈妈', () => {
    const result = proofread('慢慢地走向妈妈')
    expect(result.issues).toHaveLength(0)
  })
})

describe('proofread - mixed script punctuation', () => {
  test('flags a half-width comma right after a Han character', () => {
    const result = proofread('他说,你好')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ category: 'mixedScript', text: ',' })
  })

  test('does not flag a decimal point between digits', () => {
    const result = proofread('圆周率是 3.14')
    expect(result.issues.filter((i) => i.category === 'mixedScript')).toHaveLength(0)
  })

  test('does not flag an English comma between letters', () => {
    const result = proofread('Hello, world')
    expect(result.issues.filter((i) => i.category === 'mixedScript')).toHaveLength(0)
  })
})

describe('proofread - pairing', () => {
  test('flags an unclosed full-width quote', () => {
    const result = proofread('他说：“你好')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ category: 'pairing', text: '“' })
  })

  test('flags an extra closing quote with no matching opener', () => {
    const result = proofread('你好”')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ category: 'pairing', text: '”' })
  })

  test('does not flag properly paired quotes', () => {
    const result = proofread('他说：“你好”')
    expect(result.issues.filter((i) => i.category === 'pairing')).toHaveLength(0)
  })
})

describe('proofread - spacing', () => {
  test('flags two or more consecutive spaces', () => {
    const result = proofread('a  b')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].category).toBe('spacing')
  })

  test('flags a space between two Han characters', () => {
    const result = proofread('你 好')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].category).toBe('spacing')
  })

  test('flags a space right before Chinese punctuation', () => {
    const result = proofread('你好 ，在吗')
    expect(result.issues.some((i) => i.category === 'spacing')).toBe(true)
  })
})

describe('proofread - filler words', () => {
  test('collects filler word hits with counts, sorted by count descending', () => {
    const result = proofread('他似乎很开心，又似乎很难过，不过他其实没事')
    const filler = result.fillers.find((f) => f.word === '似乎')
    expect(filler?.count).toBe(2)
  })

  test('prefers the longer filler phrase over a shorter one it contains', () => {
    const result = proofread('他深吸一口气，然后转身离开')
    expect(result.fillers.some((f) => f.word === '深吸一口气')).toBe(true)
    expect(result.fillers.some((f) => f.word === '一阵')).toBe(false)
  })

  test('does not report fillers when there are none', () => {
    const result = proofread('阳光很好')
    expect(result.fillers).toHaveLength(0)
  })
})

describe('proofread - result shape and edge cases', () => {
  test('returns an all-empty, non-truncated result for empty input', () => {
    const result = proofread('')
    expect(result.issues).toHaveLength(0)
    expect(result.fillers).toHaveLength(0)
    expect(result.errorCount).toBe(0)
    expect(result.suggestionCount).toBe(0)
    expect(result.truncated).toBe(false)
  })

  test('issues are sorted by position, ascending', () => {
    const result = proofread('你好，，在吗？？？？')
    const starts = result.issues.map((i) => i.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  test('errorCount and suggestionCount add up to the total issue count', () => {
    const result = proofread('他说，，你好！！！')
    expect(result.errorCount + result.suggestionCount).toBe(result.issues.length)
  })
})

describe('summarizeProofread', () => {
  test('reports no issues found when everything is clean', () => {
    expect(summarizeProofread(proofread('阳光很好'))).toBe('没有发现明显问题')
  })

  test('separates error count from suggestion count in the summary', () => {
    const summary = summarizeProofread(proofread('他说，，你好！！！'))
    expect(summary).toContain('需要修改')
    expect(summary).toContain('建议调整')
  })

  test('includes filler word total occurrence count', () => {
    const summary = summarizeProofread(proofread('他似乎很开心，又似乎很难过'))
    expect(summary).toContain('废词共 2 次')
  })
})
