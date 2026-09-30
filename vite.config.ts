import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 前端构建配置 —— `tauri dev` / `tauri build` 走这一份。
 *
 * 下面几处都是踩过才知道的，改任何一条之前先看清理由：
 *
 * 1. `base: './'` —— 默认值是 `/`，会产出 `/assets/...` 这样的绝对路径。
 *    Tauri 用 `tauri://localhost` 按目录服务前端产物，绝对路径直接 404，
 *    症状是白屏且控制台只有资源加载失败、没有别的线索。
 *
 * 2. `build.outDir` 必须与 `src-tauri/tauri.conf.json` 的 `frontendDist`
 *    逐字对上（两边都是 `dist`）。不一致时 `tauri build` 会把上一次的陈旧
 *    产物打进安装包，而且构建过程不报任何错 —— 只有装完打开才发现是旧界面。
 *
 * 3. 不引入 externalize 类插件 —— 渲染进程必须把一切打进 bundle（WebView
 *    里没有 node_modules 可读）。把 antd 之类变成运行期外部依赖，等于直接崩。
 *
 * 4. `server.port` 显式钉死 5173 + `strictPort` —— 与 tauri.conf.json 的
 *    `devUrl` 必须逐字对上。不加 `strictPort` 时端口被占会静默换号，
 *    Tauri 仍然去连 5173，表现为「dev server 起来了但窗口一直空白」。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/renderer/index.html') }
    },
    // antd 未压缩时 2.9MB / 8.4 万行，渲染产物每次冷启动都要被解析，必须压缩。
    minify: 'esbuild',
    chunkSizeWarningLimit: 3500
  }
})
