import { randomUUID } from 'node:crypto'

/**
 * 生成请求追踪 ID。
 * 每条 IPC 调用分配一个，同时出现在：主进程日志、返回给前端的错误信封。
 * 用户报错时凭这个 ID 可以直接在日志里定位到那一次调用。
 */
export function createRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}
