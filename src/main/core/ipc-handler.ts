import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ZodError } from 'zod'
import type { AppErrorPayload, FieldIssue, IpcResponse } from '@shared/result'
import { AppError } from './errors'
import { logger } from './logger'
import { createRequestId } from './request-id'

export interface HandlerContext {
  requestId: string
  channel: string
  event: IpcMainInvokeEvent
}

export interface HandlerDefinition<TInput, TResult> {
  /** 人类可读名称，写进日志便于定位是哪个功能出错 */
  label: string
  /** 边界校验。抛 ZodError 会被统一翻译成 VALIDATION_ERROR */
  parse?: (raw: unknown) => TInput
  handle: (input: TInput, ctx: HandlerContext) => TResult | Promise<TResult>
}

const registeredChannels = new Set<string>()
const channelParsers = new Map<string, (raw: unknown) => unknown>()

/** 被拒绝的调用。只留最近若干条，避免长跑进程里无限增长 */
const rejections: IpcRejection[] = []
const MAX_TRACKED_REJECTIONS = 50

export interface IpcRejection {
  channel: string
  code: string
  reason: string
}

/**
 * 统一的 IPC handler 注册入口。
 *
 * 所有通道必须经过这里，从而天然获得：
 *   1. 每个请求一个 requestId，日志与前端错误信封可对账；
 *   2. 边界校验（parse）在进入业务层之前完成；
 *   3. 任何异常都被收敛成 IpcResponse 信封，堆栈不外泄；
 *   4. 重复注册直接抛错，避免通道被静默覆盖。
 */
export function registerHandler<TInput, TResult>(
  channel: string,
  definition: HandlerDefinition<TInput, TResult>
): void {
  if (registeredChannels.has(channel)) {
    throw new Error(`IPC 通道重复注册：${channel}`)
  }
  registeredChannels.add(channel)
  if (definition.parse) channelParsers.set(channel, definition.parse as (raw: unknown) => unknown)

  ipcMain.handle(channel, async (event, rawInput): Promise<IpcResponse<TResult>> => {
    const requestId = createRequestId()
    const startedAt = Date.now()
    const baseFields = {
      requestId,
      channel,
      label: definition.label,
      origin: event.senderFrame?.url ?? 'unknown'
    }

    try {
      const input = definition.parse ? definition.parse(rawInput) : (rawInput as TInput)
      const data = await definition.handle(input, { requestId, channel, event })
      logger.debug('IPC 调用完成', { ...baseFields, durationMs: Date.now() - startedAt })
      return { ok: true, data }
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      const fields = {
        ...baseFields,
        durationMs: Date.now() - startedAt,
        code: payload.code,
        reason: payload.message
      }

      if (payload.code === 'INTERNAL_ERROR' || payload.code === 'UNKNOWN') {
        logger.error('IPC 调用发生内部错误', { ...fields, error: error })
      } else {
        logger.warn('IPC 调用被拒绝', fields)
      }

      // 记一笔，供冒烟测试复查。前端把失败翻译成空列表或骨架屏之后，
      // 整条链路的错误就只剩日志里的一行 —— 而日志默认没人看。
      if (rejections.length < MAX_TRACKED_REJECTIONS) {
        rejections.push({ channel, code: payload.code, reason: payload.message })
      }

      return { ok: false, error: payload }
    }
  })
}

export function unregisterAllHandlers(): void {
  for (const channel of registeredChannels) {
    ipcMain.removeHandler(channel)
  }
  registeredChannels.clear()
  channelParsers.clear()
  rejections.length = 0
}

export function getRegisteredChannels(): string[] {
  return [...registeredChannels].sort()
}

/**
 * 取到目前为止被拒绝的调用（仅冒烟测试使用）。
 *
 * 存在的理由：渲染进程拿到失败信封后往往降级成空列表 / 骨架屏，
 * 页面上看不出任何异常，测试也就跟着绿。只有把「有没有调用被拒」
 * 单独拎出来断言，这类静默失败才会浮出水面。
 */
export function getIpcRejections(): readonly IpcRejection[] {
  return [...rejections]
}

/**
 * 取出某个通道的边界校验器（仅冒烟测试使用）。
 *
 * 校验发生在服务层之外 —— 控制器挂上 schema，服务层只管业务。
 * 所以「非法数据被拒绝」这件事，直接调服务层是测不出来的，
 * 必须拿到真实的校验器跑一遍。这也顺便证明了控制器确实把
 * schema 挂上了，而不只是写在文件里。
 */
export function getChannelParser(channel: string): ((raw: unknown) => unknown) | undefined {
  return channelParsers.get(channel)
}

function toErrorPayload(error: unknown, requestId: string): AppErrorPayload {
  if (error instanceof AppError) {
    const payload: AppErrorPayload = {
      code: error.code,
      message: error.message,
      requestId
    }
    if (error.issues) payload.issues = error.issues
    return payload
  }

  if (error instanceof ZodError) {
    return {
      code: 'VALIDATION_ERROR',
      message: '提交的数据未通过校验，请检查后重试',
      requestId,
      issues: toFieldIssues(error)
    }
  }

  // 未知异常：不向前端泄露任何内部信息，只给可读文案 + 追踪 ID
  return {
    code: 'INTERNAL_ERROR',
    message: '应用内部错误，请稍后重试（若持续出现，请凭追踪 ID 查看日志）',
    requestId
  }
}

function toFieldIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.') || '_root',
    message: issue.message
  }))
}
