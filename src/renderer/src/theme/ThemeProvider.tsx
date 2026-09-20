import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { THEME_STORAGE_KEY, WINBOOK_THEMES, type ThemeMode } from './tokens'

/**
 * 主题偏好：除了明确的浅色/深色，还保留「跟随系统」。
 * Windows 11 用户习惯在系统设置里统一切换深色模式，桌面应用应当尊重它。
 */
export type ThemePreference = ThemeMode | 'system'

interface ThemeContextValue {
  /** 当前实际生效的主题（已把 system 解析为具体值） */
  mode: ThemeMode
  /** 用户的偏好设置 */
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
  toggle: () => void
}

const ThemeModeContext = createContext<ThemeContextValue | null>(null)

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 读取本地存储的偏好。localStorage 在隐私模式或异常环境下可能抛错，必须兜底 */
function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* 读不到就用默认值，不影响应用运行 */
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  // 系统主题变化只在「跟随系统」时才有意义，但对所有偏好都保持监听，
  // 这样用户从「浅色」切回「跟随系统」时不需要重新订阅
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(DARK_QUERY)
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [])

  const mode: ThemeMode = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  // 把主题同步到 <html> 上，让 styles.css 能处理 body 底色、滚动条等
  // antd 管不到的地方，避免深色模式下出现白色边缘
  useEffect(() => {
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
  }, [mode])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* 存不进去只影响下次启动，本次会话仍然生效 */
    }
  }, [])

  const toggle = useCallback(() => {
    setPreference(mode === 'dark' ? 'light' : 'dark')
  }, [mode, setPreference])

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, preference, setPreference, toggle }),
    [mode, preference, setPreference, toggle]
  )

  return (
    <ThemeModeContext.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          // 颜色算法由 antd 提供，保证派生色阶（hover / active / disabled）
          // 与主色始终自洽——这是手写主题最容易做错的地方
          algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          // 全项目只有一个 antd 版本，关掉类名哈希可以减小样式体积，
          // 调试时类名也更可读
          hashed: false,
          ...WINBOOK_THEMES[mode]
        }}
      >
        {/* AntdApp 提供 message / notification / modal 的上下文，
            这样它们能继承主题与语言包，并且在 React 19 下不会因为
            静态方法脱离 ConfigProvider 而丢失样式。

            className 不能省：AntdApp 会往 DOM 里插一层 <div class="ant-app">，
            它夹在 #root 和 .app-shell 之间且高度是 auto。`.app-shell` 的
            height:100% 会因此无从解析、退化成内容高度 —— 表现出来就是页面
            比窗口长、底栏被顶出可视区。给它一个自己的类名把高度链接上。 */}
        <AntdApp className="app-root" message={{ maxCount: 3, duration: 3, top: 72 }}>
          {children}
        </AntdApp>
      </ConfigProvider>
    </ThemeModeContext.Provider>
  )
}

export function useThemeMode(): ThemeContextValue {
  const context = useContext(ThemeModeContext)
  if (!context) {
    throw new Error('useThemeMode 必须在 ThemeModeProvider 内部使用')
  }
  return context
}
