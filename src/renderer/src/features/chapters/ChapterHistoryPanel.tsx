import { useMemo, useState } from 'react'
import { Alert, Button, Empty, Flex, Popconfirm, Spin, Tag, Typography } from 'antd'
import { HistoryOutlined, UndoOutlined } from '@ant-design/icons'
import { CHAPTER_REVISION_LIMITS } from '@shared/modules/chapters'
import {
  rememberRevisionHtml,
  useChapterRevision,
  useChapterRevisions,
  useRestoreChapterRevision
} from './use-chapters'
import { diffParagraphs } from './revision-diff'

const { Text } = Typography

/**
 * 历史版本面板（第三期第 4 件）。
 *
 * 解决的是「误删一大段拿不回来」：自动保存把每次改动都覆盖到 chapters
 * 那一行，前一版正文当场消失。这里把每次保存的**前一个**版本列出来，
 * 能看差异、能退回去。
 *
 * 为什么做成正文上方的横条，而不是右侧窄栏里的又一个页签：
 *   1. 差异对比要左右并排两栏正文，右栏只有两百多像素，并排就是两列
 *      四五个字宽，读不出任何东西；
 *   2. 右栏已经有 7 项（3 个写作工具页签 + 1 个本章设定页签 + 3 个查阅
 *      视图），当初「查阅视图换成整组」那个决定就是为了不再加项。
 * 横条借用正文区的整个宽度，打开时把正文推下去，关掉即还原。
 */
export function ChapterHistoryPanel({
  chapterId,
  currentText,
  onRestore,
  onClose
}: {
  chapterId: number
  /** 编辑器里当前的纯文本，用于「这一版 vs 现在」的对比 */
  currentText: string
  /**
   * 回档成功：把回档后的正文交给页面，页面负责重建编辑器
   * （编辑器自己管内容，页面不参与正文状态 —— 见 RichTextEditor 的约定）
   */
  onRestore: (contentHtml: string) => void
  onClose: () => void
}) {
  const revisions = useChapterRevisions(chapterId)
  const restore = useRestoreChapterRevision()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const list = useMemo(() => revisions.data ?? [], [revisions.data])

  /*
   * 默认选中最新的一版。作者点开「历史版本」要找的绝大多数时候就是
   * 「刚才那一下之前」，排在最上面又默认选中，等于省掉一次点击。
   */
  const activeId = selectedId ?? list[0]?.id ?? null
  const active = list.find((item) => item.id === activeId) ?? null

  // 只在这一条真的被选中时才发请求取正文；列表本身不带正文
  const detail = useChapterRevision(activeId)

  const handleRestore = async (): Promise<void> => {
    if (active === null || detail.data === undefined) return
    // 把这一版的正文交给 mutation 就地写回详情缓存（见 use-chapters）
    rememberRevisionHtml(active.id, detail.data.contentHtml)
    const result = await restore.mutateAsync({ chapterId, revisionId: active.id })
    onRestore(detail.data.contentHtml)
    // result 只用于缓存写回，页面不关心；但保留引用让 lint 看得出它的用途
    void result
  }

  return (
    <section className="history" data-testid="chapter-history-panel">
      <Flex align="center" gap={8} className="history__head">
        <HistoryOutlined className="history__head-icon" />
        <Text strong className="history__title">
          历史版本
        </Text>
        <Text type="secondary" className="history__meta" data-testid="history-meta">
          共 {list.length} 版 · 每章保留最近 {CHAPTER_REVISION_LIMITS.perChapter} 版
        </Text>
        <Button size="small" type="text" onClick={onClose} data-testid="history-close">
          关闭
        </Button>
      </Flex>

      {revisions.isPending ? (
        <div className="history__center">
          <Spin size="small" />
        </div>
      ) : list.length === 0 ? (
        /*
         * 空状态刻意不用「暂无数据」：作者看到空列表的第一反应是
         * 「坏了，我的历史没了」，所以这里要解释**为什么**是空的。
         */
        <Empty
          className="history__empty"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary">
              还没有可回退的版本。每保存一次正文，改动前的旧内容会自动留一版；
              短于 {CHAPTER_REVISION_LIMITS.minHanzi} 字的微改动不占用配额。
            </Text>
          }
        />
      ) : (
        <div className="history__body">
          <ul className="history__list" data-testid="history-list">
            {list.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`history__item${item.id === activeId ? ' history__item--active' : ''}`}
                  data-testid="history-item"
                  data-revision-id={item.id}
                  data-hanzi={item.hanziCount}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="history__item-time" data-testid="history-item-time">
                    {formatTime(item.createdAt)}
                  </span>
                  <span className="history__item-words">{item.hanziCount} 字</span>
                  <DeltaTag value={item.deltaHanzi} />
                  {index === 0 ? (
                    <Tag className="history__item-tag" data-testid="history-latest">
                      最近
                    </Tag>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="history__preview">
            <Flex align="center" gap={8} className="history__preview-head">
              <Text type="secondary" className="history__preview-title">
                与当前正文对比（左＝这一版，右＝现在的正文）
              </Text>
              <Popconfirm
                title="回到这一版？"
                description="当前正文会先被留成一版新的历史，之后还能再退回来。"
                okText="回档"
                cancelText="取消"
                // 确认按钮渲染在 body 上的浮层里，锚点必须挂在浮层自己身上 ——
                // 挂在外层按钮上，断言就只能验「弹了没有」而点不到真正的回档
                okButtonProps={{ 'data-testid': 'history-restore-confirm' }}
                onConfirm={() => void handleRestore()}
              >
                <Button
                  size="small"
                  type="primary"
                  icon={<UndoOutlined />}
                  loading={restore.isPending}
                  data-testid="history-restore"
                >
                  回到这一版
                </Button>
              </Popconfirm>
            </Flex>

            {restore.isError ? (
              <Alert
                type="error"
                showIcon
                className="history__error"
                message="回档失败"
                description="这一版可能已被清理，刷新历史列表后再试。"
              />
            ) : null}

            {detail.isPending ? (
              <div className="history__center">
                <Spin size="small" />
              </div>
            ) : detail.data === undefined ? (
              <Text type="secondary">
                这一版已被清理（每章只保留最近 {CHAPTER_REVISION_LIMITS.perChapter} 版），
                关闭后重新打开即可看到最新列表。
              </Text>
            ) : (
              <RevisionDiff
                oldText={detail.data.contentText}
                currentText={currentText}
                hanzi={detail.data.hanziCount}
              />
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** 相对前一版的增减。null 表示这是最早的一版，没有可比对象 */
function DeltaTag({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Tag className="history__item-tag" data-testid="history-delta" data-delta="base">
        最早
      </Tag>
    )
  }
  if (value === 0) {
    return (
      <Tag className="history__item-tag" data-testid="history-delta" data-delta="flat">
        ±0
      </Tag>
    )
  }
  return (
    <Tag
      className="history__item-tag"
      color={value > 0 ? 'green' : 'orange'}
      data-testid="history-delta"
      data-delta={value > 0 ? 'up' : 'down'}
    >
      {value > 0 ? `+${value}` : String(value)}
    </Tag>
  )
}

/**
 * 左右并排的差异对比。
 *
 * 用「段落对段落」的朴素对齐，不做字符级 LCS：正文的段落是作者的
 * 天然编辑单位（他删的是「那一段」，不是「第 3712 个字符」），
 * 段落级已经足够回答「我丢的是哪几段」；而字符级 diff 在几十万字的
 * 正文上会明显卡顿，代价与收益不成比例。
 * 对齐算法本身在 revision-diff.ts，是纯函数，有单测。
 */
function RevisionDiff({
  oldText,
  currentText,
  hanzi
}: {
  oldText: string
  currentText: string
  hanzi: number
}) {
  const rows = useMemo(() => diffParagraphs(oldText, currentText), [oldText, currentText])
  const changed = useMemo(() => rows.filter((row) => row.kind !== 'same').length, [rows])

  return (
    <div className="diff" data-testid="history-diff">
      <Text type="secondary" className="diff__summary" data-testid="history-diff-summary">
        这一版 {hanzi} 字
        {changed === 0 ? '，与现在的正文完全相同' : `，有 ${changed} 段不同`}
      </Text>
      <div className="diff__grid">
        <div className="diff__col" data-testid="history-diff-old">
          {rows.map((row, index) => (
            <p
              key={`old-${index}`}
              className={`diff__line diff__line--${row.old === null ? 'absent' : row.kind}`}
              data-testid="history-diff-old-line"
            >
              {row.old ?? ''}
            </p>
          ))}
        </div>
        <div className="diff__col" data-testid="history-diff-new">
          {rows.map((row, index) => (
            <p
              key={`new-${index}`}
              className={`diff__line diff__line--${row.new === null ? 'absent' : row.kind}`}
              data-testid="history-diff-new-line"
            >
              {row.new ?? ''}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 只格式化到分钟：版本列表里秒级精度没有意义，反而让每一行长短不一 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
