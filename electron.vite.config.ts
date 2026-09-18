import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      },
      // electron-vite 默认给渲染进程设了 minify: false（为了便于调试）。
      // 但渲染产物是要被 Chromium 在每次冷启动时解析的，本项目引入 antd 后
      // 未压缩体积达 2.9MB / 8.4 万行，直接影响启动耗时，所以这里显式开回来。
      // 主进程与 preload 保持不压缩：它们只有几十 KB，留着未压缩反而好读堆栈。
      minify: 'esbuild',
      // 关掉「压缩后体积」的统计输出没有意义（Electron 从本地磁盘读，不走网络），
      // electron-vite 已默认关闭，这里不重复设置
      chunkSizeWarningLimit: 3500
    }
  }
})
