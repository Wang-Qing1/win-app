/**
 * 本地日期工具。
 *
 * 为什么不用 `toISOString().slice(0, 10)`：那是 UTC 日期。对东八区用户来说，
 * 早上 8 点之前写的字会被算到前一天——「今日字数」在早鸟用户那里会长期是错的，
 * 而且只在特定时段复现，很难排查。
 *
 * 统一约定：凡是「哪一天」的判断一律走本文件，且与 SQL 侧的
 * `date(started_at, 'localtime')` 保持同一口径。
 */

/** 把毫秒数补零到两位 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地时区下的 YYYY-MM-DD */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** ISO 时间戳对应的本地日期键 */
export function localDateKeyOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : localDateKey(date)
}

/** 今天的本地日期键 */
export function todayKey(now: Date = new Date()): string {
  return localDateKey(now)
}

/**
 * 加减天数。
 * 用 setDate 而不是「减 86400000 毫秒」：后者在夏令时切换那天会偏一小时，
 * 跨过午夜时就可能算错一天。
 */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

/** 本地当天零点 */
export function startOfLocalDay(date: Date): Date {
  const next = new Date(date.getTime())
  next.setHours(0, 0, 0, 0)
  return next
}

/** 本地当天 23:59:59.999 */
export function endOfLocalDay(date: Date): Date {
  const next = new Date(date.getTime())
  next.setHours(23, 59, 59, 999)
  return next
}

/**
 * 生成从 from 到 to（含两端）的连续日期键。
 *
 * 趋势图与热力日历需要「没有写作的日子也占一格」——SQL 的 GROUP BY 只会
 * 返回有记录的那些天，直接画图会出现日期跳空、曲线被压缩。补零由调用方
 * 用这个函数完成，不在 SQL 里造一张日历表。
 */
export function eachDayKey(fromExclusive: Date, toInclusive: Date, maxDays = 400): string[] {
  const keys: string[] = []
  let cursor = addDays(startOfLocalDay(fromExclusive), 1)
  const end = startOfLocalDay(toInclusive)

  while (cursor.getTime() <= end.getTime() && keys.length < maxDays) {
    keys.push(localDateKey(cursor))
    cursor = addDays(cursor, 1)
  }

  return keys
}

/** 计算连续写作天数：从今天（或昨天）往前数，直到某天没有记录 */
export function computeStreak(activeDayKeys: ReadonlySet<string>, now: Date = new Date()): number {
  if (activeDayKeys.size === 0) return 0

  const today = startOfLocalDay(now)
  // 今天还没写不算断档——凌晨打开应用时不该把连续记录清零。
  // 所以起点是「今天写了就是今天，否则回溯到昨天」。
  const anchor = activeDayKeys.has(localDateKey(today)) ? today : addDays(today, -1)

  let streak = 0
  let cursor = anchor
  while (activeDayKeys.has(localDateKey(cursor))) {
    streak += 1
    cursor = addDays(cursor, -1)
  }

  return streak
}
