/**
 * 平台预览规格。
 *
 * 每个平台一套阅读参数（字号、行距、缩进、段距、底色），用来在右侧
 * 那个手机框里还原「读者在手机上看到的样子」。
 *
 * 这些数字是**参照各平台常见阅读页的观感给出的近似值**，不是官方文档的
 * 权威数据 —— 平台随时会改版式，硬编码成事实反而会误导作者。所以界面里
 * 明确标注「仅供参考」，把它的定位说清楚：它帮你判断段落长度与节奏，
 * 不是像素级还原。
 *
 * 一个真实有用的地方：番茄、起点这类平台正文首行不缩进、段间空一行；
 * 而在 Word 里写作习惯的人往往通篇首行缩进两字符。切一遍预览就能立刻
 * 看出「我这样排版发上去会是什么样」。
 */

export interface PlatformSpec {
  key: string
  label: string
  fontSize: number
  lineHeight: number
  /** 首行缩进（字符数）。0 表示不缩进 */
  indentChars: number
  /** 段间空白（em） */
  paragraphGapEm: number
  /** 阅读页底色 */
  background: string
  /** 正文字色 */
  color: string
  fontFamily: string
  /** 每页约多少字。用于估算「共几页」 */
  charsPerPage: number
  note: string
}

export const PLATFORM_SPECS: readonly PlatformSpec[] = [
  {
    key: 'fanqie',
    label: '番茄小说',
    fontSize: 19,
    lineHeight: 1.85,
    indentChars: 0,
    paragraphGapEm: 0.85,
    background: '#f5f2ec',
    color: '#2a2622',
    fontFamily: "system-ui, 'Microsoft YaHei UI', sans-serif",
    charsPerPage: 520,
    note: '首行不缩进，段间空一行'
  },
  {
    key: 'qidian',
    label: '起点中文网',
    fontSize: 18,
    lineHeight: 1.75,
    indentChars: 0,
    paragraphGapEm: 0.8,
    background: '#f7f7f5',
    color: '#26282b',
    fontFamily: "system-ui, 'Microsoft YaHei UI', sans-serif",
    charsPerPage: 560,
    note: '段间空行，正文偏紧'
  },
  {
    key: 'qimao',
    label: '七猫免费小说',
    fontSize: 20,
    lineHeight: 1.9,
    indentChars: 0,
    paragraphGapEm: 0.9,
    background: '#f6f1ea',
    color: '#332c26',
    fontFamily: "system-ui, 'Microsoft YaHei UI', sans-serif",
    charsPerPage: 470,
    note: '字号偏大，单页字数最少'
  },
  {
    key: 'jinjiang',
    label: '晋江文学城',
    fontSize: 16,
    lineHeight: 1.9,
    indentChars: 2,
    paragraphGapEm: 0.6,
    background: '#ffffff',
    color: '#242424',
    fontFamily: "'Songti SC', SimSun, serif",
    charsPerPage: 620,
    note: '衬线字体，首行缩进两字符'
  },
  {
    key: 'paper',
    label: '纸书排版',
    fontSize: 16,
    lineHeight: 1.95,
    indentChars: 2,
    paragraphGapEm: 0,
    background: '#fbf8f1',
    color: '#1f1c17',
    fontFamily: "'Songti SC', SimSun, serif",
    charsPerPage: 700,
    note: '首行缩进，段间不空行'
  },
  {
    key: 'plain',
    label: '通用纯文本',
    fontSize: 17,
    lineHeight: 1.8,
    indentChars: 0,
    paragraphGapEm: 1,
    background: '#ffffff',
    color: '#1b1b1b',
    fontFamily: "system-ui, 'Microsoft YaHei UI', sans-serif",
    charsPerPage: 520,
    note: '不假设任何平台版式'
  }
] as const

export const DEFAULT_PLATFORM_KEY = 'fanqie'

export function platformOf(key: string): PlatformSpec {
  return PLATFORM_SPECS.find((item) => item.key === key) ?? PLATFORM_SPECS[0]
}

/** 平台预览的选择也要记住：作者基本只用一两个平台，每次重选很啰嗦 */
const STORAGE_KEY = 'wapp.editor.platform'

export function readPlatformKey(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return PLATFORM_SPECS.some((item) => item.key === raw) ? (raw as string) : DEFAULT_PLATFORM_KEY
  } catch {
    return DEFAULT_PLATFORM_KEY
  }
}

export function writePlatformKey(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, key)
  } catch {
    /* 忽略存储失败 */
  }
}

/** 平均阅读速度，字/分钟。中文网文的常见估算值 */
const READING_SPEED = 420

/**
 * 估算阅读时长。
 *
 * 用 420 字/分钟（约 7 字/秒）而不是更保守的 300：手机端刷网文的实际速度
 * 明显快于精读，用 300 会系统性高估，让「预计 15 分钟」这类提示失去参考性。
 */
export function estimateReadingSeconds(charCount: number): number {
  if (charCount <= 0) return 0
  return Math.round((charCount / READING_SPEED) * 60)
}

export function estimatePages(charCount: number, spec: PlatformSpec): number {
  if (charCount <= 0) return 1
  return Math.max(1, Math.ceil(charCount / spec.charsPerPage))
}
