import { useEffect } from 'react'
import { Alert, Form, Input, InputNumber, Modal, Select, Typography } from 'antd'
import { BOOK_ACCENT_PRESETS, BOOK_LIMITS, BOOK_STATUSES, BOOK_STATUS_LABELS, type Book, type BookCreateInput } from '@shared/modules/books'
import { ApiError, isApiError } from '../../lib/api-client'

const { Text } = Typography

interface BookFormValues {
  title: string
  penName: string
  genre: string
  status: BookCreateInput['status']
  summary: string
  targetWords: number
  accentColor: string
}

interface BookFormModalProps {
  open: boolean
  /** 传入书籍表示编辑，null 表示新建 */
  book: Book | null
  submitting: boolean
  error: unknown
  onSubmit: (values: BookFormValues) => void
  onCancel: () => void
}

const EMPTY_VALUES: BookFormValues = {
  title: '',
  penName: '',
  genre: '',
  status: 'idea',
  summary: '',
  targetWords: 0,
  accentColor: BOOK_ACCENT_PRESETS[0]
}

/**
 * 新建 / 编辑书籍。
 *
 * 表单校验直接用共享层的 BOOK_LIMITS 与 BOOK_STATUSES，而不是在这里
 * 写一份新的上限 —— 前端不校验的话用户要提交一次才知道超长；前端写一份
 * 自己的上限的话，两边迟早不一致，表现是「前端说行、后端说不行」。
 */
export function BookFormModal({
  open,
  book,
  submitting,
  error,
  onSubmit,
  onCancel
}: BookFormModalProps) {
  const [form] = Form.useForm<BookFormValues>()
  const isEdit = book !== null

  // 打开时灌入初值。用 form.setFieldsValue 而不是给 Form 加 key，
  // 后者会重建整个表单、丢掉输入法状态
  useEffect(() => {
    if (!open) return
    form.setFieldsValue(
      book === null
        ? EMPTY_VALUES
        : {
            title: book.title,
            penName: book.penName,
            genre: book.genre,
            status: book.status,
            summary: book.summary,
            targetWords: book.targetWords,
            accentColor: book.accentColor
          }
    )
  }, [book, form, open])

  const fieldErrors = isApiError(error) ? error.fieldErrors() : {}
  const hasIssues = Object.keys(fieldErrors).length > 0

  return (
    <Modal
      open={open}
      title={isEdit ? `编辑《${book?.title}》` : '新建书籍'}
      okText={isEdit ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => {
        void form.validateFields().then(onSubmit).catch(() => undefined)
      }}
      onCancel={onCancel}
      width={560}
      destroyOnHidden={false}
    >
      {error && !hasIssues ? (
        <Alert
          type={isApiError(error) && (error as ApiError).code === 'CONFLICT' ? 'warning' : 'error'}
          showIcon
          message="保存失败"
          description={isApiError(error) ? error.message : '发生未知错误，请重试'}
          className="book-form__alert"
        />
      ) : null}

      <Form form={form} layout="vertical" initialValues={EMPTY_VALUES} requiredMark="optional">
        <Form.Item
          name="title"
          label="书名"
          rules={[
            { required: true, message: '书名不能为空' },
            { max: BOOK_LIMITS.title, message: `最多 ${BOOK_LIMITS.title} 个字符` }
          ]}
          validateStatus={fieldErrors.title ? 'error' : undefined}
          help={fieldErrors.title}
        >
          <Input placeholder="例如：星海归途" autoFocus />
        </Form.Item>

        <Form.Item name="penName" label="笔名">
          <Input placeholder="留空则用书名占位" />
        </Form.Item>

        <Form.Item name="genre" label="题材">
          <Input placeholder="例如：科幻、都市、玄幻" />
        </Form.Item>

        <Form.Item name="status" label="状态">
          <Select
            options={BOOK_STATUSES.map((status) => ({
              value: status,
              label: BOOK_STATUS_LABELS[status]
            }))}
          />
        </Form.Item>

        <Form.Item
          name="targetWords"
          label="目标字数"
          extra="用于书籍进度条与首页完成度，0 表示不设目标"
        >
          <InputNumber
            min={0}
            max={BOOK_LIMITS.targetWords}
            step={10000}
            className="book-form__number"
          />
        </Form.Item>

        <Form.Item name="summary" label="简介">
          <Input.TextArea
            rows={3}
            maxLength={BOOK_LIMITS.summary}
            showCount
            placeholder="一句话讲清这本书讲什么，方便日后自己回顾"
          />
        </Form.Item>

        <Form.Item name="accentColor" label="标识色" className="book-form__last">
          <AccentPicker />
        </Form.Item>
      </Form>

      {hasIssues ? (
        <Text type="secondary" className="book-form__hint">
          部分字段未通过校验，请检查上方标红的输入框。
        </Text>
      ) : null}
    </Modal>
  )
}

/**
 * 标识色选择。
 *
 * 用固定色板而不是自由取色器：这些颜色取自 Fluent 调色板，在浅色与深色
 * 主题下都经过对比度校验。让用户随手挑一个 #ffff00，结果是深色模式下
 * 书脊几乎看不见 —— 给选择权不等于给所有选择权。
 */
function AccentPicker({ value, onChange }: { value?: string; onChange?: (value: string) => void }) {
  return (
    <div className="accent-picker">
      {BOOK_ACCENT_PRESETS.map((color) => (
        <button
          key={color}
          type="button"
          className={`accent-swatch${value === color ? ' accent-swatch--active' : ''}`}
          style={{ background: color }}
          aria-label={color}
          onClick={() => onChange?.(color)}
        />
      ))}
    </div>
  )
}

export type { BookFormValues }
