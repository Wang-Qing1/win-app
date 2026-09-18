import { useEffect, useRef, useState } from 'react'
import { proofread, type ProofreadResult } from '@shared/proofread'
import { mapTextRange, type DocText } from './doc-text'
import type { ProofreadMark } from './proofread-extension'

/**
 * 校对结果的计算与位置换算。
 *
 * 两件事在这里合成一步：先把纯文本交给规则引擎（它只认下标），
 * 再把每条结果的位置换算成编辑器文档位置。分两步的好处是规则引擎
 * 完全不依赖富文本库，坏处是位置换算成了必须保证正确的一环 ——
 * 换错的话下划线会标在错误的字上，而用户只会得出「校对不准」的结论。
 *
 * 延迟 320 毫秒：校对是纯 CPU 计算，几十万字的章节扫一遍要几十毫秒。
 * 每敲一个字跑一次会让输入出现可感知的卡顿，而校对结果本来就允许
 * 慢半拍 —— 它不是一个需要跟手的反馈。
 */
const DEBOUNCE_MS = 320

export interface ProofreadState {
  result: ProofreadResult | null
  /** 换算好位置的标记，直接喂给编辑器的高亮扩展 */
  marks: ProofreadMark[]
  /** 是否正在等待下一次计算 */
  pending: boolean
}

const EMPTY_RESULT: ProofreadResult = {
  issues: [],
  categoryCounts: { punctuation: 0, duplicate: 0, mixedScript: 0, pairing: 0, spacing: 0 },
  fillers: [],
  errorCount: 0,
  suggestionCount: 0,
  truncated: false
}

const IDLE_STATE: ProofreadState = { result: null, marks: [], pending: false }

export function useProofread(docText: DocText | null, revision: number): ProofreadState {
  const [state, setState] = useState<ProofreadState>(IDLE_STATE)

  // docText 的引用每次编辑都会变，effect 依赖它就会不断重启计时器 ——
  // 这正是防抖想要的，但要避免把 docText 放进依赖数组导致 lint 抱怨，
  // 因此只用 revision 作为触发信号，从 ref 里取最新文本
  const docTextRef = useRef<DocText | null>(docText)
  docTextRef.current = docText

  useEffect(() => {
    const current = docTextRef.current
    if (current === null) {
      setState(IDLE_STATE)
      return
    }

    setState((previous) => (previous.pending ? previous : { ...previous, pending: true }))

    const timer = window.setTimeout(() => {
      const result = proofread(current.text)
      const marks: ProofreadMark[] = []

      for (const issue of result.issues) {
        const range = mapTextRange(current, issue.start, issue.end)
        if (range) marks.push({ from: range.from, to: range.to, severity: issue.severity })
      }

      setState({ result, marks, pending: false })
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [revision])

  return state
}

export const EMPTY_PROOFREAD_RESULT = EMPTY_RESULT
