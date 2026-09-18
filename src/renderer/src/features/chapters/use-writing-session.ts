import { useCallback, useEffect, useRef } from 'react'
import type { SessionFinishInput } from '@shared/modules/sessions'
import { useFinishSession } from '../stats/use-stats'

/**
 * 写作会话采集。
 *
 * 这是整个统计功能的**唯一数据来源**：统计页的每一个数字，最终都来自
 * 这里落下的 writing_sessions 记录。所以它必须满足三个性质：
 *
 *   1. 不丢：离开编辑器、窗口关闭、空闲超时，三个时机都要结算；
 *   2. 不重：同一个会话只能落一条记录（结算后立刻清空状态）；
 *   3. 不假：startWords 必须取自章节加载完成后的真实字数，而不是 0 ——
 *      否则每次打开老章节都会被记成「写了三万字」。
 *
 * 空闲阈值取 90 秒：写作过程中「想词」停顿几十秒很常见，阈值太短会把
 * 一段连续的写作切成一堆碎片会话；而超过一分半还没敲键盘通常意味着
 * 人已经离开。结算后立即开启新会话，回来继续写仍然被统计。
 */

/** 空闲多久算一段写作结束 */
const IDLE_TIMEOUT_MS = 90_000

/**
 * 太短的会话不落库。
 *
 * 「点开章节看了一眼就退出」会留下一条 3 秒、0 字的记录。这类噪音有两个
 * 危害：把「日均写作时长」拉低到一个没有意义的数字；让热力图出现
 * 「明明没写但那天有记录」的格子。因此加一道闸：既没写字、又没停留够
 * 一分钟，就不记录。
 */
const MIN_DURATION_SECONDS = 60

interface SessionState {
  bookId: number
  chapterId: number
  startedAt: number
  startWords: number
  /** 最近一次观测到的字数，可能是删字之后的值 */
  lastWords: number
  /** 会话过程中的最高字数，用于算「写作量」 */
  peakWords: number
}

export interface WritingSessionReporter {
  /** 每次正文变化时上报当前汉字数，用于更新峰值并重置空闲计时 */
  reportWords: (words: number) => void
  /** 立即结算当前会话（离开编辑器时由页面主动调用） */
  settle: () => void
}

export function useWritingSession(
  bookId: number | null,
  chapterId: number | null,
  startWords: number | null
): WritingSessionReporter {
  const { mutate } = useFinishSession()

  // mutate 的引用不保证跨渲染稳定，用 ref 存最新的一份，
  // 这样下面的结算回调可以做到零依赖、引用永远稳定
  const mutateRef = useRef(mutate)
  mutateRef.current = mutate

  const stateRef = useRef<SessionState | null>(null)
  const idleTimerRef = useRef<number | null>(null)

  const clearIdleTimer = useCallback((): void => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  /**
   * 两个互相引用的回调（结算需要重启计时，计时到期需要触发结算）
   * 通过 ref 转发，避免「先声明谁」的死结 —— 用函数声明虽然能靠提升绕开，
   * 但每次渲染都会产生新引用，会让依赖这两个回调的 effect 反复重跑，
   * 表现是会话被不停切断，统计时长碎成一地。
   */
  const scheduleIdleRef = useRef<() => void>(() => {})
  const settleRef = useRef<(restart: boolean) => void>(() => {})

  /** 结算当前会话；restart 为 true 时立刻开启下一段 */
  const settle = useCallback(
    (restart: boolean): void => {
      const state = stateRef.current
      stateRef.current = null
      clearIdleTimer()
      if (!state) return

      const endedAt = Date.now()
      const durationSeconds = Math.max(0, Math.round((endedAt - state.startedAt) / 1000))
      const wroteSomething = state.peakWords > state.startWords

      if (wroteSomething || durationSeconds >= MIN_DURATION_SECONDS) {
        const input: SessionFinishInput = {
          bookId: state.bookId,
          chapterId: state.chapterId,
          startedAt: new Date(state.startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationSeconds,
          startWords: state.startWords,
          endWords: state.lastWords,
          peakWords: state.peakWords
        }
        mutateRef.current(input)
      }

      if (restart) {
        // 新会话的起点是「上一段结束时的字数」，而不是峰值 ——
        // 否则上一段写进去又删掉的字会被重复计入下一段的写作量
        stateRef.current = {
          ...state,
          startedAt: endedAt,
          startWords: state.lastWords,
          peakWords: state.lastWords
        }
        scheduleIdleRef.current()
      }
    },
    [clearIdleTimer]
  )

  const scheduleIdle = useCallback((): void => {
    clearIdleTimer()
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null
      settleRef.current(true)
    }, IDLE_TIMEOUT_MS)
  }, [clearIdleTimer])

  settleRef.current = settle
  scheduleIdleRef.current = scheduleIdle

  const reportWords = useCallback(
    (words: number): void => {
      const state = stateRef.current
      if (!state) return
      state.lastWords = words
      if (words > state.peakWords) state.peakWords = words
      scheduleIdle()
    },
    [scheduleIdle]
  )

  // 会话生命周期严格绑定在「章节已加载完成」这一刻：
  // startWords 为 null 表示详情还没回来，此时开表会把起始字数记成 0
  useEffect(() => {
    if (bookId === null || chapterId === null || startWords === null) return

    stateRef.current = {
      bookId,
      chapterId,
      startedAt: Date.now(),
      startWords,
      lastWords: startWords,
      peakWords: startWords
    }
    scheduleIdle()

    return () => {
      // 卸载不重启：人已经离开这一章了
      settleRef.current(false)
    }
  }, [bookId, chapterId, startWords, scheduleIdle])

  // 关窗口/刷新时补一次结算。IPC 不一定来得及跑完，但这是最后一根保险 ——
  // 正常情况下路由卸载时已经结算过了
  useEffect(() => {
    const handler = (): void => settleRef.current(false)
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const settleNow = useCallback((): void => settleRef.current(false), [])

  return { reportWords, settle: settleNow }
}
