/// <reference types="vite/client" />

import type { WinbookApi } from '@shared/api'

declare global {
  interface Window {
    /** 由 `lib/tauri-bridge.ts` 在 React 挂载前装到 window 上 */
    readonly winbook: WinbookApi
  }
}

export {}
