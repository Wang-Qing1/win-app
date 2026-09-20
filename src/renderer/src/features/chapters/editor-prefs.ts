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
  /**
   * 纸面之上的文字色。
   *   dark  深色墨，配浅色纸
   *   light 浅色墨，配深色纸
   *   theme 跟随应用主题 —— 给「默认」纸面用：纸面本身取的就是面板底色，
   *         深色主题下面板是深灰，这时墨色必须跟着翻过来，否则正文不可见
   */
  ink: 'dark' | 'light' | 'theme'
}

/**
 * 书写纸面背景。
 *
 * 用 CSS 渐变而不是图片：图片要么打进安装包（体积），要么走网络（桌面应用
 * 不该有联网依赖）。线性渐变 + repeating-linear-gradient 已经足够表达
 * 「山雾」「稿纸格」这类氛围，而且换主题时不需要重新切图。
 *
 * 第一项是默认值：**取应用面板底色**，而不是某种带氛围的纸。
 * 章节编辑器是干活的界面里面积最大的一块，底色一偏（曾经默认是偏绿的「山雾」），
 * 整屏观感就跟着偏，还会和周围的目录、校对面板割裂成两张皮。
 * 想换个心情的仍然可以从列表里挑带氛围的纸。
 */
export const PAPER_PRESETS: readonly PaperPreset[] = [
  {
    key: 'panel',
    label: '默认',
    background: 'var(--winbook-surface)',
    ink: 'theme'
  },
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
  // 上限 48 是为了容得下「段落之间空一行」：一行的高度 = 字号 × 行距，
  // 17px × 1.9 ≈ 32px，字号调到 20px 就超过旧的 32px 上限了
  paragraphGap: [0, 48],
  paperOpacity: [0.6, 1]
} as const

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontKey: 'system',
  fontSize: 17,
  lineHeight: 1.9,
  paragraphGap: 0,
  firstLineIndent: true,
  // 「默认」= 应用面板底色；浓度 1 表示不做半透明叠加，
  // 这样纸面底色与面板底色是同一个值，冒烟断言才能直接比这对颜色
  paperKey: 'panel',
  paperOpacity: 1,
  // 段落虚线分隔**默认开**（用户 2026-09-20：「编辑框中没有分割线？」）。
  // 它藏在「排版」面板里、默认关，等于没有人知道它存在 —— 一条默认关闭
  // 的辅助线和不提供几乎没有区别。已在偏好里明确关掉的人不受影响：
  // readEditorPrefs 只在 localStorage 里没有这个 key 时才用默认值。
  showParagraphRules: true
}

const STORAGE_KEY = 'winbook.editor.prefs'

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

/** 一行正文的高度（px）：字号 × 行距。「段落之间空一行」空的就是这个高度 */
export function lineHeightPxOf(prefs: Pick<EditorPrefs, 'fontSize' | 'lineHeight'>): number {
  return Math.round(prefs.fontSize * prefs.lineHeight)
}

/**
 * 网文标准排版的偏好补丁：**每段开头空两个字、段落之间空一行**。
 *
 * 「一键格式整理」按排版处理，而不是往正文里塞全角空格与空段落，原因有三：
 *   1. 项目里「缩进几个字 / 段间空多少」本来就是显示参数（见 platform-preview.ts
 *      对各平台版式的建模），正文内容始终是干净的纯文本；
 *   2. 真塞空格会让字数核对、检索片段、导出结果都多出一堆看不见的字符，
 *      而作者没有任何办法看出来是哪里多出来的；
 *   3. 字号或行距一改，「空一行」的高度要跟着变。写死进内容的空行做不到这件事。
 *
 * 想换成别的版式，照旧可以在「排版」面板里逐项调。
 */
export function tidyLayoutPatch(prefs: Pick<EditorPrefs, 'fontSize' | 'lineHeight'>): Partial<EditorPrefs> {
  return {
    firstLineIndent: true,
    paragraphGap: lineHeightPxOf(prefs)
  }
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
