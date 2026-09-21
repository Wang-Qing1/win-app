import { useMemo } from 'react'
import { Flex, Select, Typography } from 'antd'
import { DisconnectOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router'
import type { OutlineTreeNode } from '@shared/modules/outline'
import { IconButton } from '../../components/IconButton'
import { useToast } from '../../components/Toast'
import { useOutlineTree } from '../outline/use-outline'
import {
  useCardNodeLinks,
  useLinkCardNode,
  useUnlinkCardNode
} from './use-card-links'

const { Text } = Typography

interface CardOutlineLinksProps {
  cardId: number
  /** null = 通用卡片：不属于任何书，也就谈不上「挂在哪个节点上」 */
  bookId: number | null
}

/**
 * 「这张卡挂在哪些大纲节点上」。
 *
 * 与「用在哪几章」是两件事，不是一个列表里混着显示：
 * 章节是**已经写出来的正文**，节点是**还没落地的构想**。一条设定常常先
 * 挂在某个情节节点上（「第三卷的高潮要用到那条禁忌」），那一章写出来之后
 * 再补上章节关联。两者并存，各自回答不同阶段的问题。
 *
 * 下拉里只列尚未关联的节点，原因与章节侧一致：重复关联是幂等的，
 * 选了什么也不会发生，用户只会以为界面卡住了。
 */
export function CardOutlineLinks({ cardId, bookId }: CardOutlineLinksProps) {
  const toast = useToast()
  const navigate = useNavigate()

  const links = useCardNodeLinks(cardId)
  const tree = useOutlineTree(bookId)
  const linkNode = useLinkCardNode()
  const unlinkNode = useUnlinkCardNode()

  /** 树是嵌套的，下拉要扁平的一列，所以先摊平（深度优先，与树上的顺序一致） */
  const flatNodes = useMemo(() => {
    const out: { id: number; title: string }[] = []
    const walk = (nodes: OutlineTreeNode[]): void => {
      for (const node of nodes) {
        out.push({ id: node.id, title: node.title })
        walk(node.children)
      }
    }
    if (tree.data) walk(tree.data.nodes)
    return out
  }, [tree.data])

  const linkedIds = useMemo(
    () => new Set((links.data ?? []).map((item) => item.nodeId)),
    [links.data]
  )

  const options = useMemo(
    () =>
      flatNodes
        .filter((node) => !linkedIds.has(node.id))
        .map((node) => ({ value: node.id, label: node.title })),
    [flatNodes, linkedIds]
  )

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      toast.notifyError(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <Flex vertical gap={8} className="card-links" data-testid="card-node-links">
      <Flex justify="space-between" align="center" gap={8}>
        <Text strong className="card-links__title">
          挂在哪些情节节点
        </Text>
        {links.data === undefined ? null : (
          <Text
            type="secondary"
            className="card-links__count"
            data-testid="card-node-links-count"
            data-value={links.data.length}
          >
            已关联 {links.data.length} 个节点
          </Text>
        )}
      </Flex>

      {bookId === null ? (
        <Text type="secondary" className="card-links__hint">
          通用卡片不属于任何书，先把它指定到一本书下，才能挂到这本书的情节节点上。
        </Text>
      ) : (
        <>
          {links.data !== undefined && links.data.length > 0 ? (
            <Flex vertical gap={6} className="card-links__list" data-testid="card-node-links-list">
              {links.data.map((item) => (
                <Flex
                  key={item.nodeId}
                  align="center"
                  gap={8}
                  className="card-links__row"
                  data-testid="card-node-link-row"
                  data-node-id={item.nodeId}
                >
                  {/*
                   * 节点名做成按钮：下一步通常是「跳过去看看这个情节
                   * 是怎么安排的」。带 from 参数，那边就有回程票。
                   */}
                  <button
                    type="button"
                    className="card-links__jump"
                    data-testid="card-node-link-jump"
                    onClick={() =>
                      navigate(`/outline?from=${encodeURIComponent('/cards')}`)
                    }
                  >
                    {item.nodeTitle}
                  </button>
                  <Text type="secondary" className="card-links__meta">
                    {item.bookTitle}
                  </Text>
                  <IconButton
                    label={`解除与「${item.nodeTitle}」的关联`}
                    icon={<DisconnectOutlined />}
                    data-testid="card-unlink-node"
                    loading={unlinkNode.isPending}
                    onClick={() =>
                      run(async () => {
                        await unlinkNode.mutateAsync({ cardId, nodeId: item.nodeId })
                        toast.notifySuccess('已解除关联')
                      })
                    }
                  />
                </Flex>
              ))}
            </Flex>
          ) : (
            <Text type="secondary" className="card-links__hint">
              还没有关联情节节点。
            </Text>
          )}

          <Select
            data-testid="card-link-node-select"
            className="card-links__select"
            value={null}
            placeholder={
              options.length === 0 ? '这本书的节点都已关联' : '选择一个情节节点，立刻建立关联'
            }
            disabled={options.length === 0}
            loading={tree.isLoading || linkNode.isPending}
            options={options}
            onChange={(nodeId: number) =>
              run(async () => {
                await linkNode.mutateAsync({ cardId, nodeId })
                toast.notifySuccess('已挂到这个情节节点')
              })
            }
          />
        </>
      )}
    </Flex>
  )
}
