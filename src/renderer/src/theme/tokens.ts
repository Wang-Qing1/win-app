import type { ThemeConfig } from 'antd'

/**
 * winbook 的设计令牌。
 *
 * 目标不是「长得像 Ant Design 默认样子」，而是在保留 antd 完整功能（表格排序、
 * 表单校验、无障碍焦点管理）的前提下，把视觉规格调成 Windows 11 的观感：
 *
 *   - 字体栈以 Segoe UI Variable 打头，回落到 Segoe UI / 微软雅黑
 *   - 圆角 8px（Win11 控件的标准圆角），比 antd 默认的 6px 更柔和
 *   - 控件高度 32px，比 antd 默认的 32px 一致但对齐 Win11 的触达区域
 *   - 调色板取自 Fluent Design 的强调色与语义色，而不是 antd 的默认蓝紫
 *
 * 浅色与深色共用同一组尺寸令牌，只切换颜色令牌与 antd 的颜色算法，
 * 因此两套主题的间距、圆角、字号永远一致——这是手写 CSS 最难保持的部分。
 */

export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'winbook.theme'

/** Fluent 强调蓝。浅色主题的主色，也是 Windows 11 默认强调色系 */
const ACCENT_LIGHT = '#0f6cbd'

/* ------------------------------------------------------------------ *
 * 尺寸令牌：两套主题共用
 * ------------------------------------------------------------------ */

const sharedTokens: ThemeConfig['token'] = {
  // Segoe UI Variable 是 Win11 的系统字体；老系统会自动回落到后面的候选
  fontFamily:
    "'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
  fontFamilyCode: "'Cascadia Mono', Cascadia Code, Consolas, 'Courier New', monospace",
  fontSize: 14,

  borderRadius: 8,
  borderRadiusLG: 10,
  borderRadiusSM: 6,
  borderRadiusXS: 4,

  controlHeight: 32,
  controlHeightSM: 26,
  controlHeightLG: 38,

  // 桌面端阅读距离更近，行高略放宽可以显著降低长时间使用的疲劳
  lineHeight: 1.6,
  sizeStep: 4,
  sizeUnit: 4,

  wireframe: false
}

/* ------------------------------------------------------------------ *
 * 浅色主题
 * ------------------------------------------------------------------ */

const lightTokens: ThemeConfig['token'] = {
  ...sharedTokens,

  colorPrimary: ACCENT_LIGHT,
  colorInfo: ACCENT_LIGHT,
  colorLink: ACCENT_LIGHT,
  colorSuccess: '#0f7b0f',
  colorWarning: '#c76a00',
  colorError: '#c42b1c',

  colorBgBase: '#f3f3f3',
  colorBgLayout: '#f3f3f3',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgSpotlight: '#1b1b1b',

  colorBorder: '#d1d1d1',
  colorBorderSecondary: '#e5e5e5',

  colorText: '#1b1b1b',
  colorTextSecondary: '#5c5c5c',
  colorTextTertiary: '#7a7a7a',
  colorTextQuaternary: '#9b9b9b',

  boxShadow: '0 2px 4px rgba(0, 0, 0, 0.06)',
  boxShadowSecondary: '0 8px 24px rgba(0, 0, 0, 0.14)'
}

/* ------------------------------------------------------------------ *
 * 深色主题
 * ------------------------------------------------------------------ */

const darkTokens: ThemeConfig['token'] = {
  ...sharedTokens,

  // Fluent 在深色下用的是偏亮的蓝。此时主色按钮如果沿用白字，
  // 对比度只有约 2.9:1，达不到可读要求；改配深色文字后升到约 9:1，
  // 这也正是 Fluent 官方深色主题的做法。
  colorPrimary: '#479ef5',
  colorInfo: '#479ef5',
  colorLink: '#6cb8ff',
  colorSuccess: '#6ccb5f',
  colorWarning: '#fce100',
  colorError: '#ff99a4',
  colorTextLightSolid: '#08243a',

  colorBgBase: '#1f1f1f',
  colorBgLayout: '#1f1f1f',
  colorBgContainer: '#2b2b2b',
  colorBgElevated: '#323232',
  colorBgSpotlight: '#f3f3f3',

  colorBorder: '#3d3d3d',
  colorBorderSecondary: '#303030',

  colorText: '#ffffff',
  colorTextSecondary: '#d6d6d6',
  colorTextTertiary: '#adadad',
  colorTextQuaternary: '#8a8a8a',

  boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)',
  boxShadowSecondary: '0 8px 24px rgba(0, 0, 0, 0.5)'
}

/* ------------------------------------------------------------------ *
 * 组件级覆盖
 * ------------------------------------------------------------------ */

const lightComponents: ThemeConfig['components'] = {
  Layout: {
    headerHeight: 56,
    headerPadding: '0 24px',
    headerBg: '#ffffff',
    bodyBg: '#f3f3f3',
    // 侧栏与页头同为白色，内容区更灰 —— 这是 Win11 里「导航 / 内容」的层次关系，
    // 靠明度差分层而不是靠边框，视觉更安静
    siderBg: '#ffffff'
  },
  Menu: {
    itemBg: 'transparent',
    itemSelectedBg: '#e6f1fb',
    itemSelectedColor: '#0f6cbd',
    itemHoverBg: '#f2f2f2',
    itemColor: '#5c5c5c',
    itemHeight: 40,
    itemBorderRadius: 8,
    itemMarginInline: 8,
    itemMarginBlock: 2,
    iconSize: 15,
    collapsedIconSize: 16
  },
  Table: {
    headerBg: '#fafafa',
    headerColor: '#5c5c5c',
    headerSplitColor: 'transparent',
    cellPaddingBlock: 10,
    cellPaddingInline: 14,
    rowHoverBg: '#f5f9fd',
    borderColor: '#e5e5e5'
  },
  Card: {
    headerBg: 'transparent',
    paddingLG: 20
  },
  Modal: {
    titleFontSize: 16
  },
  Descriptions: {
    labelBg: '#fafafa',
    titleMarginBottom: 8
  },
  Segmented: {
    trackBg: '#ebebeb'
  },
  Statistic: {
    contentFontSize: 24
  }
}

const darkComponents: ThemeConfig['components'] = {
  Layout: {
    headerHeight: 56,
    headerPadding: '0 24px',
    headerBg: '#2b2b2b',
    bodyBg: '#1f1f1f',
    siderBg: '#262626'
  },
  Menu: {
    itemBg: 'transparent',
    itemSelectedBg: '#14324d',
    itemSelectedColor: '#6cb8ff',
    itemHoverBg: '#333333',
    itemColor: '#d6d6d6',
    itemHeight: 40,
    itemBorderRadius: 8,
    itemMarginInline: 8,
    itemMarginBlock: 2,
    iconSize: 15,
    collapsedIconSize: 16
  },
  Table: {
    headerBg: '#262626',
    headerColor: '#d6d6d6',
    headerSplitColor: 'transparent',
    cellPaddingBlock: 10,
    cellPaddingInline: 14,
    rowHoverBg: '#333333',
    borderColor: '#303030'
  },
  Card: {
    headerBg: 'transparent',
    paddingLG: 20
  },
  Modal: {
    titleFontSize: 16
  },
  Descriptions: {
    labelBg: '#262626',
    titleMarginBottom: 8
  },
  Segmented: {
    trackBg: '#262626'
  },
  Statistic: {
    contentFontSize: 24
  }
}

export const WINBOOK_THEMES: Record<ThemeMode, ThemeConfig> = {
  light: { token: lightTokens, components: lightComponents },
  dark: { token: darkTokens, components: darkComponents }
}
