/**
 * 大纲页的界面偏好。
 *
 * 只存「上次在看哪本书」——大纲是围绕某本书展开的，
 * 每次进来都要重新选一遍很烦。放 localStorage 而不是数据库：
 * 这纯属「这台机器上的人的习惯」，与稿子本身无关，
 * 换台机器重新选一次完全合理。
 */
const STORAGE_KEY = 'wapp:outline:bookId'

/** 读取失败一律当作「没选过」：localStorage 在隐私模式或异常环境下会抛错 */
export function readOutlineBookId(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null || raw.length === 0) return null
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export function writeOutlineBookId(bookId: number | null): void {
  try {
    if (bookId === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, String(bookId))
  } catch {
    // 存不下就算了，不影响功能
  }
}
