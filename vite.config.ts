import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 纯前端构建配置 —— Tauri 壳专用（`tauri dev` / `tauri build` 走这一份）。
 *
 * 与 `electron.vite.config.ts` 的 renderer 段同源，但有四处**必须**不同，
 * 每一处都是踩过才知道的：
 *
 * 1. `base: './'` —— electron-vite 默认给渲染进程设了相对 base，产物里是
 *    `./assets/...`；而纯 vite 的默认值是 `/`，会产出 `/assets/...`。
 *    Tauri 用 `tauri://localhost` 按目录服务前端产物，绝对路径直接 404，
 *    症状是白屏且控制台只有资源加载失败、没有别的线索。
 *
 * 2. `build.outDir` 显式指回 `out/renderer` —— 保持
 *    `src-tauri/tauri.conf.json` 里的 `frontendDist: "../out/renderer"` 不动。
 *    两个壳共用同一份产物路径，这样比对「Electron 包 vs Tauri 包」的体积时
 *    前端那一份是同一个东西，差异全部来自壳本身，不会串。
 *
 * 3. 不引入 `externalizeDepsPlugin` —— 它的作用是让主进程/preload 里的
 *    node 内置模块与依赖不被打包（运行时从 node_modules 读）。渲染进程
 *    本来就该把一切打进 bundle（它没有 node_modules 可读），加了反而会把
 *    antd 之类变成运行期外部依赖，在 WebView2 里直接崩。
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
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/renderer/index.html') }
    },
    // 与 electron.vite.config.ts 的 renderer 段保持一致：antd 未压缩时
    // 2.9MB / 8.4 万行，渲染产物每次冷启动都要被解析，必须压缩。
    minify: 'esbuild',
    chunkSizeWarningLimit: 3500
  }
})
