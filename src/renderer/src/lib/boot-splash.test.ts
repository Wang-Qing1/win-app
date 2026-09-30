import { describe, expect, test, vi } from 'vitest'
/*
 * 用 vite 的 `?raw` 把 index.html 当字符串读进来，刻意**不用** node:fs：
 * 这个文件归 tsconfig.web.json 管，而那份配置只有 vite/client 类型、
 * 没有 @types/node，`await import('node:fs')` 会把 typecheck 直接打红。
 */
import indexHtml from '../../index.html?raw'
import { THEME_STORAGE_KEY } from '../theme/tokens'

/**
 * 启动占位的守卫。
 *
 * 这里断言的不是「样式好不好看」，而是几条**改一边漏一边就会静默坏掉**的约定：
 * 占位是一段不能 import 任何模块的内联代码，所以它和其他文件之间的一致性
 * 没有任何编译器或类型系统在管，只能靠这组断言。
 */

const styleBlock = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''

describe('启动占位：index.html 与其余代码的一致性', () => {
  test('主题键与 THEME_STORAGE_KEY 逐字一致', () => {
    // 内联脚本要早于 bundle 执行，因此没法 import 这个常量。
    // 抄一份是不可避免的，但抄错「深色偏好读不出来」这种 bug 没有任何报错。
    expect(indexHtml).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`)
  })

  test('占位用到的每个 CSS 变量都在同一段内联样式里定义了', () => {
    // 最实际的一类事故：占位里写了 var(--winbook-surface) 却忘了定义。
    // styles.css 要等 bundle 生效，所以那一刻变量还不存在 ——
    // 结果不是「样式差一点」，而是一块透明或纯黑的色块。
    const used = [...styleBlock.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1])
    const defined = new Set([...styleBlock.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]))

    expect(used.length).toBeGreaterThan(0)
    expect([...new Set(used)].filter((name) => !defined.has(name))).toEqual([])
  })

  test('深色主题下重定义了底色、文字色与强调色', () => {
    const dark = styleBlock.match(/html\[data-theme='dark'\]\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    for (const name of ['--winbook-bg', '--winbook-text', '--winbook-accent']) {
      expect(dark).toContain(`${name}:`)
    }
  })

  test('占位节点在 #root 之前，且对读屏有语义', () => {
    const bootAt = indexHtml.indexOf('id="boot"')
    const rootAt = indexHtml.indexOf('id="root"')

    // 排在 #root 之前 = 兄弟关系。嵌套进 #root 的话，React 挂载会连它一起
    // 清掉，lib/boot-splash.ts 里的撤场逻辑就变成了死代码
    expect(bootAt).toBeGreaterThan(-1)
    expect(rootAt).toBeGreaterThan(bootAt)
    expect(indexHtml).toContain('role="status"')
  })

  test('内联脚本早于模块脚本把 data-theme 定下来', () => {
    const inlineAt = indexHtml.indexOf('dataset.theme')
    const moduleAt = indexHtml.indexOf('type="module"')

    // ThemeProvider 要到 React 挂载后才设这个属性；晚于模块脚本的话，
    // 深色模式会先按浅色画一帧（就是那个「启动闪白」）
    expect(inlineAt).toBeGreaterThan(-1)
    expect(moduleAt).toBeGreaterThan(inlineAt)
  })
})

describe('启动占位：撤场逻辑', () => {
  test('重复调用只撤一次，且最终一定摘掉节点', async () => {
    vi.useFakeTimers()

    const attributes: Array<[string, string]> = []
    const removed: string[] = []
    const listeners: Record<string, () => void> = {}

    // 最小的 DOM 替身：只提供 boot-splash.ts 真正会碰到的那几个成员
    const fakeSplash = {
      remove: () => removed.push('boot'),
      addEventListener: (name: string, listener: () => void) => {
        listeners[name] = listener
      }
    }

    vi.stubGlobal('document', {
      getElementById: () => fakeSplash,
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.push([name, value])
      }
    })
    vi.stubGlobal('window', {
      setTimeout: (handler: () => void) => setTimeout(handler, 0)
    })

    const { dismissBootSplash } = await import('./boot-splash')

    // StrictMode 在开发模式下会把 effect 跑两遍，重复调用必须无害
    dismissBootSplash()
    dismissBootSplash()
    expect(attributes).toEqual([['data-boot', 'done']])

    // 兜底路径：transitionend 始终不来时，定时器也要把节点摘掉。
    // 少了这条，一个盖满窗口的 fixed 元素会永远留在无障碍树里
    vi.runAllTimers()
    expect(removed).toEqual(['boot'])

    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
})
