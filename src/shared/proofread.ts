/**
 * 正文校对规则引擎。
 *
 * 这是纯函数模块：输入一段文本，输出「在哪儿、什么问题」。它刻意不依赖
 * 任何 DOM 或富文本库，原因有三：
 *   1. 主进程可以在冒烟测试里直接校验规则，不需要起渲染进程；
 *   2. 编辑器换实现（TipTap → 别的）时规则一行都不用改；
 *   3. 位置用**纯文本下标**表达，映射回编辑器文档位置是调用方的事，
 *      两件事分开后各自都能单独测。
 *
 * 关于误报的一条立场：宁可少报，不可乱报。
 * 「的地得」误用、句式重复这类规则听着很美好，但准确率很难做上去，
 * 而作者看到满屏红色下划线时的反应是关掉这个功能，而不是逐个修改。
 * 因此本文件只收录**确定性高**的规则：标点重复、引号不配对、中英标点混用，
 * 这些要么对要么错，没有解释空间。
 */

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export const PROOFREAD_CATEGORIES = [
  'punctuation',
  'duplicate',
  'mixedScript',
  'pairing',
  'spacing'
] as const
export type ProofreadCategory = (typeof PROOFREAD_CATEGORIES)[number]

export const PROOFREAD_CATEGORY_LABELS: Record<ProofreadCategory, string> = {
  punctuation: '标点用法',
  duplicate: '叠字',
  mixedScript: '中英标点',
  pairing: '引号括号',
  spacing: '空格'
}

/** error 是「这里写错了」，suggestion 是「这样写不太好，但不算错」 */
export type ProofreadSeverity = 'error' | 'suggestion'

export interface ProofreadIssue {
  category: ProofreadCategory
  /** 命中片段在纯文本中的起止下标（半开区间） */
  start: number
  end: number
  /** 命中的原文，供界面直接展示，避免调用方再切一次 */
  text: string
  /** 一句人话解释 */
  message: string
  severity: ProofreadSeverity
}

export const FILLER_GROUPS = ['redundant', 'cliche', 'pet'] as const
export type FillerGroup = (typeof FILLER_GROUPS)[number]

export const FILLER_GROUP_LABELS: Record<FillerGroup, string> = {
  redundant: '冗余修饰',
  cliche: '套话',
  pet: '口头禅'
}

export interface FillerWord {
  word: string
  group: FillerGroup
  note: string
}

export interface FillerHit {
  word: string
  group: FillerGroup
  note: string
  /** 出现次数 */
  count: number
  /** 首次出现的位置，供「跳转」用 */
  firstIndex: number
}

export interface ProofreadResult {
  /** 纠错项（不含废字）。按位置升序 */
  issues: ProofreadIssue[]
  /** 各类别的问题数（截断前真实总数） */
  categoryCounts: Record<ProofreadCategory, number>
  /** 废字统计，按出现次数降序 */
  fillers: FillerHit[]
  errorCount: number
  suggestionCount: number
  /** 问题过多时只保留前 MAX_ISSUES 条，此标记表示结果被截断 */
  truncated: boolean
}

/* ------------------------------------------------------------------ *
 * 阈值
 * ------------------------------------------------------------------ */

/**
 * 单次最多返回多少条纠错项。
 *
 * 上限的意义不是性能（几万条也能扫完），而是界面：编辑器要为每一条
 * 挂一个高亮装饰，几千个装饰会让 ProseMirror 的每帧渲染明显变慢，
 * 而作者根本不可能一次处理上千处问题。超出部分通过 truncated 告知界面。
 */
const MAX_ISSUES = 400

/**
 * 单次最多返回多少种废字。
 *
 * 废字按「词」聚合而不是按「次」展开：作者想看的是「『似乎』用了 47 次」，
 * 而不是 47 条一模一样的记录。
 */
const MAX_FILLER_WORDS = 60

const HAN = /\p{Script=Han}/u

/* ------------------------------------------------------------------ *
 * 规则 1：标点用法
 * ------------------------------------------------------------------ */

/** 这些标点重复出现一定是笔误（中文里没有叠用它们的习惯） */
const HARD_REPEAT = /([，。、；：])\1+/gu

/** 感叹号/问号连用三个以上才提示——「！！」在网文里是常见的强调写法 */
const SOFT_REPEAT = /([！？])\1{2,}/gu

/** 孤立的省略号：中文省略号是六点，写成两点（……→ …）是常见笔误 */
const LONE_ELLIPSIS = /(?<!…)(…)(?!…)/gu

/** 半角三点省略号 */
const ASCII_ELLIPSIS = /\.{3,}/g

/** 单个破折号：中文破折号是两个连字符宽度，写一个是排版习惯问题 */
const LONE_DASH = /(?<!—)—(?!—)/gu

/* ------------------------------------------------------------------ *
 * 规则 2：叠字
 *
 * 只收录**虚词**的重复。像「慢慢」「渐渐」「妈妈」这类实词与称呼的
 * 重叠在中文里完全合法，如果按「连续两个相同汉字」泛化处理，
 * 一篇文章能报出几十处误报 —— 那正是让人关掉校对功能的做法。
 * ------------------------------------------------------------------ */

const DUPLICATED_PARTICLES = [
  '的',
  '了',
  '地',
  '得',
  '是',
  '在',
  '和',
  '与',
  '就',
  '也',
  '都',
  '还',
  '又',
  '很',
  '把',
  '被',
  '没',
  '给',
  '让',
  '从',
  '对',
  '向',
  '为'
] as const

const DUPLICATED_PATTERN = new RegExp(
  `(${DUPLICATED_PARTICLES.join('|')})\\1`,
  'gu'
)

/* ------------------------------------------------------------------ *
 * 规则 3：中英标点混用
 *
 * 判定条件是「半角标点的前一个字符是汉字」。
 * 这条前置条件同时解决了数字与英文的误报：
 *   3.14 的小数点前面是数字 → 不报
 *   Hello, world 的逗号前面是字母 → 不报
 *   他说,你好 的逗号前面是汉字 → 报
 * ------------------------------------------------------------------ */

const HALF_WIDTH_PUNCTUATION = new Set([
  ',',
  '.',
  ';',
  ':',
  '!',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}'
])

const HALF_WIDTH_HINTS: Record<string, string> = {
  ',': '中文里应使用「，」',
  '.': '中文里应使用「。」（句号）',
  ';': '中文里应使用「；」',
  ':': '中文里应使用「：」',
  '!': '中文里应使用「！」',
  '?': '中文里应使用「？」',
  '(': '中文里应使用「（」',
  ')': '中文里应使用「）」',
  '[': '中文里应使用「【」',
  ']': '中文里应使用「】」',
  '{': '中文里应使用「｛」，或改用书名号《》',
  '}': '中文里应使用「｝」，或改用书名号《》'
}

/* ------------------------------------------------------------------ *
 * 规则 4：引号括号配对
 * ------------------------------------------------------------------ */

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
  ['【', '】'],
  ['《', '》'],
  ['〈', '〉'],
  ['〔', '〕']
]

/* ------------------------------------------------------------------ *
 * 规则 5：空格
 * ------------------------------------------------------------------ */

/** 连续两个及以上空格。排版上没有任何正当理由，通常来自复制粘贴 */
const MULTI_SPACE = / {2,}/g

/** 汉字之间的空格：中文不需要词间空格 */
const HAN_GAP = /(?<=\p{Script=Han}) (?=\p{Script=Han})/gu

/** 标点前的空格 */
const SPACE_BEFORE_PUNCT = / (?=[，。！？；：、）】》」』])/gu

/* ------------------------------------------------------------------ *
 * 废字词表
 *
 * 这是「提示」而非「错误」，所以标注为建议级。
 * 词表刻意保持精简并分组：作者看到的不是一个 200 条的黑名单，
 * 而是「你这段里套话偏多」这样的可执行结论。
 * ------------------------------------------------------------------ */

export const FILLER_WORDS: readonly FillerWord[] = [
  // 冗余修饰：删掉后语义几乎不变
  { word: '非常', group: 'redundant', note: '程度副词，多数时候可以直接删掉' },
  { word: '十分', group: 'redundant', note: '程度副词，多数时候可以直接删掉' },
  { word: '真的', group: 'redundant', note: '口语化强调，书面叙述里可删' },
  { word: '简直', group: 'redundant', note: '夸张修饰，容易让叙述失真' },
  { word: '几乎', group: 'redundant', note: '弱化词，滥用会让画面变模糊' },
  { word: '稍微', group: 'redundant', note: '弱化词，动作描写里往往可删' },
  { word: '微微', group: 'redundant', note: '高频弱化词，注意别每一段都用' },
  { word: '有些', group: 'redundant', note: '弱化词，削弱画面感' },
  { word: '不太', group: 'redundant', note: '弱化词，尽量换成具体描写' },
  { word: '的确是', group: 'redundant', note: '语义重复，直接说「是」即可' },

  // 口头禅：一句话里反复出现的语气词
  { word: '似乎', group: 'pet', note: '推测语气，连续出现会让叙述显得不确定' },
  { word: '仿佛', group: 'pet', note: '比喻标记，一章出现多次就显得套路' },
  { word: '好像', group: 'pet', note: '与「似乎」「仿佛」同义，注意不要一段里混用' },
  { word: '大概', group: 'pet', note: '含糊的数量或判断，能用具体数字就用具体数字' },
  { word: '应该', group: 'pet', note: '推测语气，叙述中替代确定性表达会削弱力度' },
  { word: '其实', group: 'pet', note: '转折口头禅，删掉后句子往往更干净' },
  { word: '只是', group: 'pet', note: '转折口头禅，高频出现说明句子转折过多' },
  { word: '然后', group: 'pet', note: '流水账感的来源之一，用动作或场景切换代替' },
  { word: '于是', group: 'pet', note: '连接词滥用会让因果显得机械' },
  { word: '突然', group: 'pet', note: '转折高频词，用得太多会让所有意外都不意外' },
  { word: '忽然', group: 'pet', note: '与「突然」同义，注意二选一' },

  // 套话：模板化的叙述，读者一眼能看出是凑字数
  { word: '深吸一口气', group: 'cliche', note: '模板化动作，换成具体反应会好得多' },
  { word: '皱了皱眉', group: 'cliche', note: '模板化表情' },
  { word: '点了点头', group: 'cliche', note: '模板化动作，多数时候是废话' },
  { word: '不得不说', group: 'cliche', note: '作者视角插话，破坏沉浸感' },
  { word: '不可否认', group: 'cliche', note: '作者视角插话，破坏沉浸感' },
  { word: '毫无疑问', group: 'cliche', note: '作者视角插话，破坏沉浸感' },
  { word: '总的来说', group: 'cliche', note: '议论腔，出现在正文里很出戏' },
  { word: '事实上', group: 'cliche', note: '议论腔，正文叙述里显得生硬' },
  { word: '某种程度上', group: 'cliche', note: '模糊限定语，说了等于没说' },
  { word: '一阵', group: 'cliche', note: '万能量词，「一阵沉默」「一阵眩晕」，注意密度' }
] as const

const FILLER_LOOKUP = new Map(FILLER_WORDS.map((item) => [item.word, item]))

/** 长词优先：保证「深吸一口气」不会被「一阵」以外的短词切走 */
const FILLER_PATTERN = new RegExp(
  FILLER_WORDS.map((item) => escapeRegExp(item.word))
    .sort((a, b) => b.length - a.length)
    .join('|'),
  'gu'
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export function proofread(text: string): ProofreadResult {
  const issues: ProofreadIssue[] = []
  const categoryCounts = emptyCategoryCounts()
  let truncated = false

  const add = (issue: ProofreadIssue): void => {
    categoryCounts[issue.category] += 1
    if (issues.length < MAX_ISSUES) {
      issues.push(issue)
    } else {
      truncated = true
    }
  }

  if (text.length > 0) {
    scanPunctuation(text, add)
    scanDuplicates(text, add)
    scanMixedScript(text, add)
    scanPairs(text, add)
    scanSpacing(text, add)
  }

  // 按位置排序，让面板里的顺序与正文的阅读顺序一致 ——
  // 否则用户从第一条开始改，改着改着光标会往回跳
  issues.sort((a, b) => a.start - b.start || a.end - b.end)

  const fillers = text.length > 0 ? collectFillers(text) : []

  let errorCount = 0
  let suggestionCount = 0
  for (const issue of issues) {
    if (issue.severity === 'error') errorCount += 1
    else suggestionCount += 1
  }

  return {
    issues,
    categoryCounts,
    fillers,
    errorCount,
    suggestionCount,
    truncated
  }
}

function emptyCategoryCounts(): Record<ProofreadCategory, number> {
  return { punctuation: 0, duplicate: 0, mixedScript: 0, pairing: 0, spacing: 0 }
}

type AddIssue = (issue: ProofreadIssue) => void

function scanPunctuation(text: string, add: AddIssue): void {
  for (const match of text.matchAll(HARD_REPEAT)) {
    add({
      category: 'punctuation',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: `标点重复：「${match[1]}」连写了 ${match[0].length} 个`,
      severity: 'error'
    })
  }

  for (const match of text.matchAll(SOFT_REPEAT)) {
    add({
      category: 'punctuation',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: `「${match[1]}」连用了 ${match[0].length} 个，超过三个通常是笔误`,
      severity: 'suggestion'
    })
  }

  for (const match of text.matchAll(ASCII_ELLIPSIS)) {
    add({
      category: 'punctuation',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: '省略号请用中文的「……」（六点）',
      severity: 'suggestion'
    })
  }

  for (const match of text.matchAll(LONE_ELLIPSIS)) {
    add({
      category: 'punctuation',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: '省略号应为六点「……」，这里只有三点',
      severity: 'error'
    })
  }

  for (const match of text.matchAll(LONE_DASH)) {
    add({
      category: 'punctuation',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: '破折号应占两个字宽「——」，这里只写了一个',
      severity: 'suggestion'
    })
  }
}

function scanDuplicates(text: string, add: AddIssue): void {
  for (const match of text.matchAll(DUPLICATED_PATTERN)) {
    add({
      category: 'duplicate',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: `叠字：「${match[1]}」重复了，可能是输入时多打了一下`,
      severity: 'error'
    })
  }
}

function scanMixedScript(text: string, add: AddIssue): void {
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (!HALF_WIDTH_PUNCTUATION.has(char)) continue

    // 前面必须是汉字：这条前置条件同时排除了数字小数点与英文逗号
    const previous = text[index - 1]
    if (!HAN.test(previous)) continue

    add({
      category: 'mixedScript',
      start: index,
      end: index + 1,
      text: char,
      message: HALF_WIDTH_HINTS[char] ?? '中文里应使用全角标点',
      severity: 'error'
    })
  }
}

function scanPairs(text: string, add: AddIssue): void {
  for (const [open, close] of PAIRS) {
    const stack: number[] = []

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === open) {
        stack.push(index)
      } else if (char === close) {
        stack.pop()
      }
    }

    // 没被闭合的左符号
    for (const index of stack) {
      add({
        category: 'pairing',
        start: index,
        end: index + 1,
        text: open,
        message: `「${open}」没有配对的「${close}」`,
        severity: 'error'
      })
    }

    // 多余的右符号（左符号都用完了还遇到右符号）
    let balance = 0
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === open) balance += 1
      else if (char === close) {
        if (balance === 0) {
          add({
            category: 'pairing',
            start: index,
            end: index + 1,
            text: close,
            message: `「${close}」没有配对的「${open}」`,
            severity: 'error'
          })
        } else {
          balance -= 1
        }
      }
    }
  }
}

function scanSpacing(text: string, add: AddIssue): void {
  for (const match of text.matchAll(MULTI_SPACE)) {
    add({
      category: 'spacing',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: `连续 ${match[0].length} 个空格`,
      severity: 'suggestion'
    })
  }

  for (const match of text.matchAll(HAN_GAP)) {
    add({
      category: 'spacing',
      start: match.index,
      end: match.index + 1,
      text: ' ',
      message: '汉字之间不需要空格',
      severity: 'suggestion'
    })
  }

  for (const match of text.matchAll(SPACE_BEFORE_PUNCT)) {
    add({
      category: 'spacing',
      start: match.index,
      end: match.index + 1,
      text: ' ',
      message: '中文标点前不需要空格',
      severity: 'suggestion'
    })
  }
}

function collectFillers(text: string): FillerHit[] {
  const stats = new Map<string, FillerHit>()

  for (const match of text.matchAll(FILLER_PATTERN)) {
    const word = match[0]
    const meta = FILLER_LOOKUP.get(word)
    if (!meta) continue

    const existing = stats.get(word)
    if (existing) {
      existing.count += 1
    } else {
      stats.set(word, {
        word,
        group: meta.group,
        note: meta.note,
        count: 1,
        firstIndex: match.index
      })
    }
  }

  return [...stats.values()]
    .sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)
    .slice(0, MAX_FILLER_WORDS)
}

/* ------------------------------------------------------------------ *
 * 汇总辅助
 * ------------------------------------------------------------------ */

/**
 * 一句话结论，用于面板头部的概述。
 *
 * 不返回「共 N 个问题」这种没有信息量的句子：作者真正想知道的是
 * 「能不能直接发出去」。所以把 error 与 suggestion 分开措辞。
 */
export function summarizeProofread(result: ProofreadResult): string {
  const { errorCount, suggestionCount, fillers } = result
  if (errorCount === 0 && suggestionCount === 0 && fillers.length === 0) {
    return '没有发现明显问题'
  }

  const parts: string[] = []
  if (errorCount > 0) parts.push(`${errorCount} 处需要修改`)
  if (suggestionCount > 0) parts.push(`${suggestionCount} 处建议调整`)
  if (fillers.length > 0) {
    const total = fillers.reduce((sum, item) => sum + item.count, 0)
    parts.push(`${fillers.length} 个废词共 ${total} 次`)
  }
  return parts.join(' · ')
}
