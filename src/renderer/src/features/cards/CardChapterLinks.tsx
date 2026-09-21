import { useMemo } from 'react'
import { Flex, Select, Typography } from 'antd'
import { DisconnectOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router'
import { IconButton } from '../../components/IconButton'
import { useToast } from '../../components/Toast'
import { useChapterList } from '../chapters/use-chapters'
import { useCardLinks, useLinkCardChapter, useUnlinkCardChapter } from './use-card-links'

const { Text } = Typography

interface CardChapterLinksProps {
  cardId: number
  /** null = 通用卡片：不属于任何书，也就谈不上「哪一章用过它」 */
  bookId: number | null
}

/**
 * 「这张卡用在哪几章」。
 *
 * 关联的意义是**反过来也能查**：写完三卷之后回来看这条设定，
 * 想知道「我当时把它写进哪几章了」—— 只靠翻正文是找不到的。
 *
 * 下拉选中即建立关联，没有「确定」按钮：这是幂等操作（重复关联不会产生
 * 第二行），选错的代价只是多点一下解除，而多一步确认会让「给一张卡
 * 连上五章」变成十次点击。
 *
 * 下拉里只列**尚未关联**的章节：已经关联过的再选一次什么也不会发生
 * （幂等），用户只会以为界面卡住了。
 */
export function CardChapterLinks({ cardId, bookId }: CardChapterLinksProps) {
  const toast = useToast()
  const navigate = useNavigate()

  const links = useCardLinks(cardId)
  const chapterList = useChapterList(
    useMemo(() => ({ bookId: bookId ?? 0, volumeId: undefined }), [bookId])
  )
  const linkChapter = useLinkCardChapter()
  const unlinkChapter = useUnlinkCardChapter()

  const linkedIds = useMemo(
    () => new Set((links.data ?? []).map((item) => item.chapterId)),
    [links.data]
  )

  const options = useMemo(
    () =>
      (chapterList.data ?? [])
        .filter((chapter) => !linkedIds.has(chapter.id))
        .map((chapter) => ({ value: chapter.id, label: chapter.title })),
    [chapterList.data, linkedIds]
  )

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      toast.notifyError(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <Flex vertical gap={8} className="card-links" data-testid="card-links">
      <Flex justify="space-between" align="center" gap={8}>
        <Text strong className="card-links__title">
          用在哪几章
        </Text>
        {links.data === undefined ? null : (
          <Text type="secondary" className="card-links__count" data-testid="card-links-count" data-value={links.data.length}>
            已关联 {links.data.length} 章
          </Text>
        )}
      </Flex>

      {bookId === null ? (
        <Text type="secondary" className="card-links__hint">
          通用卡片不属于任何书，先把它指定到一本书下，才能记下它用在哪几章。
        </Text>
      ) : (
        <>
          {links.data !== undefined && links.data.length > 0 ? (
            <Flex vertical gap={6} className="card-links__list" data-testid="card-links-list">
              {links.data.map((item) => (
                <Flex
                  key={item.chapterId}
                  align="center"
                  gap={8}
                  className="card-links__row"
                  data-testid="card-link-row"
                  data-chapter-id={item.chapterId}
                >
                  {/*
                   * 章名做成按钮：关联列表最常见的下一步就是「跳过去看看
                   * 当时怎么写的」。带 from 参数，那边就能有一张回到卡片库的
                   * 回程票 —— 见 OriginReturn。
                   */}
                  <button
                    type="button"
                    className="card-links__jump"
                    data-testid="card-link-jump"
                    onClick={() =>
                      navigate(
                        `/books/${bookId}/chapters/${item.chapterId}?from=${encodeURIComponent('/cards')}`
                      )
                    }
                  >
                    {item.chapterTitle}
                  </button>
                  <Text type="secondary" className="card-links__meta">
                    {item.volumeTitle === null ? '未分卷' : item.volumeTitle}
                  </Text>
                  <IconButton
                    label={`解除与「${item.chapterTitle}」的关联`}
                    icon={<DisconnectOutlined />}
                    data-testid="card-unlink-chapter"
                    loading={unlinkChapter.isPending}
                    onClick={() =>
                      run(async () => {
                        await unlinkChapter.mutateAsync({ cardId, chapterId: item.chapterId })
                        toast.notifySuccess('已解除关联')
                      })
                    }
                  />
                </Flex>
              ))}
            </Flex>
          ) : (
            <Text type="secondary" className="card-links__hint">
              还没有关联章节。
            </Text>
          )}

          <Select
            data-testid="card-link-chapter-select"
            className="card-links__select"
            value={null}
            placeholder={
              options.length === 0 ? '这本书的章节都已关联' : '选择一章，立刻建立关联'
            }
            disabled={options.length === 0}
            loading={chapterList.isLoading || linkChapter.isPending}
            options={options}
            onChange={(chapterId: number) =>
              run(async () => {
                await linkChapter.mutateAsync({ cardId, chapterId })
                toast.notifySuccess('已关联到这一章')
              })
            }
          />
        </>
      )}
    </Flex>
  )
}
