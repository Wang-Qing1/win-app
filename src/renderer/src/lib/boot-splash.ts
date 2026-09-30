/**
 * 启动占位（boot splash）的撤场。
 *
 * 占位本身的 HTML/CSS 在 `src/renderer/index.html` 里 —— 它必须早于 bundle
 * 存在，所以不能由这里生成。这里只负责「什么时候、怎么把它拿掉」。
 *
 * 为什么撤场时机交给 App 的 effect，而不是在 `main.tsx` 里跟一句
 * `requestAnimationFrame`：`createRoot().render()` 只是把工作**排队**，
 * 返回时 DOM 还没提交。靠 raf 猜一帧在快机器上碰巧对、在慢机器上会猜早，
 * 于是出现「占位淡出了、底下还是空白」—— 比不加占位更糟。
 * `useEffect` 的时机是确定的（DOM 已提交、浏览器还未绘制），没有这个随机性。
 */

const SPLASH_ID = 'boot'
const DONE_ATTRIBUTE = 'data-boot'
const DONE_VALUE = 'done'

/** 淡出用的 CSS 过渡是 180ms，留一倍余量兜底 */
const REMOVE_FALLBACK_MS = 500

let dismissed = false

/**
 * 撤掉启动占位。可以重复调用（StrictMode 在开发模式下会把 effect 跑两遍）。
 *
 * 分两步而不是直接 `remove()`：先打标记让 CSS 过渡把 opacity 归零，
 * 过渡结束后再摘节点。直接摘会「啪」地消失，在启动本来就慢的机器上很突兀。
 */
export function dismissBootSplash(): void {
  if (dismissed) return
  dismissed = true

  const splash = document.getElementById(SPLASH_ID)
  if (!splash) return

  document.documentElement.setAttribute(DONE_ATTRIBUTE, DONE_VALUE)

  // 摘掉节点而不是只让它透明：留着一个盖满窗口的 fixed 元素，
  // 就算 pointer-events 已经是 none，它也仍在无障碍树里、仍参与布局
  splash.addEventListener('transitionend', () => splash.remove(), { once: true })

  // 兜底：过渡没跑起来时（prefers-reduced-motion、标签页在后台被节流）
  // transitionend 可能永远不来，这里硬摘一次
  window.setTimeout(() => splash.remove(), REMOVE_FALLBACK_MS)
}
