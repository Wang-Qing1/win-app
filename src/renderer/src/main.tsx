import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTauriBridge } from './lib/tauri-bridge'
import './styles.css'

/*
 * 桥接安装必须发生在任何组件挂载之前 —— React Query 的首次请求
 * 在 render 之后立刻发出，晚一步就会撞上「桥接未就绪」。
 *
 * 这个调用在 Electron 壳下是空操作（preload 已经装好了），
 * 因此过渡期两种壳可以共用同一份渲染产物。
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
