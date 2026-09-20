import { EditOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router'
import { IconButton } from './IconButton'

/**
 * 「临时外出」的返回按钮 —— 右下角那枚悬浮圆钮的第二枚。
 *
 * 场景：写作时点右侧竖栏的「大纲」/「角色」，会离开编辑器去看参考资料，
 * 看完要**回到刚才那一章继续写**。它是一次**外出**，不是一次导航 ——
 * 用户的心里还停在那一章上。
 *
 * 为什么必须显式给一个入口：
 * 跳转前编辑器占满整个路由，跳走后它就**整个不存在了**，只剩顶栏那枚
 * 「返回首页」。而「回到首页」和「回到我正在写的那一章」是两件事 ——
 * 前者要作者自己再从书架点进去、再找到刚才那一章，等于把人赶出写作现场。
 * 用户 2026-09-20 的原话是「跳转界面之后就回不来了」。
 *
 * 为什么放在应用外壳（而不是大纲页 / 卡片页各摆一个）：
 * 和「返回首页」同一条理由 —— 能当来源的页面将来不止两个，每个页面各写
 * 一遍必然有漏掉的，漏掉的那个就是死胡同。顶栏是唯一「所有页面都经过」
 * 的地方。
 *
 * 来源怎么带：跳转方在 URL 上写 `?from=<原路径>`。
 * 用 **query 而不是 `location.state`**：state 只在内存里，刷新窗口就没了，
 * 而「外出查资料」恰恰是最容易被窗口刷新打断的场景（改设置、重启应用）。
 * 写在 URL 里还有一个好处：它是**可见的**，调试时一眼看得出「这一屏是从哪来的」。
 *
 * `from` 只在**来源那一屏**有效：目标页内再做任何导航都会把它丢掉，
 * 返回按钮随之消失。这是刻意的 —— 已经在目标页里转了几步之后，
 * 「回到那一章」不再是用户想做的事，摆一个按钮只是噪音。
 */

/** 来源参数的键。跳转方与这里必须一致，所以定义成常量导出 */
export const FROM_PARAM = 'from'

/** 拼出带来源的目标路径。跳转方一律用它，别手拼 `?from=` */
export function withOrigin(path: string, from: string): string {
  /*
   * 目标路径可能自己带着查询串（竖栏「设定」是 `/cards?type=setting&book=3`），
   * 这时第二个参数必须用 `&` 接 —— 再写一个 `?` 会拼出
   * `?type=setting?from=…`，浏览器会把 from 当成 type 的一部分，
   * 于是「回程票」静默消失。
   */
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${FROM_PARAM}=${encodeURIComponent(from)}`
}

/** 章节编辑器路由（含「打开一本书但还没定位到章节」那一种） */
const EDITOR_ROUTE = /^\/books\/\d+(\/chapters\/\d+)?$/

export function OriginReturn(): React.JSX.Element | null {
  const [params] = useSearchParams()
  const navigate = useNavigate()

  const from = params.get(FROM_PARAM)
  /*
   * 只认站内绝对路径：这是一个会被拼进路由的字符串，
   * 放任 `javascript:` 之类进来就是在给导航挖坑。
   */
  if (from === null || !from.startsWith('/')) return null

  const label = EDITOR_ROUTE.test(from) ? '返回正文编辑' : '返回上一处'

  return (
    <IconButton
      large
      className="app-icon-button--floating app-icon-button--floating-return"
      label={label}
      icon={<EditOutlined />}
      data-testid="return-to-origin"
      tipTestId="return-to-origin-tip"
      onClick={() => void navigate(from)}
    />
  )
}
