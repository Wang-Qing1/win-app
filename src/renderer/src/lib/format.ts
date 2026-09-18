const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

export function formatDateTime(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date)
}

export function formatDate(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date)
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'

  const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (diffSeconds < 60) return '刚刚'
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} 小时前`
  if (diffSeconds < 86400 * 30) return `${Math.floor(diffSeconds / 86400)} 天前`
  return formatDate(iso)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  // 中文取末字（姓氏在后不利于辨识），西文取首字母
  const isAscii = /^[\x20-\x7f]+$/.test(trimmed)
  if (isAscii) {
    const parts = trimmed.split(/\s+/).filter(Boolean)
    return parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  }
  return trimmed.slice(-1)
}

/* ------------------------------------------------------------------ *
 * 字数与数量的展示格式
 *
 * 刻意分成三个函数而不是一个带参数的万能函数：调用点直接写出意图
 * （「这里要精确数字」还是「这里要紧凑显示」），读代码时不用回查参数含义。
 * ------------------------------------------------------------------ */

/** 精确计数，带千分位：1,240。用于指标卡与详情页 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('zh-CN')
}

/**
 * 紧凑中文计数：128430 → 12.8 万。
 *
 * 超过一万就换算：写作者讨论进度时说的就是「十几万字」，
 * 摆在指标卡上的 128,430 反而不如 12.8 万 一眼可读。
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 10_000) return formatCount(value)
  const wan = value / 10_000
  // 一万到十万之间保留一位小数（12.8 万），十万以上取整（128 万）
  if (wan < 100) return `${wan.toFixed(1).replace(/\.0$/, '')} 万`
  return `${Math.round(wan)} 万`
}

/** 时长：秒 → 「2 小时 15 分」。用于累计写作时长 */
export function formatHours(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 小时'
  const hours = totalSeconds / 3600
  if (hours < 1) return `${Math.max(1, Math.round(totalSeconds / 60))} 分钟`
  if (hours < 100) return `${hours.toFixed(1).replace(/\.0$/, '')} 小时`
  return `${Math.round(hours)} 小时`
}

/** 短时长：秒 → 「52 分钟」。用于今日时长这类小数字 */
export function formatMinutes(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 分钟'
  if (totalSeconds < 60) return `${Math.round(totalSeconds)} 秒`
  const minutes = totalSeconds / 60
  if (minutes < 60) return `${Math.round(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

/**
 * 带正负号的百分比变化。
 * 返回 null 表示无法计算（基数为 0），由调用方决定显示什么 ——
 * 显示「+∞%」或「+100%」都是在撒谎。
 */
export function formatDelta(current: number, previous: number): string | null {
  if (previous <= 0) return null
  const ratio = (current - previous) / previous
  const percent = Math.round(ratio * 100)
  if (!Number.isFinite(percent)) return null
  if (percent === 0) return '持平'
  return `${percent > 0 ? '+' : ''}${percent}%`
}

/** 进度百分比，0–100 的整数。目标为 0 时返回 null（不设目标就不该显示进度） */
export function progressPercent(done: number, target: number): number | null {
  if (target <= 0) return null
  return Math.min(100, Math.round((done / target) * 100))
}
