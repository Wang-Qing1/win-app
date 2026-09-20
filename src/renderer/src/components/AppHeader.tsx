import { Button, Flex, Layout, Tooltip } from 'antd'
import { HomeOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router'
import { TopBarMenu } from './TopBarMenu'
import { findActiveModule, HOME_PATH } from './nav'
import { GlobalSearch } from '../features/search/GlobalSearch'

const { Header } = Layout

/**
 * 顶部工具条。
 *
 * 承担三件事：**悬浮的返回首页按钮**、品牌区、全库检索（Ctrl+K），
 * 以及全局状态（健康徽标 + 备份 + 主题切换）。
 *
 * 返回首页是**悬浮按钮**（用户 2026-09-20 指定）：固定在窗口**右下角**、
 * 浮在界面之上，不属于顶栏的布局流。放在这里（而不是各页面自己摆一个）的理由：
 * 模块页有八个路由，每个页面各写一遍必然有漏掉的，漏掉的那个页面用户就走进
 * 死胡同 —— 顶栏是唯一「所有页面都经过」的地方。
 *
 * 首页上不显示它：首页就是根，没有「上一层」可回，摆一个点了没反应的按钮只是
 * 噪音。（也正因如此断言的是「首页上它必须不存在」。）
 *
 * 为什么不放左上角：那里是品牌区，按钮要么压住 logo，要么得在顶栏里留一个
 * 常驻空槽把它挤开 —— 后者等于承认它还是顶栏的一部分，与「悬浮」相矛盾。
 * 右下角是浮动按钮的常规位置，窗口四角里也只有它是空的（顶部两角是品牌与
 * 状态区，左下角在编辑器里是状态栏），而且离正文编辑区最远。
 */
export function AppHeader() {
  const location = useLocation()
  const navigate = useNavigate()

  const onHome = location.pathname === HOME_PATH
  // 模块名只用来给返回按钮写清楚「退到哪」，不显示在顶栏 —— 各页的标题默认
  // 也是隐藏的（见 PageHeader）：模块身份由内容本身就说清了，顶栏再写一遍
  // 只是重复。这里留着 module 是因为悬浮按钮的提示文案要用它。
  const module = findActiveModule(location.pathname)

  return (
    <>
      {onHome ? null : (
        <Tooltip
          title={module ? `返回首页（当前在「${module.label}」）` : '返回首页'}
          placement="topRight"
        >
          <Button
            type="text"
            className="app-icon-button app-icon-button--floating"
            aria-label="返回首页"
            data-testid="home-button"
            icon={<HomeOutlined />}
            onClick={() => void navigate(HOME_PATH)}
          />
        </Tooltip>
      )}

      <Header className="app-header">
        <Flex align="center" gap={10} className="app-header__left">
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
        </Flex>

        <div className="app-header__center">
          <GlobalSearch />
        </div>

        {/*
          右侧只有**一枚**圆形 `…` 按钮（用户 2026-09-20：「如果是多个功能按钮，
          则首先只展示一个 [...]（省略号）图标按钮，点击后展开下拉菜单，每个菜单项
          对应一个圆形功能图标（并排展示的功能图标取消）」）。

          主进程健康 / 备份数据库 / 主题切换三件事都在它的菜单里，
          见 `TopBarMenu`——那里也写了为什么不再并排摆三个圆钮。
        */}
        <TopBarMenu />
      </Header>
    </>
  )
}
