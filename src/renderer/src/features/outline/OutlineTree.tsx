import { memo, useMemo } from 'react'
import { Badge, Tag, Tooltip, Tree } from 'antd'
import type { Key, ReactNode } from 'react'
import {
  OUTLINE_NODE_TYPE_LABELS,
  type OutlineTreeNode
} from '@shared/modules/outline'
import { NODE_TYPE_COLORS, STATUS_BADGE } from './outline-meta'

/**
 * 树的索引：两张互相反查的表。
 *
 * 拖拽落点的换算、以及「不能把节点拖进自己的子树」的判断都基于它，
 * 两者都需要在内存里就能回答「谁是谁的父 / 子」，不能每次去问数据库。
 */
export interface OutlineIndex {
  parentOf: Map<number, number | null>
  childrenOf: Map<number | null, number[]>
}

export function indexTree(nodes: readonly OutlineTreeNode[]): OutlineIndex {
  const parentOf = new Map<number, number | null>()
  const childrenOf = new Map<number | null, number[]>()

  const walk = (list: readonly OutlineTreeNode[], parentId: number | null): void => {
    for (const node of list) {
      parentOf.set(node.id, parentId)
      const bucket = childrenOf.get(parentId)
      if (bucket) bucket.push(node.id)
      else childrenOf.set(parentId, [node.id])
      walk(node.children, node.id)
    }
  }

  walk(nodes, null)
  return { parentOf, childrenOf }
}

export interface OutlineDropTarget {
  parentId: number | null
  targetIndex: number
}

/**
 * `dropPosition` 换算成「相对于落点节点的位置」。
 *
 * 必须减掉落点节点在父节点中的下标 —— 组件对外暴露的 `dropPosition`
 * 是 `相对位置 + 该下标`（见 rc-tree 的 `dropPosition + Number(posArr[...])`），
 * 也就是说它是「整棵树扁平化后的绝对行号」，不是简单的 -1 / 0 / 1。
 * 直接拿它判断前后会把节点插到错误的层级。
 */
function relativeDropPosition(info: { dropPosition: number; node: { pos: string } }): number {
  const segments = info.node.pos.split('-')
  const indexInParent = Number(segments[segments.length - 1])
  return info.dropPosition - (Number.isFinite(indexInParent) ? indexInParent : 0)
}

/**
 * 落点 → (目标父节点, 目标下标)。
 *
 * 下标是在**去掉被拖拽节点之后**的兄弟列表里数的 —— 与服务端
 * `OutlineRepository.move` 的口径必须一致：它也是先排除自己再插入。
 * 两边算法若不一致，同层内往前拖就会差一位。
 */
export function resolveDropTarget(
  index: OutlineIndex,
  dragId: number,
  dropId: number,
  relPosition: number
): OutlineDropTarget {
  // 落在节点的「行」上（不是间隙）→ 成为它的子节点。
  // 追加到末尾而不是插到最前：拖进去的语义是「归到这条下面继续写」，
  // 而组件的落点提示并不指示具体位置，追加是最可预期的行为。
  if (relPosition === 0) {
    const children = (index.childrenOf.get(dropId) ?? []).filter((id) => id !== dragId)
    return { parentId: dropId, targetIndex: children.length }
  }

  const parentId = index.parentOf.get(dropId) ?? null
  const siblings = (index.childrenOf.get(parentId) ?? []).filter((id) => id !== dragId)
  const at = siblings.indexOf(dropId)

  return {
    parentId,
    targetIndex: Math.max(0, relPosition < 0 ? at : at + 1)
  }
}

/** 候选节点是否在祖先节点的子树里 */
export function isDescendantOf(index: OutlineIndex, ancestorId: number, candidateId: number): boolean {
  let cursor = index.parentOf.get(candidateId) ?? null
  const seen = new Set<number>()

  while (cursor !== null) {
    if (cursor === ancestorId) return true
    // 数据里若已有环（只可能来自手工改库），这里必须能自己停下来
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = index.parentOf.get(cursor) ?? null
  }

  return false
}

interface OutlineDataNode {
  key: number
  title: ReactNode
  children: OutlineDataNode[]
}

/**
 * 树节点 → 组件要求的数据节点。
 *
 * `title` 直接给 JSX 而不是用 `titleRender`：后者的参数类型是
 * 组件的内部 `EventDataNode`，要拿回我们自己的字段得先做一层断言，
 * 而这里本来就已经握着领域对象，直接渲染更直接。
 */
function toDataNode(node: OutlineTreeNode): OutlineDataNode {
  return {
    key: node.id,
    children: node.children.map(toDataNode),
    title: (
      <span className="outline-node" data-testid="outline-node-row" data-node-id={node.id}>
        <Badge status={STATUS_BADGE[node.status]} />
        <span
          className={
            node.status === 'dropped'
              ? 'outline-node__title outline-node__title--dropped'
              : 'outline-node__title'
          }
        >
          {node.title}
        </span>
        <Tag color={NODE_TYPE_COLORS[node.nodeType]} className="outline-node__type">
          {OUTLINE_NODE_TYPE_LABELS[node.nodeType]}
        </Tag>
        {node.chapterTitle === null ? null : (
          <Tooltip title={`已落地到《${node.chapterTitle}》`}>
            <span className="outline-node__chapter">→ {node.chapterTitle}</span>
          </Tooltip>
        )}
      </span>
    )
  }
}

interface OutlineTreeProps {
  nodes: readonly OutlineTreeNode[]
  selectedId: number | null
  expandedKeys: Key[]
  onSelect: (id: number) => void
  onExpandedKeysChange: (keys: Key[]) => void
  onMove: (dragId: number, target: OutlineDropTarget) => void
}

function OutlineTreeInner({
  nodes,
  selectedId,
  expandedKeys,
  onSelect,
  onExpandedKeysChange,
  onMove
}: OutlineTreeProps) {
  const index = useMemo(() => indexTree(nodes), [nodes])
  const treeData = useMemo(() => nodes.map(toDataNode), [nodes])

  return (
    /*
     * 锚点挂在这层容器上，而不是 Tree 自己身上。
     *
     * antd 的 Tree 不会把任意的 `data-*` 属性透传到 DOM —— 挂在它上面
     * 时 `querySelector('[data-testid="outline-tree"]')` 查不到元素，
     * 而树其实渲染得好好的（行数、高度都正常），断言只会报「树未渲染」。
     * 顺带这层容器也承担滚动：Tree 自带的是普通流布局，滚动区放在外面。
     */
    <div className="outline-tree" data-testid="outline-tree">
      <Tree
        blockNode
        showLine={{ showLeafIcon: false }}
        selectedKeys={selectedId === null ? [] : [selectedId]}
        expandedKeys={expandedKeys}
        onExpand={(keys) => onExpandedKeysChange(keys)}
        onSelect={(keys) => {
          const first = keys[0]
          if (first !== undefined) onSelect(Number(first))
        }}
        treeData={treeData}
        draggable={{ icon: false }}
        /*
         * 在拖拽过程中就把非法落点挡掉，而不是等主进程报错。
         * 拖到自己或自己的子孙之下会在树上形成环 —— 那种结构从任何根
         * 都走不到（节点会从界面上凭空消失），而递归渲染会直接爆栈。
         * 服务层同样会拒绝（纵深防御），但在这里拦掉能给出即时的视觉反馈，
         * 而不是让人拖完再看一个报错提示。
         */
        allowDrop={({ dragNode, dropNode }) => {
          const dragId = Number(dragNode.key)
          const dropId = Number(dropNode.key)
          if (dragId === dropId) return false
          return !isDescendantOf(index, dragId, dropId)
        }}
        onDrop={(info) => {
          const dragId = Number(info.dragNode.key)
          onMove(
            dragId,
            resolveDropTarget(index, dragId, Number(info.node.key), relativeDropPosition(info))
          )
        }}
      />
    </div>
  )
}

export const OutlineTree = memo(OutlineTreeInner)
