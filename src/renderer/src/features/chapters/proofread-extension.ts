import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { ProofreadSeverity } from '@shared/proofread'

/**
 * 校对高亮装饰。
 *
 * 用 ProseMirror 的**装饰**（decoration）而不是自定义 mark 来画下划线，
 * 这一点是有意为之：装饰只存在于视图层，不进入文档模型。如果把它做成
 * mark，那每个被标出的问题都会被写进 content_html —— 用户保存一次正文，
 * 数据库里就多出一堆 `<span class="proofread">`，导出给平台时还要再剥一遍。
 * 校对结果本来就是「此刻的看法」，不该污染作品本身。
 *
 * 插件的 decorations 回调在每次视图更新时被调用，因此标记变化后需要让
 * 视图重绘一次 —— 调用方通过派发一个空事务来触发，见 use-proofread 的说明。
 */

export interface ProofreadMark {
  from: number
  to: number
  severity: ProofreadSeverity
}

export const PROOFREAD_PLUGIN_KEY = new PluginKey<DecorationSet>('wappProofreadHighlight')

export interface ProofreadHighlightOptions {
  /** 每次重绘时现取标记。用回调而不是数组，避免扩展在创建时把标记固化下来 */
  getMarks: () => readonly ProofreadMark[]
}

export const ProofreadHighlight = Extension.create<ProofreadHighlightOptions>({
  name: 'wappProofreadHighlight',

  addOptions() {
    return { getMarks: () => [] }
  },

  addProseMirrorPlugins() {
    const getMarks = this.options.getMarks

    return [
      new Plugin({
        key: PROOFREAD_PLUGIN_KEY,
        props: {
          decorations(state) {
            const marks = getMarks()
            if (marks.length === 0) return DecorationSet.empty

            const size = state.doc.content.size
            const decorations: Decoration[] = []

            for (const mark of marks) {
              // 文档可能刚被替换（切换章节、撤销），越界的位置会让
              // DecorationSet 直接抛错并把整个编辑器白屏，因此必须夹紧
              const from = clamp(mark.from, 0, size)
              const to = clamp(mark.to, 0, size)
              if (to <= from) continue

              decorations.push(
                Decoration.inline(from, to, {
                  class: `proofread-mark proofread-mark--${mark.severity}`
                })
              )
            }

            return DecorationSet.create(state.doc, decorations)
          }
        }
      })
    ]
  }
})

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
