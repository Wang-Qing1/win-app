import type { AppErrorCode, FieldIssue } from '@shared/result'

export interface AppErrorOptions {
  /** 字段级校验明细 */
  issues?: FieldIssue[]
  /** 原始异常，仅用于日志，不会跨进程传递 */
  cause?: unknown
}

/**
 * 应用内统一错误类型。
 *
 * 约定：服务层与仓储层只抛 AppError，控制器不再做错误转换。
 * IPC 边界会把它翻译成 AppErrorPayload —— 只有 code / message / requestId / issues
 * 会离开主进程，堆栈与 cause 永远只留在日志里，绝不返回给前端。
 */
export class AppError extends Error {
  readonly code: AppErrorCode
  readonly issues: FieldIssue[] | undefined
  /** 预期内错误（校验失败、找不到等）：日志按 warn 记录，且不算故障 */
  readonly expected: boolean

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.issues = options.issues
    this.expected = code !== 'INTERNAL_ERROR' && code !== 'UNKNOWN'
    Error.captureStackTrace(this, AppError)
  }

  static validation(message: string, issues?: FieldIssue[]): AppError {
    return new AppError('VALIDATION_ERROR', message, { issues })
  }

  static notFound(message: string): AppError {
    return new AppError('NOT_FOUND', message)
  }

  static conflict(message: string): AppError {
    return new AppError('CONFLICT', message)
  }

  static internal(message: string, cause?: unknown): AppError {
    return new AppError('INTERNAL_ERROR', message, { cause })
  }

  /**
   * 把未知异常收斂为 AppError。
   * 已经是 AppError 就原样返回，避免包装层不断套娃。
   */
  static from(error: unknown, fallbackMessage = '应用内部错误'): AppError {
    if (error instanceof AppError) return error
    if (error instanceof Error) return AppError.internal(fallbackMessage, error)
    return new AppError('UNKNOWN', fallbackMessage, { cause: error })
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
