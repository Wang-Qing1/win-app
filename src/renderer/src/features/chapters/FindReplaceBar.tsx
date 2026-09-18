import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Flex, Input, Switch, Typography } from 'antd'
import { CloseOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import type { Editor } from '@tiptap/react'
import { findTextRanges, mapTextRange, type DocText } from './doc-text'

const { Text } = Typography

interface FindReplaceBarProps {
  editor: Editor | null
  docText: DocText | null
  onClose: () => void
}

interface Match {
  start: number
  end: number
  from: number
  to: number
}

/**
 * 查找替换。
 *
 * 在纯文本上找匹配、再把位置换算回文档——沿用与校对完全相同的坐标系。
 * 这条一致性很重要：如果查找走 TipTap 的原文搜索、校对走纯文本搜索，
 * 同一处「第 3 个匹配」在两个功能里会指向不同的位置，作者会觉得软件精神分裂。
 *
 * 替换一律通过 `tr.insertText` 写入，而不是 `insertContent`：后者会把
 * 字符串当 HTML 解析，于是用户在替换框里输入「<b>」就会被解析成标签，
 * 正文里凭空多出一个加粗，甚至吃掉后面的内容。insertText 走的是纯文本路径。
 */
export function FindReplaceBar({ editor, docText, onClose }: FindReplaceBarProps) {
  const [needle, setNeedle] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [cursor, setCursor] = useState(0)

  const matches = useMemo<Match[]>(() => {
    if (!editor || !docText || needle.length === 0) return []
    return locateMatches(editor, docText, needle, caseSensitive)
  }, [editor, docText, needle, caseSensitive])

  // 检索词变化后游标必须归零，否则新结果集里会指向一个不存在的位置
  useEffect(() => {
    setCursor(0)
  }, [needle, caseSensitive])

  const reveal = useCallback(
    (index: number): void => {
      const match = matches[index]
      if (!editor || !match) return
      editor.chain().focus().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run()
      setCursor(index)
    },
    [editor, matches]
  )

  const step = useCallback(
    (delta: number): void => {
      if (matches.length === 0) return
      const next = (cursor + delta + matches.length) % matches.length
      reveal(next)
    },
    [cursor, matches.length, reveal]
  )

  const replaceCurrent = useCallback((): void => {
    const match = matches[cursor]
    if (!editor || !match) return
    // 用事务直接替换：content_html 里不该出现由查找替换引入的任何标记
    editor.view.dispatch(editor.state.tr.insertText(replacement, match.from, match.to))
    editor.commands.focus()
  }, [cursor, editor, matches, replacement])

  /**
   * 全部替换：倒序应用。
   *
   * 必须倒序。正序替换时，前一次替换改变了文本长度，后面所有位置就都偏了；
   * 倒序从文档末尾往前改，前面尚未处理的位置不受影响。
   */
  const replaceAll = useCallback((): void => {
    if (!editor || matches.length === 0) return
    let tr = editor.state.tr
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index]
      tr = tr.insertText(replacement, match.from, match.to)
    }
    editor.view.dispatch(tr)
    editor.commands.focus()
  }, [editor, matches, replacement])

  return (
    <div className="find-bar" data-testid="find-replace-bar">
      <Flex align="center" gap={8} wrap>
        <Input
          size="small"
          autoFocus
          allowClear
          className="find-bar__input"
          placeholder="查找"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
          onPressEnter={() => step(1)}
        />
        <Text type="secondary" className="find-bar__count">
          {needle.length === 0
            ? '—'
            : matches.length === 0
              ? '无匹配'
              : `${cursor + 1}/${matches.length}`}
        </Text>

        <Button
          size="small"
          type="text"
          icon={<UpOutlined />}
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        />
        <Button
          size="small"
          type="text"
          icon={<DownOutlined />}
          disabled={matches.length === 0}
          onClick={() => step(1)}
        />

        <Input
          size="small"
          allowClear
          className="find-bar__input"
          placeholder="替换为"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <Button size="small" disabled={matches.length === 0} onClick={replaceCurrent}>
          替换
        </Button>
        <Button size="small" disabled={matches.length === 0} onClick={replaceAll}>
          全部替换
        </Button>

        <Flex align="center" gap={4}>
          <Text type="secondary" className="find-bar__label">
            区分大小写
          </Text>
          <Switch size="small" checked={caseSensitive} onChange={setCaseSensitive} />
        </Flex>

        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
      </Flex>
    </div>
  )
}

/**
 * 找出全部匹配并换算成文档位置。
 *
 * 查找本身委托给 `findTextRanges`（与「从全库检索跳过来定位」共用同一份
 * 实现，见 doc-text.ts 的说明）；这里只负责把纯文本区间换算成文档位置，
 * 并丢掉换算失败或越界的那些 —— 文档刚被整体替换时会出现这种区间。
 */
function locateMatches(
  editor: Editor,
  docText: DocText,
  needle: string,
  caseSensitive: boolean
): Match[] {
  const size = editor.state.doc.content.size
  const result: Match[] = []

  for (const range of findTextRanges(docText.text, needle, caseSensitive)) {
    const mapped = mapTextRange(docText, range.start, range.end)
    if (mapped && mapped.from >= 0 && mapped.to <= size) {
      result.push({ start: range.start, end: range.end, from: mapped.from, to: mapped.to })
    }
  }

  return result
}
