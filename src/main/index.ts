import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { ConfigError, loadConfig, type AppConfig } from './config/env'
import { unregisterAllHandlers } from './core/ipc-handler'
import { configureLogger, flushLogger, logger } from './core/logger'
import { closeDatabase, initDatabase } from './db/connection'
import { runMigrations } from './db/migrator'
import { registerAllIpcHandlers } from './ipc/registry'
import { reportSmokeResults, runBackendSmokeChecks, runRendererSmokeChecks } from './smoke-test'
import { applySecurityPolicies, createMainWindow } from './window/main-window'

let mainWindow: BrowserWindow | null = null
let shutdownStarted = false
let shutdownCompleted = false

/**
 * 冒烟测试模式：npm run smoke
 * 用临时用户数据目录启动，跑完自检后按结果决定退出码，不显示窗口、
 * 也绝不碰用户真实的 winbook.db。
 */
const isSmokeTest = process.argv.includes('--smoke-test')

if (isSmokeTest) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'winbook-smoke-')))
}

// 必须在 app ready 之前设置，否则 Windows 任务栏分组与通知会归属错误
app.setAppUserModelId('com.winbook.desktop')

/* ------------------------------------------------------------------ *
 * 单实例锁：桌面应用双击图标很容易开出多个进程，
 * 而多进程同时持有同一个 SQLite 文件会带来意料之外的写冲突。
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    // Windows 上关掉窗口就该退出；保留 darwin 分支便于将来跨平台
    if (process.platform !== 'darwin') app.quit()
  })

  // 优雅停机：先摘下所有 IPC handler，再关数据库，最后把日志刷盘
  app.on('before-quit', (event) => {
    if (shutdownCompleted) return
    event.preventDefault()
    void shutdown().then(() => {
      shutdownCompleted = true
      app.quit()
    })
  })

  void bootstrap()
}

/**
 * 启动编排。
 *
 * 次序是刻意安排的：配置与日志必须在 app ready **之前**就绪，原因有两个 ——
 *   1. disableHardwareAcceleration / commandLine 这类开关只在 ready 前生效；
 *   2. 配置非法时可以立刻弹窗退出，不用白等一次 ready。
 */
function bootstrap(): void {
  let config: AppConfig

  try {
    config = loadConfig()
    configureLogger({
      level: config.logLevel,
      directory: config.logDir,
      maxBytes: config.logMaxBytes,
      console: true
    })
    logger.info('winbook 正在启动', {
      version: app.getVersion(),
      env: config.env,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome
    })
  } catch (error) {
    const detail = error instanceof ConfigError ? error.message : String(error)
    dialog.showErrorBox('winbook 启动失败', `配置校验未通过，应用无法启动。\n\n${detail}`)
    app.exit(1)
    return
  }

  if (isSmokeTest || config.disableGpu) {
    // 无显卡环境下 Chromium 的 GPU 进程会反复崩溃并带走整个应用。
    // 关键的一步是 in-process-gpu：不另起 GPU 子进程，直接在浏览器进程里渲染，
    // 这样在禁止创建子进程的受限环境（容器、CI、部分沙箱）里也能跑起来。
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')
    app.commandLine.appendSwitch('disable-gpu-sandbox')
    app.commandLine.appendSwitch('in-process-gpu')
    app.commandLine.appendSwitch('disable-software-rasterizer')

    logger.warn('已关闭硬件加速，改用进程内软件渲染', {
      reason: isSmokeTest ? '冒烟测试模式' : 'WINBOOK_DISABLE_GPU=true'
    })
  }

  if (isSmokeTest) {
    // 仅冒烟测试：受限环境下 Chromium 的进程沙箱可能无法初始化。
    // 这只是自动化自检，且使用临时目录、不接触任何真实用户数据，
    // 因此可以安全放开。正常运行路径绝不会走这里。
    app.commandLine.appendSwitch('no-sandbox')
  }

  void app.whenReady().then(() => startApplication(config))
}

async function startApplication(config: AppConfig): Promise<void> {
  try {
    const db = initDatabase(config)
    const migrationResult = runMigrations(db)

    registerAllIpcHandlers(config)

    if (isSmokeTest) {
      await runSmokeTest(config)
      return
    }

    applySecurityPolicies()

    mainWindow = createMainWindow(config)
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    logger.info('winbook 已就绪', {
      userDataDir: config.userDataDir,
      database: config.dbFileName,
      appliedMigrations: migrationResult.applied,
      schemaVersion: migrationResult.current
    })
  } catch (error) {
    logger.error('winbook 启动失败', { error })
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('winbook 启动失败', `应用初始化失败，无法启动。\n\n${message}`)
    app.exit(1)
  }
}

async function runSmokeTest(config: AppConfig): Promise<void> {
  const backend = await runBackendSmokeChecks()

  const smokeWindow = createMainWindow(config, { showWindow: false })
  const rendererResults = await runRendererSmokeChecks(smokeWindow, backend.showcase)
  smokeWindow.destroy()

  const passed = reportSmokeResults(
    [...backend.results, ...rendererResults],
    // 用 cwd 而不是 app.getAppPath()：打包后 getAppPath() 指向只读的 app.asar 内部，
    // 报告写不进去。cwd 在开发（npm run smoke）与打包后（在任意目录执行 winbook.exe）都可用。
    join(process.cwd(), 'smoke-report.txt')
  )

  // 走一遍正常停机流程，让日志刷盘、数据库连接正常关闭
  await shutdown()
  app.exit(passed ? 0 : 1)
}

async function shutdown(): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true

  logger.info('winbook 正在关闭')
  try {
    unregisterAllHandlers()
    closeDatabase()
    await flushLogger()
  } catch (error) {
    console.error('[winbook] 关闭过程中出现异常：', error)
  }
}
