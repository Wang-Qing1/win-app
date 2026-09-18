/**
 * 编辑器的书写外观偏好。
 *
 * 存 localStorage 而不是数据库：这些是纯粹的「这台机器上的人喜欢怎么看」，
 * 换台机器重新选一遍毫无损失，而放进数据库就要为它开迁移、写 IPC、
 * 加一个几乎不会有人用的设置表 —— 成本远大于收益。
 *
 * 刻意的设计取舍：**不做「所见即所得」的样式面板**。字体、字号、行距、
 * 背景都是本地渲染偏好，不写回 content_html。理由是导出给平台的是纯文本，
 * 正文里塞进 font-size 这类行内样式，导出时会被剥掉，反而造成
 * 「我在编辑器里看到的和发出去的不一样」的困惑。
 */

export const EDITOR_FONT_PRESETS = [
  { key: 'system', label: '系统默认', stack: "'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif" },
  { key: 'song', label: '宋体', stack: "'Songti SC', SimSun, 'Noto Serif SC', serif" },
  { key: 'kai', label: '楷体', stack: "KaiTi, 'Kaiti SC', STKaiti, serif" },
  { key: 'fangsong', label: '仿宋', stack: "FangSong, 'FangSong SC', STFangsong, serif" },
  { key: 'hei', label: '黑体', stack: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
  { key: 'mono', label: '等宽', stack: "'Cascadia Mono', Consolas, 'Sarasa Mono SC', monospace" }
] as const

export type EditorFontKey = (typeof EDITOR_FONT_PRESETS)[number]['key']

export interface PaperPreset {
  key: string
  label: string
  /** 纸面的 CSS 背景。用纯 CSS 生成，不依赖任何图片资源 */
  background: string
  /** 纸面之上的文字色。深浅背景需要不同的文字色，否则会不可读 */
  ink: 'dark' | 'light'
}

/**
 * 书写纸面背景。
 *
 * 用 CSS 渐变而不是图片：图片要么打进安装包（体积），要么走网络（桌面应用
 * 不该有联网依赖）。线性渐变 + repeating-linear-gradient 已经足够表达
 * 「山雾」「稿纸格」这类氛围，而且换主题时不需要重新切图。
 */
export const PAPER_PRESETS: readonly PaperPreset[] = [
  {
    key: 'plain',
    label: '素白',
    background: '#ffffff',
    ink: 'dark'
  },
  {
    key: 'rice',
    label: '米纸',
    background: 'linear-gradient(160deg, #fbf8f1 0%, #f5efe3 100%)',
    ink: 'dark'
  },
  {
    key: 'mist',
    label: '山雾',
    background:
      'linear-gradient(175deg, #e8f0e6 0%, #dbe7e2 40%, #cfdde4 100%)',
    ink: 'dark'
  },
  {
    key: 'bamboo',
    label: '竹青',
    background: 'linear-gradient(165deg, #eef4ea 0%, #d9e6d6 60%, #c7d9c6 100%)',
    ink: 'dark'
  },
  {
    key: 'sunset',
    label: '晚霞',
    background: 'linear-gradient(170deg, #fdf1e7 0%, #f7dfd3 45%, #eed3d6 100%)',
    ink: 'dark'
  },
  {
    key: 'grid',
    label: '稿纸格',
    // 双层 repeating-linear-gradient 画出方格纸：这是纸面质感里最省成本的表达
    background:
      'repeating-linear-gradient(0deg, #e6e6e6 0 1px, transparent 1px 28px), repeating-linear-gradient(90deg, #e6e6e6 0 1px, transparent 1px 28px), #ffffff',
    ink: 'dark'
  },
  {
    key: 'night',
    label: '夜色',
    background: 'linear-gradient(175deg, #1c2230 0%, #171c26 55%, #12161e 100%)',
    ink: 'light'
  },
  {
    key: 'ink',
    label: '墨黑',
    background: 'linear-gradient(170deg, #232323 0%, #1a1a1a 100%)',
    ink: 'light'
  }
] as const

export interface EditorPrefs {
  fontKey: EditorFontKey
  /** 正文字号（px） */
  fontSize: number
  /** 行高倍数 */
  lineHeight: number
  /** 段间空白（px）。网文平台多为 0，纸书排版多为 8–16 */
  paragraphGap: number
  /** 首行缩进两字（网文平台的标准排版） */
  firstLineIndent: boolean
  /** 纸面背景 key */
  paperKey: string
  /** 纸面不透明度 0.6–1，让背景图的氛围透出来而不影响可读性 */
  paperOpacity: number
  /** 是否显示段落之间的虚线分隔 */
  showParagraphRules: boolean
}

export const EDITOR_PREF_LIMITS = {
  fontSize: [14, 30],
  lineHeight: [1.4, 2.6],
  paragraphGap: [0, 32],
  paperOpacity: [0.6, 1]
} as const

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontKey: 'system',
  fontSize: 17,
  lineHeight: 1.9,
  paragraphGap: 0,
  firstLineIndent: true,
  paperKey: 'mist',
  paperOpacity: 0.9,
  showParagraphRules: false
}

const STORAGE_KEY = 'wapp.editor.prefs'

export function readEditorPrefs(): EditorPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_EDITOR_PREFS
    return normalizeEditorPrefs(JSON.parse(raw))
  } catch {
    // 存储被禁用或内容损坏时退回默认值，不能让「读偏好失败」把编辑器挡住
    return DEFAULT_EDITOR_PREFS
  }
}

export function writeEditorPrefs(prefs: EditorPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* 存不进去只影响下次启动 */
  }
}

export function fontStackOf(key: EditorFontKey): string {
  return EDITOR_FONT_PRESETS.find((item) => item.key === key)?.stack ?? EDITOR_FONT_PRESETS[0].stack
}

export function paperOf(key: string): PaperPreset {
  return PAPER_PRESETS.find((item) => item.key === key) ?? PAPER_PRESETS[0]
}

/**
 * 归一化。
 *
 * 每个数值都要夹到区间内、每个枚举都要回落到默认值：localStorage 里的
 * 内容可能来自旧版本（字段被删过、区间被改过），直接信任它会让界面
 * 出现字号 400px 这种把布局撑爆的情况，而用户根本不知道是哪里设坏的。
 */
export function normalizeEditorPrefs(raw: unknown): EditorPrefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_EDITOR_PREFS
  const source = raw as Partial<Record<keyof EditorPrefs, unknown>>

  const fontKey = EDITOR_FONT_PRESETS.some((item) => item.key === source.fontKey)
    ? (source.fontKey as EditorFontKey)
    : DEFAULT_EDITOR_PREFS.fontKey

  const paperKey = PAPER_PRESETS.some((item) => item.key === source.paperKey)
    ? (source.paperKey as string)
    : DEFAULT_EDITOR_PREFS.paperKey

  return {
    fontKey,
    paperKey,
    fontSize: clampNumber(source.fontSize, EDITOR_PREF_LIMITS.fontSize, DEFAULT_EDITOR_PREFS.fontSize),
    lineHeight: clampNumber(
      source.lineHeight,
      EDITOR_PREF_LIMITS.lineHeight,
      DEFAULT_EDITOR_PREFS.lineHeight
    ),
    paragraphGap: clampNumber(
      source.paragraphGap,
      EDITOR_PREF_LIMITS.paragraphGap,
      DEFAULT_EDITOR_PREFS.paragraphGap
    ),
    paperOpacity: clampNumber(
      source.paperOpacity,
      EDITOR_PREF_LIMITS.paperOpacity,
      DEFAULT_EDITOR_PREFS.paperOpacity
    ),
    firstLineIndent:
      typeof source.firstLineIndent === 'boolean'
        ? source.firstLineIndent
        : DEFAULT_EDITOR_PREFS.firstLineIndent,
    showParagraphRules:
      typeof source.showParagraphRules === 'boolean'
        ? source.showParagraphRules
        : DEFAULT_EDITOR_PREFS.showParagraphRules
  }
}

function clampNumber(value: unknown, range: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range[1], Math.max(range[0], value))
}
