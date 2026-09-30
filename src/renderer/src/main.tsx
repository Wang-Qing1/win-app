import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTauriBridge } from './lib/tauri-bridge'
import './styles.css'

/*
 * 桥接安装必须发生在任何组件挂载之前 —— React Query 的首次请求
 * 在 render 之后立刻发出，晚一步就会撞上「桥接未就绪」。
 */
installTauriBridge()

const container = document.getElementById('root')

if (!container) {
  throw new Error('渲染失败：页面中找不到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
