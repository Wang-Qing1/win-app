import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  Alert,
  Button,
  Descriptions,
  Divider,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  PlusOutlined,
  RocketOutlined,
  SaveOutlined,
  UndoOutlined
} from '@ant-design/icons'
import type { ChapterListItem } from '@shared/modules/chapters'
import { CHAPTER_STATUS_LABELS } from '@shared/modules/chapters'
import {
  OUTLINE_LIMITS,
  OUTLINE_NODE_TYPES,
  OUTLINE_NODE_TYPE_LABELS,
  OUTLINE_STATUSES,
  OUTLINE_STATUS_LABELS,
  type OutlineNodeType,
  type OutlineStatus,
  type OutlineTreeNode
} from '@shared/modules/outline'
import type { VolumeListItem } from '@shared/modules/volumes'
import { useToast } from '../../components/Toast'
import { NODE_TYPE_COLORS } from './outline-meta'

const { Text, Paragraph } = Typography

/** 可编辑字段的草稿。与节点一起交给页面去提交，面板自己不碰数据层 */
export interface OutlineNodeDraft {
  title: string
  nodeType: OutlineNodeType
  status: OutlineStatus
  summary: string
}

function toDraft(node: OutlineTreeNode): OutlineNodeDraft {
  return {
    title: node.title,
    nodeType: node.nodeType,
    status: node.status,
    summary: node.summary
  }
}

export interface OutlineNodePanelProps {
  node: OutlineTreeNode | null
  bookId: number
  chapters: readonly ChapterListItem[]
  volumes: readonly VolumeListItem[]
  /** 已被其它节点占用的章节：章节 id → 占用它的节点标题 */
  takenChapters: ReadonlyMap<number, string>
  onAddChild: (parentId: number) => void
  onAddSibling: (node: OutlineTreeNode) => void
  onDelete: (node: OutlineTreeNode) => void
  onSave: (node: OutlineTreeNode, draft: OutlineNodeDraft) => Promise<void>
  onAttachChapter: (node: OutlineTreeNode, chapterId: number | null) => Promise<void>
  onDetachChapter: (node: OutlineTreeNode) => Promise<void>
  onMaterialize: (node: OutlineTreeNode, volumeId: number | null) => Promise<void>
}

export function OutlineNodePanel({
  node,
  bookId,
  chapters,
  volumes,
  takenChapters,
  onAddChild,
  onAddSibling,
  onDelete,
  onSave,
  onAttachChapter,
  onDetachChapter,
  onMaterialize
}: OutlineNodePanelProps) {
  const toast = useToast()
  const [draft, setDraft] = useState<OutlineNodeDraft | null>(null)
  const [volumeId, setVolumeId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // 换选中的节点就重置草稿：否则在 A 节点上改了一半的标题
  // 会被带到 B 节点，点保存就把 B 改成了 A 的名字
  useEffect(() => {
    setDraft(node === null ? null : toDraft(node))
    setVolumeId(null)
  }, [node])

  /** 章节下拉：已被别的节点占用的置灰并标出占用者，避免选了才报错 */
  const chapterOptions = useMemo(
    () =>
      chapters.map((chapter) => {
        const owner = takenChapters.get(chapter.id)
        return {
          value: chapter.id,
          disabled: owner !== undefined && owner !== node?.title,
          label:
            owner === undefined
              ? chapter.title
              : `${chapter.title}（已关联到「${owner}」）`
        }
      }),
    [chapters, takenChapters, node?.title]
  )

  if (node === null || draft === null) {
    return (
      <div className="outline-panel outline-panel--empty" data-testid="outline-panel">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Flex vertical gap={6} align="center">
              <Text type="secondary">在左侧选择一个节点来编辑</Text>
              <Text type="secondary" className="outline-panel__hint">
                拖拽节点可以调整层级与顺序；把节点拖到另一个节点上会成为它的子节点。
              </Text>
            </Flex>
          }
        />
      </div>
    )
  }

  const dirty =
    draft.title !== node.title ||
    draft.nodeType !== node.nodeType ||
    draft.status !== node.status ||
    draft.summary !== node.summary

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.notifyError(error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="outline-panel" data-testid="outline-panel" data-node-id={node.id}>
      <Flex vertical gap={14}>
        <Flex justify="space-between" align="center" gap={8}>
          <Space size={6} wrap>
            <Tag color={NODE_TYPE_COLORS[node.nodeType]}>
              {OUTLINE_NODE_TYPE_LABELS[node.nodeType]}
            </Tag>
            <Text type="secondary" className="outline-panel__meta">
              第 {node.orderIndex + 1} 位 · 子节点 {node.descendantCount} 个
            </Text>
          </Space>
          <Space size={4}>
            <Tooltip title="在这条下面加一个子节点">
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => onAddChild(node.id)}
              >
                子节点
              </Button>
            </Tooltip>
            <Tooltip title="在它后面加一个同级节点">
              <Button size="small" onClick={() => onAddSibling(node)}>
                同级
              </Button>
            </Tooltip>
          </Space>
        </Flex>

        <label className="outline-field">
          <span className="outline-field__label">标题</span>
          <Input
            data-testid="outline-title-input"
            value={draft.title}
            maxLength={OUTLINE_LIMITS.title}
            placeholder="这一条要发生什么"
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>

        <Flex gap={12} wrap>
          <label className="outline-field outline-field--grow">
            <span className="outline-field__label">类型</span>
            <Select
              value={draft.nodeType}
              onChange={(value: OutlineNodeType) => setDraft({ ...draft, nodeType: value })}
              options={OUTLINE_NODE_TYPES.map((type) => ({
                value: type,
                label: OUTLINE_NODE_TYPE_LABELS[type]
              }))}
            />
          </label>

          <label className="outline-field outline-field--grow">
            <span className="outline-field__label">状态</span>
            <Select
              value={draft.status}
              onChange={(value: OutlineStatus) => setDraft({ ...draft, status: value })}
              options={OUTLINE_STATUSES.map((status) => ({
                value: status,
                label: OUTLINE_STATUS_LABELS[status]
              }))}
            />
          </label>
        </Flex>

        <label className="outline-field">
          <span className="outline-field__label">梗概</span>
          <Input.TextArea
            value={draft.summary}
            autoSize={{ minRows: 4, maxRows: 12 }}
            maxLength={OUTLINE_LIMITS.summary}
            placeholder="谁、在哪、做了什么、留下什么钩子"
            onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
          />
        </label>

        <Flex gap={8} align="center">
          <Button
            type="primary"
            icon={<SaveOutlined />}
            disabled={!dirty}
            loading={busy}
            data-testid="outline-save"
            onClick={() =>
              run(async () => {
                await onSave(node, draft)
                toast.notifySuccess('已保存')
              })
            }
          >
            保存
          </Button>
          <Button
            icon={<UndoOutlined />}
            disabled={!dirty}
            onClick={() => setDraft(toDraft(node))}
          >
            还原
          </Button>
          {dirty ? (
            <Text type="warning" className="outline-panel__meta">
              有未保存的改动
            </Text>
          ) : null}
        </Flex>

        <Divider className="outline-panel__divider">落地到章节</Divider>

        {node.chapterId === null ? (
          <Flex vertical gap={10}>
            <Paragraph type="secondary" className="outline-panel__hint">
              落地会用这条节点的标题新建一章，并把两者关联起来。之后在树上点章节名就能直接进编辑器。
            </Paragraph>
            <Flex gap={8} align="center" wrap>
              <Select
                className="outline-panel__volume"
                value={volumeId}
                placeholder="归属分卷（可不选）"
                allowClear
                onChange={(value: number | null | undefined) => setVolumeId(value ?? null)}
                options={volumes.map((volume) => ({ value: volume.id, label: volume.title }))}
              />
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={busy}
                disabled={draft.title.trim().length === 0}
                onClick={() => run(() => onMaterialize(node, volumeId))}
              >
                落地成章节
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Flex vertical gap={10}>
            <Alert
              type="success"
              showIcon
              message={
                <Flex gap={8} align="center" wrap>
                  <span>
                    已落地到《{node.chapterTitle ?? `章节 ${node.chapterId}`}》
                    {node.chapterStatus === null
                      ? null
                      : ` · ${CHAPTER_STATUS_LABELS[node.chapterStatus]}`}
                  </span>
                  <Link to={`/books/${bookId}/chapters/${node.chapterId}`}>打开编辑器 →</Link>
                </Flex>
              }
            />
            <Flex gap={8} wrap>
              <Button
                icon={<UndoOutlined />}
                loading={busy}
                onClick={() => run(() => onDetachChapter(node))}
              >
                解除关联
              </Button>
              <Text type="secondary" className="outline-panel__meta">
                解除只断开这条连线，节点与章节都保留。
              </Text>
            </Flex>
          </Flex>
        )}

        <Divider className="outline-panel__divider">关联已有章节</Divider>

        <Select
          data-testid="outline-chapter-select"
          className="outline-panel__full"
          placeholder="选择一章关联（不改动章节内容）"
          value={node.chapterId ?? undefined}
          allowClear
          options={chapterOptions}
          onChange={(value: number | undefined) =>
            run(() => onAttachChapter(node, value ?? null))
          }
        />

        <Divider className="outline-panel__divider">其它</Divider>

        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'created', label: '创建于', children: formatTime(node.createdAt) },
            { key: 'updated', label: '更新于', children: formatTime(node.updatedAt) },
            { key: 'depth', label: '节点 ID', children: `#${node.id}` }
          ]}
        />

        <Popconfirm
          title="删除这个节点？"
          description={
            node.descendantCount > 0
              ? `它会连同下面的 ${node.descendantCount} 个子节点一起被删除，且无法撤销。`
              : '删除后无法撤销。'
          }
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={() =>
            run(async () => {
              await onDelete(node)
              toast.notifySuccess('已删除')
            })
          }
        >
          <Button danger icon={<DeleteOutlined />} data-testid="outline-delete">
            删除节点
          </Button>
        </Popconfirm>
      </Flex>
    </div>
  )
}

function formatTime(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  return time.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
