/// <reference types="vite/client" />

import type { WinbookApi } from '@shared/api'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入 */
    readonly winbook: WinbookApi
  }
}

export {}
