import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

/** 命中这些 key 的字段一律替换为 [redacted]，防止密码/令牌落盘 */
const SENSITIVE_KEY_PATTERN = /pass(word|wd)?|secret|token|authorization|cookie|credential|api[-_]?key/i

const MAX_DEPTH = 5
const MAX_ARRAY_ITEMS = 50

let minLevel: LogLevel = 'info'
let maxBytes = 5 * 1024 * 1024
let consoleEnabled = true
let logFilePath: string | null = null
let stream: WriteStream | null = null
let bytesWritten = 0

export interface LoggerOptions {
  level: LogLevel
  /** 日志目录，通常为 app.getPath('userData')/logs */
  directory?: string
  maxBytes?: number
  console?: boolean
}

export function configureLogger(options: LoggerOptions): void {
  minLevel = options.level
  consoleEnabled = options.console ?? true
  if (options.maxBytes !== undefined) maxBytes = options.maxBytes

  if (!options.directory) return

  try {
    mkdirSync(options.directory, { recursive: true })
    const target = join(options.directory, 'wapp.log')
    bytesWritten = existsSync(target) ? statSync(target).size : 0
    stream = createWriteStream(target, { flags: 'a', encoding: 'utf8' })
    logFilePath = target
  } catch (error) {
    stream = null
    logFilePath = null
    console.error('[wapp] 日志文件初始化失败，将仅输出到控制台：', error)
  }
}

export function getLogFilePath(): string | null {
  return logFilePath
}

export async function flushLogger(): Promise<void> {
  const pending = stream
  if (!pending) return
  await new Promise<void>((resolve) => pending.end(() => resolve()))
  stream = null
}

function rotateIfNeeded(): void {
  if (!stream || !logFilePath) return
  if (bytesWritten < maxBytes) return
  try {
    stream.end()
    renameSync(logFilePath, `${logFilePath}.1`)
    stream = createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' })
    bytesWritten = 0
  } catch {
    // 轮转失败不应影响业务，继续往原文件追加
    stream = createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' })
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]'
  if (value === null || value === undefined) return value

  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') return value

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1))
  }

  if (type === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : sanitize(item, depth + 1)
    }
    return result
  }

  return String(value)
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message
  }
  if (fields && Object.keys(fields).length > 0) {
    record.data = sanitize(fields)
  }

  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg: message, data: '[unserializable]' })
  }

  if (consoleEnabled) {
    const printer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    printer(`[wapp:${level}] ${message}`, fields ?? '')
  }

  if (!stream) return
  rotateIfNeeded()
  bytesWritten += Buffer.byteLength(line, 'utf8') + 1
  stream.write(`${line}\n`)
}

export interface Logger {
  debug: (message: string, fields?: LogFields) => void
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
  /** 派生子 logger，把公共字段（如 requestId）预置进去 */
  child: (base: LogFields) => Logger
}

function createLogger(base?: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields | undefined => {
    if (!base) return fields
    return fields ? { ...base, ...fields } : base
  }
  return {
    debug: (message, fields) => emit('debug', message, merge(fields)),
    info: (message, fields) => emit('info', message, merge(fields)),
    warn: (message, fields) => emit('warn', message, merge(fields)),
    error: (message, fields) => emit('error', message, merge(fields)),
    child: (extra) => createLogger({ ...base, ...extra })
  }
}

export const logger: Logger = createLogger()
