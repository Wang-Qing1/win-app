import { useMemo } from 'react'
import { Tooltip } from 'antd'
import { useLocation, useNavigate } from 'react-router'
import { findActiveNavKey, NAV_ITEMS } from './nav'

/**
 * 顶部横向导航（上下结构：顶栏在上，导航条在其下，内容区最后）。
 *
 * 选型变更说明：原先用左侧栏，理由是「模块多了横向会挤」；实测五个模块
 * 只占顶栏一半宽度，而侧栏在 1280 宽的窗口里吃掉 208px 纵贯全高的空间，
 * 对写正文这种横向敏感的场景是净亏损。改为上下结构后与主流桌面工具一致。
 *
 * 这里用原生 button 而不是 antd Menu horizontal：只有五个对等项、无子菜单，
 * 自绘能精确控制「选中 = 底部指示条 + 柔和底色」的观感，还少一层 Menu 的
 * 浮层与键盘陷阱逻辑。
 */
export function AppNav() {
  const location = useLocation()
  const navigate = useNavigate()

  const selectedKey = findActiveNavKey(location.pathname)

  const items = useMemo(() => NAV_ITEMS.map((item) => ({ item, selected: item.key === selectedKey })), [selectedKey])

  return (
    <nav className="app-nav" data-testid="app-nav" aria-label="主导航">
      {items.map(({ item, selected }) => {
        const tab = (
          <button
            key={item.key}
            type="button"
            className={selected ? 'app-nav__item app-nav__item--active' : 'app-nav__item'}
            aria-current={selected ? 'page' : undefined}
            disabled={!item.ready}
            onClick={() => {
              if (item.ready) void navigate(item.path)
            }}
          >
            <span className="app-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </button>
        )

        return item.ready ? (
          tab
        ) : (
          <Tooltip key={item.key} title="这个模块还在开发中" placement="bottom">
            {tab}
          </Tooltip>
        )
      })}
    </nav>
  )
}
