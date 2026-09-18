import type { ReactNode } from 'react'
import { DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons'
import { Segmented, Tooltip } from 'antd'
import { useThemeMode, type ThemePreference } from '../theme/ThemeProvider'

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: ReactNode }> = [
  { value: 'system', label: '跟随系统', icon: <DesktopOutlined /> },
  { value: 'light', label: '浅色', icon: <SunOutlined /> },
  { value: 'dark', label: '深色', icon: <MoonOutlined /> }
]

/**
 * 主题切换。
 * 默认「跟随系统」——桌面应用不应该在用户已经把系统切成深色之后
 * 还固执地亮着白底。
 */
export function ThemeToggle() {
  const { preference, setPreference } = useThemeMode()

  return (
    <Segmented
      size="small"
      value={preference}
      onChange={(value) => setPreference(value as ThemePreference)}
      options={OPTIONS.map((option) => ({
        value: option.value,
        label: (
          <Tooltip title={option.label}>
            <span className="theme-toggle__item" aria-label={option.label}>
              {option.icon}
            </span>
          </Tooltip>
        )
      }))}
    />
  )
}
