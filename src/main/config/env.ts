import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import type { LogLevel } from '../core/logger'

/* ------------------------------------------------------------------ *
 * 环境变量 schema
 *
 * 所有配置都从这里进入应用：启动时一次性校验，任何一项非法立即快速失败，
 * 而不是等到运行时某个功能静默失效。业务代码永远不直接读 process.env。
 * ------------------------------------------------------------------ */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  WAPP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WAPP_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024, '日志上限不得小于 64KB')
    .max(512 * 1024 * 1024, '日志上限不得大于 512MB')
    .default(5 * 1024 * 1024),
  WAPP_DB_FILENAME: z
    .string()
    .trim()
    .min(1, '数据库文件名不能为空')
    .max(128, '数据库文件名过长')
    .refine((value) => !/[\\/:*?"<>|]/.test(value), '数据库文件名不得包含路径分隔符或非法字符')
    .default('wapp.db'),
  WAPP_WINDOW_WIDTH: z.coerce.number().int().min(640, '窗口宽度不得小于 640').max(10000).default(1280),
  WAPP_WINDOW_HEIGHT: z.coerce.number().int().min(480, '窗口高度不得小于 480').max(10000).default(820),
  WAPP_DEVTOOLS: z.enum(['true', 'false']).default('false'),
  /*
   * 虚拟机、远程桌面、部分服务器与 CI 环境里没有可用的 GPU。
   * 这种情况下 Chromium 的 GPU 进程会反复崩溃，最终直接把整个应用带崩
   * （日志里表现为 "GPU process isn't usable. Goodbye."，退出码 3）。
   * 打开这个开关改为软件渲染即可正常启动，代价是界面渲染性能下降。
   */
  WAPP_DISABLE_GPU: z.enum(['true', 'false']).default('false')
})

export interface AppConfig {
  readonly env: 'development' | 'production' | 'test'
  readonly isDevelopment: boolean
  readonly isProduction: boolean
  readonly logLevel: LogLevel
  readonly logMaxBytes: number
  readonly logDir: string
  readonly dbFileName: string
  readonly userDataDir: string
  readonly window: { readonly width: number; readonly height: number }
  readonly openDevTools: boolean
  readonly disableGpu: boolean
}

/** 配置错误：单独一类，启动阶段捕获后弹窗提示而不是抛未捕获异常 */
export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`环境变量校验失败：\n${issues.map((line) => `  · ${line}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/**
 * 极简 .env 解析（刻意不引入 dotenv）。
 * 已存在于 process.env 的变量优先，便于命令行临时覆盖。
 */
function loadDotEnvFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false

  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return false
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)

    if (process.env[key] === undefined) process.env[key] = value
  }

  return true
}

function resolveEnvFilePath(): string {
  if (!app.isPackaged) {
    return join(app.getAppPath(), '.env')
  }
  const bundled = join(process.resourcesPath, '.env')
  return existsSync(bundled) ? bundled : join(app.getPath('userData'), '.env')
}

export function loadConfig(): AppConfig {
  loadDotEnvFile(resolveEnvFilePath())

  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
    )
  }

  const value = parsed.data
  const userDataDir = app.getPath('userData')

  return Object.freeze({
    env: value.NODE_ENV,
    isDevelopment: value.NODE_ENV === 'development',
    isProduction: value.NODE_ENV === 'production',
    logLevel: value.WAPP_LOG_LEVEL,
    logMaxBytes: value.WAPP_LOG_MAX_BYTES,
    logDir: join(userDataDir, 'logs'),
    dbFileName: value.WAPP_DB_FILENAME,
    userDataDir,
    window: Object.freeze({ width: value.WAPP_WINDOW_WIDTH, height: value.WAPP_WINDOW_HEIGHT }),
    openDevTools: value.WAPP_DEVTOOLS === 'true',
    disableGpu: value.WAPP_DISABLE_GPU === 'true'
  })
}
