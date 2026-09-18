/// <reference types="vite/client" />

import type { WappApi } from '@shared/api'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入 */
    readonly wapp: WappApi
  }
}

export {}
