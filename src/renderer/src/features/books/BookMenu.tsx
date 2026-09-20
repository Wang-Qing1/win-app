import { useState } from 'react'
import { Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { DeleteOutlined, EditOutlined, ExportOutlined, MoreOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router'
import type { Book } from '@shared/modules/books'
import { IconButton } from '../../components/IconButton'
import { MenuRow } from '../../components/MenuRow'
import { useConfirm, useToast } from '../../components/Toast'
import { useExportBook } from '../chapters/use-exporter'
import { BookFormModal, type BookFormValues } from './BookFormModal'
import { useRemoveBook, useUpdateBook } from './use-books'

interface BookMenuProps {
  book: Book
  /** 这本书下的章节数，只用于「删除书籍」的二次确认里把后果说清楚 */
  chapterCount: number
}

/**
 * 编辑器顶栏的书籍菜单（`…`）。
 *
 * 用户 2026-09-20 取消了独立的「书籍详情页」（「这个页面的功能完全不正确，
 * 新建书籍并且打开书籍之后应该是正文编辑页」），但那一页上的**书籍级操作**
 * 不能跟着一起消失：编辑书籍信息 / 导出整本书 / 删除书籍。它们没地方可去，
 * 除非挤进某一栏 —— 而顶栏右端那四枚（查找 / 取名 / 专注 / 发布）都是
 * 「写字时随手要用」的，把三个低频的书籍级操作并排塞进去，只会让每次写作
 * 都要先绕开它们。
 *
 * 所以走顶栏 `…` 这条**已经存在的**成例（见 `TopBarMenu`）：一枚圆形按钮
 * 收住全部低频操作，展开后每项行首是一个圆形图标 + 两行文字。这样全应用
 * 只有一种「低频操作怎么摆」的答案。
 *
 * 「删除书籍」放在这个菜单里，因此确认只能用模态框（`useConfirm`）：
 * 菜单一点就关，`Popconfirm` 需要一枚常驻的触发元素，浮层里挂不住。
 */
export function BookMenu({ book, chapterCount }: BookMenuProps) {
  const navigate = useNavigate()
  const { notifySuccess, notifyError } = useToast()
  const confirm = useConfirm()

  const [formOpen, setFormOpen] = useState(false)
  const updateBook = useUpdateBook()
  const removeBook = useRemoveBook()
  const exportBook = useExportBook()

  const handleExport = (): void => {
    void exportBook
      .mutateAsync({ bookId: book.id, format: 'txt' })
      .then((result) => {
        if (!result.canceled) notifySuccess(`已导出整本书（${result.chapterCount} 章）`)
      })
      .catch((error: unknown) => notifyError(messageOf(error, '导出失败')))
  }

  const handleRemove = (): void => {
    void confirm({
      title: `删除《${book.title}》？`,
      description:
        chapterCount > 0
          ? `这本书的 ${chapterCount} 章正文会一并删除且无法恢复。写作记录会保留。`
          : '这本书会被删除且无法恢复。',
      okText: '确认删除',
      danger: true
    }).then((ok) => {
      if (!ok) return
      void removeBook
        .mutateAsync({ id: book.id })
        .then(() => {
          notifySuccess(`已删除《${book.title}》`)
          void navigate('/books')
        })
        .catch((error: unknown) => notifyError(messageOf(error, '删除失败')))
    })
  }

  const items: MenuProps['items'] = [
    {
      key: 'edit',
      label: (
        <MenuRow
          testId="book-menu-edit"
          icon={<EditOutlined />}
          title="编辑书籍信息"
          hint="书名、笔名、目标字数、每章最少字数"
        />
      ),
      onClick: () => setFormOpen(true)
    },
    {
      key: 'export',
      label: (
        <MenuRow
          testId="book-menu-export"
          icon={<ExportOutlined />}
          title="导出整本书"
          hint="按分卷与章节顺序合并成一个 .txt"
        />
      ),
      onClick: handleExport
    },
    { type: 'divider' },
    {
      key: 'remove',
      danger: true,
      label: (
        <MenuRow
          testId="book-menu-remove"
          icon={<DeleteOutlined />}
          title="删除这本书"
          hint="正文会一并删除，且无法恢复"
        />
      ),
      onClick: handleRemove
    }
  ]

  return (
    <>
      <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
        <IconButton
          label="书籍菜单（编辑信息 / 导出 / 删除）"
          icon={<MoreOutlined />}
          data-testid="editor-book-menu"
        />
      </Dropdown>

      <BookFormModal
        open={formOpen}
        book={book}
        submitting={updateBook.isPending}
        error={updateBook.error}
        onSubmit={(values: BookFormValues) => {
          void updateBook
            .mutateAsync({ id: book.id, ...values })
            .then(() => {
              notifySuccess('书籍信息已更新')
              setFormOpen(false)
            })
            .catch(() => undefined)
        }}
        onCancel={() => {
          setFormOpen(false)
          updateBook.reset()
        }}
      />
    </>
  )
}

/**
 * 菜单项的行复用 `MenuRow`（与顶栏 `…` 同一份形状，见那个文件的说明）。
 */

/** 把任意异常转成可展示文案，带上场景前缀 */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}
