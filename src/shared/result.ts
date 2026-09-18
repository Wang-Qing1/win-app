/**
 * 跨进程统一响应信封。
 *
 * 设计要点：主进程永远不把异常直接抛给渲染进程（Electron 会把 Error 序列化成
 * 一个信息残缺的字符串）。所有 handler 的返回值都被包成 IpcResponse，
 * 失败时只回传规范化错误码与用户可读文案，堆栈与内部细节仅写进主进程日志。
 */

export type AppErrorCode =
  /** 入参未通过校验 —— 属于调用方问题，前端不应重试 */
  | 'VALIDATION_ERROR'
  /** 目标资源不存在 */
  | 'NOT_FOUND'
  /** 与现有数据冲突（如唯一性约束） */
  | 'CONFLICT'
  /** 服务端内部错误 —— 前端可有限重试 */
  | 'INTERNAL_ERROR'
  /** 未归类的异常 */
  | 'UNKNOWN'

/** 字段级校验明细，供表单把错误定位到具体输入框 */
export interface FieldIssue {
  /** 字段路径，如 name / tags.0 */
  path: string
  message: string
}

export interface AppErrorPayload {
  code: AppErrorCode
  /** 面向用户的提示文案，已做脱敏，可直接渲染 */
  message: string
  /** 请求追踪 ID，与主进程日志中的 requestId 对应 */
  requestId: string
  /** 仅校验类错误携带 */
  issues?: FieldIssue[]
}

export interface IpcSuccess<T> {
  ok: true
  data: T
}

export interface IpcFailure {
  ok: false
  error: AppErrorPayload
}

export type IpcResponse<T> = IpcSuccess<T> | IpcFailure

export function isIpcSuccess<T>(response: IpcResponse<T>): response is IpcSuccess<T> {
  return response.ok === true
}

export function isFieldIssueArray(value: unknown): value is FieldIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as FieldIssue).path === 'string' &&
        typeof (item as FieldIssue).message === 'string'
    )
  )
}
