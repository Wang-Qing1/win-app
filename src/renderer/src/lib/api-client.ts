import type { WinbookApi } from '@shared/api'
import type { AppErrorCode, AppErrorPayload, FieldIssue, IpcResponse } from '@shared/result'

/**
 * 渲染进程侧的类型化错误。
 *
 * 主进程返回的是 IpcResponse 信封而不是异常 —— 跨 contextBridge 传 Error
 * 实例语义不可靠。本文件负责把信封拆开，失败时抛出 ApiError，
 * 于是 React Query / 表单 / 提示条都只需要处理一个统一的错误类型。
 */
export class ApiError extends Error {
  readonly code: AppErrorCode
  readonly requestId: string
  readonly issues: FieldIssue[]

  constructor(payload: AppErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.requestId = payload.requestId
    this.issues = payload.issues ?? []
  }

  /** 只有服务端内部错误才值得重试；校验/冲突/找不到重试多少次都一样 */
  get retryable(): boolean {
    return this.code === 'INTERNAL_ERROR' || this.code === 'UNKNOWN'
  }

  /** 字段级错误映射，供表单把提示精确落到对应输入框 */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const issue of this.issues) {
      if (result[issue.path] === undefined) {
        result[issue.path] = issue.message
      }
    }
    return result
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** 把任意异常转成可展示的文案，避免 UI 里出现 "undefined" 或 "[object Object]" */
export function toUserMessage(error: unknown): string {
  if (isApiError(error)) return error.message
  if (error instanceof Error && error.message.length > 0) return error.message
  return '发生未知错误，请重试'
}

let bridge: WinbookApi | null = null

export function getBridge(): WinbookApi {
  if (bridge) return bridge

  if (typeof window === 'undefined' || window.winbook === undefined) {
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: '桥接未就绪：请通过 winbook 桌面应用启动，而不是用浏览器直接打开页面',
      requestId: '-'
    })
  }

  bridge = window.winbook
  return bridge
}

/**
 * 统一的 IPC 调用包装：拆信封 + 异常归一化。
 * 所有对主进程的调用都必须经过它，避免各处重复写拆信封逻辑。
 */
export async function invoke<T>(call: () => Promise<IpcResponse<T>>): Promise<T> {
  let response: IpcResponse<T>

  try {
    response = await call()
  } catch {
    // 主进程重启、通道被移除等情况下 ipcRenderer.invoke 会直接 reject
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: '与主进程通信失败，请重启 winbook 后重试',
      requestId: '-'
    })
  }

  if (response.ok) return response.data
  throw new ApiError(response.error)
}
