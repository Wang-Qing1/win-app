import { useMemo, useState } from 'react'
import { Card, Empty, Flex, Popconfirm, Segmented, Skeleton, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, UndoOutlined } from '@ant-design/icons'
import {
  TRASH_KIND_LABELS,
  type TrashItem,
  type TrashKind
} from '@shared/modules/trash'
import { CARD_TYPE_LABELS } from '@shared/modules/cards'
import { ErrorAlert } from '../../components/ErrorAlert'
import { IconButton } from '../../components/IconButton'
import { PageHeader } from '../../components/PageHeader'
import { useConfirm, useToast } from '../../components/Toast'
import { toUserMessage } from '../../lib/api-client'
import { formatCount, formatDateTime, formatRelativeTime } from '../../lib/format'
import { useEmptyTrash, usePurgeTrash, useRestoreTrash, useTrashList } from './use-trash'

const { Text } = Typography

/** 筛选值用空串表示「全部」，与 Segmented 的取值习惯一致（它不接受 null） */
const ALL = ''

/**
 * 回收站页（第三期第 5 件）。
 *
 * 一句产品定位：**这里不是「删除记录」，是「后悔药」**。
 * 因此界面上每一行的主操作是「恢复」而不是「彻底删除」——后者要做成
 * 带二次确认的危险动作，且绝不能是视觉上最显眼的那个。
 *
 * 三处刻意的设计：
 *
 *  1. **两种实体混排，按删除时间倒序**。作者找的是「我刚才手滑删掉的那个」，
 *     未必记得它是卡片还是章节；分成两个列表就意味着他要先猜一下去哪边找。
 *     类型只作为一个标签出现在行首，不用来分栏。
 *     筛选页签上的数字是**全局计数**（不受当前筛选影响），切到「章节」时
 *     「卡片」那格不会变成 0 —— 那读起来像「卡片被删光了」。
 *
 *  2. **每行显示「删于 3 分钟前」与删除前的字数**。回收站里的东西
 *     按定义是「作者已经忘记内容」的，只剩标题时很难判断该不该捞回来；
 *     字数是章节最好认的特征（卡片没有，显示 0 字那一栏直接省略）。
 *
 *  3. **截断时明说**。列表上限 500 条，超出时顶部告诉用户
 *     「仅显示最近的 500 条，共 N 条」——静默截断在回收站里是最糟的，
 *     它会让人以为「只剩下这些了」，从而不敢清空。
 */
export function TrashPage() {
  const [kind, setKind] = useState<string>(ALL)
  const [pending, setPending] = useState<string | null>(null)

  const list = useTrashList(kind)
  const restore = useRestoreTrash()
  const purge = usePurgeTrash()
  const empty = useEmptyTrash()
  const { notifySuccess, notifyError } = useToast()
  const confirm = useConfirm()

  const items = list.data?.items ?? []
  const counts = list.data?.kindCounts
  const total = list.data?.total ?? 0

  const options = useMemo(
    () => [
      { value: ALL, label: `全部 ${counts ? counts.card + counts.chapter : 0}` },
      { value: 'card', label: `${TRASH_KIND_LABELS.card} ${counts?.card ?? 0}` },
      { value: 'chapter', label: `${TRASH_KIND_LABELS.chapter} ${counts?.chapter ?? 0}` }
    ],
    [counts]
  )

  /** 行的稳定标识。两张表的 id 各自自增，因此必须带上 kind */
  const keyOf = (item: TrashItem): string => `${item.kind}-${item.id}`

  const handleRestore = (item: TrashItem): void => {
    setPending(keyOf(item))
    restore
      .mutateAsync({ kind: item.kind, id: item.id })
      .then(() => notifySuccess(`「${item.title}」已恢复`))
      .catch((error: unknown) => notifyError(toUserMessage(error)))
      .finally(() => setPending(null))
  }

  const handlePurge = (item: TrashItem): void => {
    setPending(keyOf(item))
    purge
      .mutateAsync({ kind: item.kind, id: item.id })
      .then(() => notifySuccess(`「${item.title}」已彻底删除`))
      .catch((error: unknown) => notifyError(toUserMessage(error)))
      .finally(() => setPending(null))
  }

  const handleEmpty = (): void => {
    const scope = kind === ALL ? '' : `（只清空${TRASH_KIND_LABELS[kind as TrashKind]}）`
    void confirm({
      title: `清空回收站${scope}？`,
      // 这是整个应用里唯一真正不可撤销的操作，文案必须把这一点说透
      description: `这 ${total} 条会被永久删除，无法再恢复；卡片上的关联与章节的历史版本也会一并消失。`,
      okText: '彻底删除',
      danger: true
    }).then((ok) => {
      if (!ok) return
      empty
        .mutateAsync({ kind: kind === ALL ? null : (kind as TrashKind) })
        .then((result) => notifySuccess(`已彻底删除 ${result.removed} 条`))
        .catch((error: unknown) => notifyError(toUserMessage(error)))
    })
  }

  const loading = list.isPending && list.data === undefined

  return (
    <Flex vertical gap={16} className="page">
      <PageHeader
        title="回收站"
        extra={
          <>
            <div data-testid="trash-filter">
              <Segmented
                options={options}
                value={kind}
                onChange={(value) => setKind(String(value))}
              />
            </div>
            {/*
              按全应用的规矩做成 32px 正圆图标按钮，文字移进悬浮提示
              （用户 2026-09-22：「回收站界面的按钮要修正为图标 + 鼠标悬浮
              提示信息的展示样式」）。这一枚在页头，与同排的 `Segmented`
              都是 32px —— 规格分档的理由见 IconButton 顶部那段注释。

              「不可恢复」这半句话必须留在提示里：这一页的每一行都能恢复，
              唯独这一枚不能，而它长得跟行内的「彻底删除」是同一个图标。
            */}
            <IconButton
              tone="danger"
              label="清空回收站（永久删除，不可恢复）"
              icon={<DeleteOutlined />}
              disabled={total === 0 || empty.isPending}
              onClick={handleEmpty}
              data-testid="trash-empty"
              tipTestId="trash-empty-tip"
            />
          </>
        }
      />

      {list.error ? (
        <ErrorAlert error={list.error} title="回收站加载失败" onRetry={() => void list.refetch()} />
      ) : null}

      {loading ? (
        <Card>
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      ) : items.length === 0 ? (
        /*
         * 空态说清「东西去哪儿了」而不只是「空」。
         * 一个刚删完东西来找它的用户需要的是一句确认：删除确实生效了，
         * 而且它确实在这里出现过 —— 否则他会怀疑自己删错了别的东西。
         * 但**不放一个「去卡片库」的按钮**：回收站为空时最常见的下一步
         * 是回去继续写，不是一个具体的跳转。
         */
        <Card>
          <div data-testid="trash-empty-state">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                list.data === undefined
                  ? '回收站是空的'
                  : '回收站是空的 —— 删除的卡片与章节会先到这里，可以随时恢复'
              }
            />
          </div>
        </Card>
      ) : (
        <Card className="trash" styles={{ body: { padding: 0 } }}>
          {total > items.length ? (
            <div className="trash__notice" data-testid="trash-notice">
              仅显示最近 {items.length} 条，共 {total} 条 —— 清空回收站会一次删掉全部
            </div>
          ) : null}

          <ul className="trash__list" data-testid="trash-list">
            {items.map((item) => (
              <li
                key={keyOf(item)}
                className="trash__item"
                data-testid="trash-item"
                data-kind={item.kind}
                data-item-id={item.id}
              >
                <Tag className="trash__kind">{TRASH_KIND_LABELS[item.kind]}</Tag>

                <div className="trash__main">
                  <span className="trash__title" data-testid="trash-item-title">
                    {item.title}
                  </span>
                  <span className="trash__meta" data-testid="trash-item-meta">
                    {metaOf(item)}
                  </span>
                </div>

                <Tooltip title={`删除于 ${formatDateTime(item.deletedAt)}`}>
                  <Text type="secondary" className="trash__time" data-testid="trash-item-time">
                    {formatRelativeTime(item.deletedAt)}
                  </Text>
                </Tooltip>

                <Flex gap={8} className="trash__actions">
                  {/*
                    行内两枚也是图标按钮（同上）。这里比页头多一层考虑：
                    行的主操作是「恢复」，而「彻底删除」就排在它旁边 ——
                    两枚都只剩图标时，靠**图标本身的语义**区分（回退箭头 vs
                    垃圾桶）比靠文字更依赖用户认得出那个图形。所以两件事一起做：
                    图标选最通用的字形，文字（含「不可恢复」）进提示，
                    并且给危险那枚单独的红色语气，让它一眼就不像「恢复」。
                  */}
                  <IconButton
                    label="恢复"
                    icon={<UndoOutlined />}
                    loading={pending === keyOf(item)}
                    onClick={() => handleRestore(item)}
                    data-testid="trash-restore"
                  />
                  {/*
                    彻底删除要二次确认，而且默认焦点停在「取消」上 ——
                    「彻底删除」是整个应用里唯一真正不可撤销的动作，
                    而它就排在「恢复」旁边，误点一次就没了。
                    Popconfirm 而不是共用确认框：行是列表里的常驻元素，
                    就地弹一个小气泡比开一个模态框更轻，
                    也让「删的是哪一行」不会有歧义。
                  */}
                  <Popconfirm
                    title={`彻底删除「${item.title}」？`}
                    description={
                      item.kind === 'chapter'
                        ? '无法恢复。它的历史版本也会一起消失。'
                        : '无法恢复。它参与的人物关系与章节关联也会一起消失。'
                    }
                    okText="彻底删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true, 'data-testid': 'trash-purge-confirm' }}
                    onConfirm={() => handlePurge(item)}
                  >
                    <IconButton
                      tone="danger"
                      label="彻底删除（不可恢复）"
                      icon={<DeleteOutlined />}
                      data-testid="trash-purge"
                    />
                  </Popconfirm>
                </Flex>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Flex>
  )
}

/**
 * 一行的副信息：`书名 · 卷名 · 1,234 字`，卡片则把卷名换成类型与简介。
 *
 * 空片段直接丢掉而不是留一个空的「·」：通用卡片没有书、未分卷的章节
 * 没有卷名 —— 都保留的话这两类行会显示成「 ·  · 3,200 字」。
 */
function metaOf(item: TrashItem): string {
  const parts: string[] = [item.bookTitle ?? '通用卡片']

  if (item.kind === 'card') {
    if (item.cardType !== null) parts.push(CARD_TYPE_LABELS[item.cardType])
    if (item.subtitle.length > 0) parts.push(item.subtitle)
  } else {
    if (item.subtitle.length > 0) parts.push(item.subtitle)
    parts.push(`${formatCount(item.hanziCount)} 字`)
  }

  return parts.filter((part) => part.length > 0).join(' · ')
}
