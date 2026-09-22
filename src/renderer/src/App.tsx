import { QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { BooksPage } from './features/books/BooksPage'
import { CardsPage } from './features/cards/CardsPage'
import { ChapterEditorPage } from './features/chapters/ChapterEditorPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { OutlinePage } from './features/outline/OutlinePage'
import { StatsPage } from './features/stats/StatsPage'
import { TrashPage } from './features/trash/TrashPage'
import { queryClient } from './lib/query-client'
import { ThemeModeProvider } from './theme/ThemeProvider'

/**
 * 应用根组件。
 *
 * 用 HashRouter 而不是 BrowserRouter：打包后渲染进程是通过 file:// 协议
 * 加载 index.html 的，history API 在这种协议下无法正确工作（刷新即 404，
 * 因为不存在一个会返回 index.html 的服务端）。hash 路由把路径放在 # 后面，
 * 对 file:// 完全透明。
 *
 * ThemeModeProvider 必须在最外层：它内部除了 ConfigProvider 还挂了 antd 的
 * App 组件，而 useToast 依赖 App.useApp() 提供的上下文。放在内层会让
 * 提示信息脱离主题与语言包。
 */
export default function App() {
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
