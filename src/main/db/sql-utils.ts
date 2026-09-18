/**
 * SQL 辅助函数。
 *
 * 放在这里而不是各仓储内部各写一份：LIKE 的转义规则一旦有一处漏掉，
 * 表现是「搜 `%` 时返回了全部记录」这种不明显、但很难查的 bug。
 */

/**
 * 转义 LIKE 模式里的通配符。
 *
 * 必须与 `LIKE ... ESCAPE '\'` 配合使用。不转义的话，用户搜索 `100%`
 * 会变成「以 100 开头的任意内容」，搜索 `_` 会变成「任意一个字符」——
 * 结果看起来「能搜到东西」，所以这种 bug 通常很久才被发现。
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** 把用户输入包装成「包含」模式的 LIKE 参数 */
export function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`
}

/** JSON 列的安全解析：内容坏掉时退回默认值，不让一行脏数据把整个列表打挂 */
export function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** SQLite 的 COALESCE(SUM(...), 0) 在没有任何行时会返回 0，但类型上仍是 number | null */
export function toNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
