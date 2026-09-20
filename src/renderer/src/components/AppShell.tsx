import { Layout } from 'antd'
import { Outlet, useLocation } from 'react-router'
import { AppHeader } from './AppHeader'
import { OfflineBanner } from './OfflineBanner'

/**
 * 应用外壳：顶栏（返回首页 + 品牌 + 检索 + 状态）→ 内容区。
 *
 * 顶部导航条已整条移除（用户 2026-09-20 指定）：模块导航改由首页的
 * 四张功能卡片承担，模块页靠顶栏的「返回首页」图标回来。
 *
 * 路由出口放在 .app-main 内部，它同时也是唯一的滚动容器。
 * 页面自己不再各自建滚动区，避免出现嵌套滚动条（鼠标滚轮会时而滚页面、
 * 时而滚内部区域，这是桌面应用里最让人烦躁的体验之一）。
 */
/**
 * 需要占满整个内容区、自己管理滚动的路由。
 *
 * 章节编辑器要的是「写作时视野完整」，大纲与卡片库要的是「两栏各自滚动」——
 * 它们都需要外部不加内边距、不做滚动。
 */
const FLUSH_ROUTES = [/^\/books\/\d+\/chapters\/\d+$/, /^\/outline$/, /^\/cards$/]

export function AppShell() {
  const location = useLocation()

  // 章节编辑器要占满整个内容区（左右不留白），写作时视野更完整。
  // 用路由判断而不是让页面自己负边距去抵消父容器的 padding ——
  // 后者在改动 padding 时会静默错位。
  const isFlush = FLUSH_ROUTES.some((pattern) => pattern.test(location.pathname))

  return (
    <Layout className="app-shell">
      <AppHeader />
      <OfflineBanner />
      <Layout.Content className={isFlush ? 'app-main app-main--flush' : 'app-main'}>
        <Outlet />
      </Layout.Content>
    </Layout>
  )
}
