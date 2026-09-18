import { QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { BooksPage } from './features/books/BooksPage'
import { BookDetailPage } from './features/books/BookDetailPage'
import { CardsPage } from './features/cards/CardsPage'
import { ChapterEditorPage } from './features/chapters/ChapterEditorPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { OutlinePage } from './features/outline/OutlinePage'
import { StatsPage } from './features/stats/StatsPage'
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
              <Route path="books/:bookId" element={<BookDetailPage />} />
              <Route path="books/:bookId/chapters/:chapterId" element={<ChapterEditorPage />} />

              <Route path="outline" element={<OutlinePage />} />
              <Route path="cards" element={<CardsPage />} />

              <Route path="stats" element={<StatsPage />} />

              {/* 未知路径回首页，而不是留在空白页 */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </ThemeModeProvider>
    </QueryClientProvider>
  )
}
