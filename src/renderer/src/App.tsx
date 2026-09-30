import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { BooksPage } from './features/books/BooksPage'
import { CardsPage } from './features/cards/CardsPage'
import { ChapterEditorPage } from './features/chapters/ChapterEditorPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { OutlinePage } from './features/outline/OutlinePage'
import { StatsPage } from './features/stats/StatsPage'
import { TrashPage } from './features/trash/TrashPage'
import { dismissBootSplash } from './lib/boot-splash'
import { queryClient } from './lib/query-client'
import { ThemeModeProvider } from './theme/ThemeProvider'

/**
 * 应用根组件。
 *
 * 用 HashRouter 而不是 BrowserRouter：打包后页面由宿主按目录服务加载
 * （Tauri 走的是自己的自定义协议），history API 在这种加载方式下无法正确
 * 工作（刷新即 404，因为不存在一个会按路径回 index.html 的服务端）。
 * hash 路由把路径放在 # 后面，对底层协议完全不敏感。
 *
 * ThemeModeProvider 必须在最外层：它内部除了 ConfigProvider 还挂了 antd 的
 * App 组件，而 useToast 依赖 App.useApp() 提供的上下文。放在内层会让
 * 提示信息脱离主题与语言包。
 */
export default function App() {
  /*
   * 首帧提交后撤掉 index.html 里的启动占位。
   *
   * 放在这里而不是 main.tsx：`createRoot().render()` 只是把工作排队，
   * 返回时 DOM 还没提交，靠 raf 猜一帧会猜早。effect 的时机是确定的。
   * 占位不会自己消失 —— 它在 #root 外面，React 挂载时不会顺手清掉它。
   */
  useEffect(() => {
    dismissBootSplash()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeModeProvider>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />

              <Route path="books" element={<BooksPage />} />
              {/*
                打开一本书 = 进正文编辑页（用户 2026-09-20：「新建书籍并且打开
                书籍之后应该是正文编辑页，不应该出现这个统计界面」）。
                原先这里挂着 `BookDetailPage`（书名 + 四张概览卡 + 分卷卡片 +
                章节表格），那一页已整体取消：它的统计进了编辑器底栏，
                卷章管理进了左侧目录的右键菜单，书籍级操作进了顶栏 `…` 菜单。

                两个路由指向同一个组件，差别的只是「有没有指定章节」：
                没指定时它会自己跳到这本书最近写过的章（没有章节就停在空态）。
              */}
              <Route path="books/:bookId" element={<ChapterEditorPage />} />
              <Route path="books/:bookId/chapters/:chapterId" element={<ChapterEditorPage />} />

              <Route path="outline" element={<OutlinePage />} />
              <Route path="cards" element={<CardsPage />} />

              <Route path="stats" element={<StatsPage />} />
              <Route path="trash" element={<TrashPage />} />

              {/* 未知路径回首页，而不是留在空白页 */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </ThemeModeProvider>
    </QueryClientProvider>
  )
}
