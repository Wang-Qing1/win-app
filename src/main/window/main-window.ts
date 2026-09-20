import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, session, shell } from 'electron'
import type { AppConfig } from '../config/env'
import { logger } from '../core/logger'

/**
 * 生产环境 CSP。
 * 开发环境刻意不注入 —— Vite 的 HMR 需要 inline script 与 ws 连接，
 * 强上严格 CSP 只会让开发寸步难行；构建产物才是真正需要被约束的对象。
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export function applySecurityPolicies(): void {
  if (!app.isPackaged) {
    logger.debug('开发模式：跳过严格 CSP 注入')
    return
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [PRODUCTION_CSP],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })

  // 生产环境移除默认菜单：既让界面干净，也避免暴露 Ctrl+R 重载与 DevTools 快捷键
  Menu.setApplicationMenu(null)

  logger.debug('已注入生产环境安全策略')
}

export interface MainWindowOptions {
  /** 冒烟测试时不显示窗口，只在后台把页面渲染出来做断言 */
  showWindow?: boolean
}

/**
 * 开发模式的窗口图标。
 *
 * 只有开发模式需要它：打包后 electron-builder 已经把图标嵌进 exe，窗口自己
 * 就能取到；而 build/ 是构建资源目录，不会被打进 asar，指向它必然落空。
 * 不指定的话，开发时跑的是 node_modules 里的 electron.exe，任务栏上会是
 * Electron 的默认图标 —— 和最终形态不一致，很容易一路带到发布才发现。
 *
 * 用 .ico 而不是 .png：Windows 会按当前显示尺寸从多尺寸 ico 里挑最合适的那一张，
 * png 只能交给系统缩放，任务栏那种小尺寸会糊。
 */
function resolveWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined

  const devIcon = join(app.getAppPath(), 'build', 'icon.ico')
  if (existsSync(devIcon)) return devIcon

  logger.warn('未找到开发环境窗口图标，任务栏将显示 Electron 默认图标', { devIcon })
  return undefined
}

export function createMainWindow(config: AppConfig, options: MainWindowOptions = {}): BrowserWindow {
  const shouldShow = options.showWindow !== false

  // 窗口底色跟随系统深浅色。
  // 前端默认偏好是「跟随系统」，所以绝大多数情况下这个值就是对的，
  // 能消除深色系统下窗口出现瞬间闪白 —— 窗口本身要等 ready-to-show
  // 才显示，但底色在显示之前就已经参与合成了。
  const dark = nativeTheme.shouldUseDarkColors
  const icon = resolveWindowIcon()

  const window = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: 960,
    minHeight: 640,
    title: 'winbook',
    // 显式传 undefined 也是合法的，但这里干脆不塞这个键，
    // 免得以后有人误以为「图标已配置」却拿到默认图标
    ...(icon === undefined ? {} : { icon }),
    show: false,
    autoHideMenuBar: true,
    // 与 src/renderer/src/theme/tokens.ts 的 colorBgLayout 保持一致
    backgroundColor: dark ? '#1f1f1f' : '#f3f3f3',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 以下四项是本项目的安全底线，改动前请先想清楚攻击面
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  // 先渲染完再显示，避免白屏闪烁
  window.once('ready-to-show', () => {
    if (!shouldShow) return
    window.show()
    if (config.openDevTools) window.webContents.openDevTools({ mode: 'detach' })
  })

  // 站内跳转一律拦截，外部链接交给系统浏览器
  window.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL
    const isDevServer = devServerUrl !== undefined && url.startsWith(devServerUrl)
    if (!isDevServer) {
      event.preventDefault()
      logger.warn('已拦截页面跳转', { url })
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 拒绝一切权限申请（摄像头、麦克风、通知、地理位置等），
  // 本项目当前不需要任何系统权限；将来需要时按 origin 白名单精确放行
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    logger.warn('已拒绝权限申请', { permission })
    callback(false)
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl !== undefined && devServerUrl.length > 0) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  logger.info('主窗口已创建', {
    width: config.window.width,
    height: config.window.height,
    mode: !app.isPackaged && devServerUrl ? 'dev-server' : 'file'
  })

  return window
}
