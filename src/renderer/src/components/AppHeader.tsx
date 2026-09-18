import { Flex, Layout, Tooltip } from 'antd'
import { HealthBadge } from './HealthBadge'
import { ThemeToggle } from './ThemeToggle'
import { GlobalSearch } from '../features/search/GlobalSearch'

const { Header } = Layout

/**
 * 顶部工具条（上下结构的第一行）。
 *
 * 承担三件事：品牌区（布局改为上下结构后，应用名从原侧栏回到这里）、
 * 全库检索（Ctrl+K，任意页面可用），以及全局状态（健康徽标 + 主题切换）。
 *
 * 检索框放在顶栏居中：它是「随时想起随时查」的动作，任何页面都要能直达。
 */
export function AppHeader() {
  return (
    <Header className="app-header">
      <Tooltip title="小说助手 · 本机写作管理" placement="bottomLeft">
        <Flex align="center" gap={10} className="app-header__brand">
          <span className="app-header__logo" aria-hidden="true">
            小
          </span>
          <Flex vertical className="app-header__brand-text">
            <span className="app-header__title">小说助手</span>
            <span className="app-header__subtitle">本机写作管理</span>
          </Flex>
        </Flex>
      </Tooltip>

      <div className="app-header__center">
        <GlobalSearch />
      </div>

      <Flex align="center" gap={16}>
        <HealthBadge />
        <ThemeToggle />
      </Flex>
    </Header>
  )
}
