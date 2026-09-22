/**
 * 段落级的差异对比。
 *
 * 为什么不做字符级 LCS：正文段落是作者的天然编辑单位（他删的是「那一段」，
 * 不是「第 3712 个字符」）；而字符级在两版各几十万字的正文上会是
 * O(n·m) 的数亿次比较，界面必然卡死 —— 代价与收益不成比例。
 *
 * 为什么可以整段相等地比对而不是先算哈希：段落数在几千级，
 * 逐段字符串比较完全够快，而哈希还要处理碰撞与相等长度不同内容的情况。
 */

export type DiffKind = 'same' | 'changed' | 'removed' | 'added'

export interface DiffRow {
  /** 旧版（历史版本）这一行的内容，null 表示这一行只在现在的正文里 */
  old: string | null
  /** 现在正文这一行的内容，null 表示这一行只在历史版本里（已被删掉） */
  new: string | null
  kind: DiffKind
}

/**
 * 把两段纯文本按段落对齐。
 *
 * 用的是 LCS（最长公共子序列）的标准滚动数组实现，只是把比较单位
 * 从字符换成段落。段落级下 n、m 都在几千以内，O(n·m) 是可接受的。
 *
 * 对齐结果的含义：
 *   - 段落同时出现在两边且顺序一致 → same
 *   - 两边的段落集合相同、只是位置挪了 → 仍按 LCS 拆成 removed + added，
 *     因为「挪动」在正文里本来就是「这里删了、那里加了」，作者看得懂
 *   - 一边空、另一边有内容 → added / removed
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function diffParagraphs(oldText: string, newText: string): DiffRow[] {
  const oldLines = splitParagraphs(oldText)
  const newLines = splitParagraphs(newText)

  // 两版段落数相乘的上限。超过就退化成「整块替换」——
  // 与其让界面卡住，不如给一个粗但对的结果
  const MAX_CELLS = 4_000_000

  if (oldLines.length * newLines.length > MAX_CELLS) {
    return [...oldLines.map((line) => ({ old: line, new: null, kind: 'removed' as const })),
      ...newLines.map((line) => ({ old: null, new: line, kind: 'added' as const }))]
  }

  const n = oldLines.length
  const m = newLines.length

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0

  /*
   * 回溯。每轮把「连续的删除」与「连续的插入」各攒成一个批次，再把两批
   * 配对成行 —— 界面上是左右并排，行数不等就会错位，读者对不上哪一行
   * 对应哪一行。配对时较短的一侧填 null，由 CSS 画成虚线占位。
   *
   * 判据用的是 dp 表本身：`dp[i+1][j] >= dp[i][j+1]` 说明「吃掉一个旧段落」
   * 不会让公共子序列变短，该删；否则该增。取等时先删，以保证同样输入
   * 永远得到同样输出。
   *
   * **配对成 changed 之前要先比内容**。LCS 在「删一段、留一段」这种情形下
   * 并不唯一：`甲/乙/丙 → 甲/丙` 里，保留乙或保留丙都是一条长度相同的最长
   * 公共子序列，dp 表分不出高下，回溯只能任选一边。若不看内容就配对，
   * 被删掉的 `乙` 会被摆到 `丙` 旁边显示成「改写」，读者看到的差异
   * 就变成「乙改成了丙」—— 而真相是「乙被删了」。
   * 这一条正是「误删一大段拿不回来」最需要看清楚的场景，不能答错。
   *
   * 两个 while 里同样**没有** `oldLines[i] === newLines[j]` 这种提前退出：
   * 提前退出会让被删的段落就近配上后面幸存的那段，落进同一个坑里。
   */
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      rows.push({ old: oldLines[i], new: newLines[j], kind: 'same' })
      i += 1
      j += 1
      continue
    }

    const removed: string[] = []
    const added: string[] = []

    while (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      removed.push(oldLines[i])
      i += 1
    }
    while (j < m && (i >= n || dp[i + 1][j] < dp[i][j + 1])) {
      added.push(newLines[j])
      j += 1
    }

    // 两个批次都空是不可能发生的：外层已经排除了相等，此时 i<n 或 j<m
    // 二者必有其一，对应的 while 至少进一次。留个守卫免得将来改判据时死循环
    if (removed.length === 0 && added.length === 0) {
      removed.push(oldLines[i])
      i += 1
    }

    /*
     * 只有**成对且内容不同**的段落才是「改写」，其余一律按纯增 / 纯删。
     *
     * 关键在于不能简单地把两个批次按下标配对：批次里可能同时含
     * 「被删掉的段落」与「改写后的段落」。例如 `甲/乙/丙 → 甲/丙`，
     * 回溯会把 `乙` 与 `丙` 都收进 removed（见上面的说明），此时若按
     * 下标配对，`乙` 就会显示成「改写成丙」。多出来的那些必须老老实实
     * 当作删除 —— 这正是作者要看的「我丢了哪几段」。
     *
     * 配对时从后往前取：批次末尾的段落离下一个 same 最近，最可能是
     * 同一位置被改写的那个。
     */
    const pairCount = Math.min(removed.length, added.length)
    const removedOnly = removed.length - pairCount
    const addedOnly = added.length - pairCount

    for (let k = 0; k < removedOnly; k += 1) {
      rows.push({ old: removed[k], new: null, kind: 'removed' })
    }
    for (let k = 0; k < pairCount; k += 1) {
      const oldLine = removed[removedOnly + k]
      const newLine = added[addedOnly + k]
      rows.push({ old: oldLine, new: newLine, kind: 'changed' })
    }
    for (let k = 0; k < addedOnly; k += 1) {
      rows.push({ old: null, new: added[k], kind: 'added' })
    }
  }

  return rows
}
