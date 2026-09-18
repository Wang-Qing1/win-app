import { useMemo, useState } from 'react'
import { Button, Empty, Flex, Segmented, Skeleton, Tag, Typography } from 'antd'
import {
  FILLER_GROUP_LABELS,
  PROOFREAD_CATEGORIES,
  PROOFREAD_CATEGORY_LABELS,
  summarizeProofread,
  type FillerGroup,
  type ProofreadCategory,
  type ProofreadIssue,
  type ProofreadResult
} from '@shared/proofread'

const { Text, Paragraph } = Typography

/** 片段上下文取多少字。太短看不出问题，太长会把面板撑成正文 */
const CONTEXT_CHARS = 14

interface ProofreadPanelProps {
  result: ProofreadResult | null
  pending: boolean
  text: string
  onJump: (start: number, end: number) => void
}

/**
 * 纠错面板。
 *
 * 展示分两层：顶部一句话结论（「2 处需要修改 · 5 处建议调整」），
 * 下面才是逐条明细。作者打开这个面板的真实诉求是「能不能发出去」，
 * 所以结论必须在第一眼就能看到，而不是让他在一长串列表里自己数。
 *
 * 每条都带上下文而不是只给问题本身：单看「标点重复」四个字，作者
 * 根本不知道去哪儿改；看到「……他说，，你好」才知道是哪一处。
 */
export function ProofreadPanel({ result, pending, text, onJump }: ProofreadPanelProps) {
  const [category, setCategory] = useState<ProofreadCategory | 'all'>('all')

  const issues = result?.issues ?? []
  const visible = useMemo(
    () => (category === 'all' ? issues : issues.filter((issue) => issue.category === category)),
    [issues, category]
  )

  const categoryOptions = useMemo(() => {
    const counts = result?.categoryCounts
    return [
      { label: `全部 ${issues.length}`, value: 'all' as const },
      ...PROOFREAD_CATEGORIES.filter((item) => (counts?.[item] ?? 0) > 0).map((item) => ({
        label: `${PROOFREAD_CATEGORY_LABELS[item]} ${counts?.[item] ?? 0}`,
        value: item
      }))
    ]
  }, [issues.length, result?.categoryCounts])

  if (pending && result === null) {
    return (
      <div className="inspector__body">
        <Skeleton active paragraph={{ rows: 5 }} title={false} />
      </div>
    )
  }

  return (
    <Flex vertical gap={10} className="inspector__body" data-testid="proofread-panel">
      <Flex vertical gap={2}>
        <Text strong>{result ? summarizeProofread(result) : '等待分析'}</Text>
        <Text type="secondary" className="inspector__hint">
          {pending ? '正在重新分析正文…' : '修改后会自动重新检查'}
        </Text>
      </Flex>

      {result?.truncated ? (
        <Text type="secondary" className="inspector__hint">
          问题过多，仅显示前 {issues.length} 条。建议先整体过一遍标点。
        </Text>
      ) : null}

      {issues.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">没有发现标点、配对类问题</Text>}
        />
      ) : (
        <>
          <Segmented
            size="small"
            block
            value={category}
            options={categoryOptions}
            onChange={(value) => setCategory(value as ProofreadCategory | 'all')}
          />

          <div className="issue-list">
            {visible.map((issue) => (
              <IssueRow
                key={`${issue.category}-${issue.start}-${issue.end}`}
                issue={issue}
                text={text}
                onJump={onJump}
              />
            ))}
          </div>
        </>
      )}
    </Flex>
  )
}

function IssueRow({
  issue,
  text,
  onJump
}: {
  issue: ProofreadIssue
  text: string
  onJump: (start: number, end: number) => void
}) {
  const before = text.slice(Math.max(0, issue.start - CONTEXT_CHARS), issue.start)
  const hit = issue.text
  const after = text.slice(issue.end, issue.end + CONTEXT_CHARS)

  return (
    <button
      type="button"
      className={`issue-row issue-row--${issue.severity}`}
      onClick={() => onJump(issue.start, issue.end)}
    >
      <Flex align="center" gap={6} className="issue-row__head">
        <Tag
          className="tag--flush"
          color={issue.severity === 'error' ? 'error' : 'warning'}
        >
          {PROOFREAD_CATEGORY_LABELS[issue.category]}
        </Tag>
        <Text className="issue-row__message">{issue.message}</Text>
      </Flex>
      <Paragraph className="issue-row__context" ellipsis={{ rows: 2 }}>
        {before}
        <span className="issue-row__hit">{hit}</span>
        {after}
      </Paragraph>
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 废字面板
 * ------------------------------------------------------------------ */

interface FillerPanelProps {
  result: ProofreadResult | null
  pending: boolean
  onJump: (start: number, end: number) => void
}

/**
 * 废字面板。
 *
 * 按词聚合而不是按次列出，这一点是关键：一篇文章里「似乎」出现 47 次，
 * 作者需要的信息是「47 次」这个密度本身的警示，而不是 47 条一模一样的
 * 记录。密度才是废字的判断依据。
 *
 * 分组（冗余修饰 / 套话 / 口头禅）给出的是「问题类型」，
 * 让作者知道该往哪个方向删：删修饰、删模板动作、还是换连接词。
 */
export function FillerPanel({ result, pending, onJump }: FillerPanelProps) {
  const fillers = result?.fillers ?? []
  const [group, setGroup] = useState<FillerGroup | 'all'>('all')

  const visible = useMemo(
    () => (group === 'all' ? fillers : fillers.filter((item) => item.group === group)),
    [fillers, group]
  )

  const total = useMemo(() => fillers.reduce((sum, item) => sum + item.count, 0), [fillers])

  const groupOptions = useMemo(() => {
    const counts = new Map<FillerGroup, number>()
    for (const item of fillers) {
      counts.set(item.group, (counts.get(item.group) ?? 0) + item.count)
    }
    return [
      { label: `全部 ${total}`, value: 'all' as const },
      ...[...counts.entries()].map(([key, count]) => ({
        label: `${FILLER_GROUP_LABELS[key]} ${count}`,
        value: key
      }))
    ]
  }, [fillers, total])

  if (pending && result === null) {
    return (
      <div className="inspector__body">
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      </div>
    )
  }

  return (
    <Flex vertical gap={10} className="inspector__body" data-testid="filler-panel">
      <Flex vertical gap={2}>
        <Text strong>
          {fillers.length === 0 ? '没有检测到常见废词' : `${fillers.length} 个废词共出现 ${total} 次`}
        </Text>
        <Text type="secondary" className="inspector__hint">
          废词不是错，但密度过高会让叙述发虚。点条目可跳到正文对应位置。
        </Text>
      </Flex>

      {fillers.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">这段正文很干净</Text>}
        />
      ) : (
        <>
          <Segmented
            size="small"
            block
            value={group}
            options={groupOptions}
            onChange={(value) => setGroup(value as FillerGroup | 'all')}
          />

          <div className="issue-list">
            {visible.map((item) => (
              <div key={item.word} className="filler-row">
                <Flex align="center" justify="space-between" gap={8}>
                  <Flex align="center" gap={6}>
                    <Text strong className="filler-row__word">
                      {item.word}
                    </Text>
                    <Tag className="tag--flush">{FILLER_GROUP_LABELS[item.group]}</Tag>
                  </Flex>
                  <Flex align="center" gap={6}>
                    <Text type="secondary" className="filler-row__count">
                      {item.count} 次
                    </Text>
                    <Button
                      size="small"
                      type="link"
                      onClick={() => onJump(item.firstIndex, item.firstIndex + item.word.length)}
                    >
                      定位
                    </Button>
                  </Flex>
                </Flex>
                <Text type="secondary" className="filler-row__note">
                  {item.note}
                </Text>
              </div>
            ))}
          </div>
        </>
      )}
    </Flex>
  )
}
