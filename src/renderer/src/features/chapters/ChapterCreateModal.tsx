import { useEffect } from 'react'
import { Form, Input, Modal, Select, Typography } from 'antd'
import {
  CHAPTER_LIMITS,
  CHAPTER_STATUSES,
  CHAPTER_STATUS_LABELS,
  type ChapterStatus
} from '@shared/modules/chapters'
import type { VolumeListItem } from '@shared/modules/volumes'
import { formatCount } from '../../lib/format'

const { Text } = Typography

export interface ChapterCreateValues {
  title: string
  volumeId: number | null
  status: ChapterStatus
}

interface ChapterCreateModalProps {
  open: boolean
  volumes: VolumeListItem[]
  /** 默认落在哪一卷。通常传当前正在编辑的那一章所属的卷 */
  defaultVolumeId: number | null
  /** 再往下数第几章，用来预填标题 */
  suggestTitle: string
  /** 书籍的「每章最少字数」，只用于在这里把规则讲清楚，不参与提交 */
  chapterWords: number
  submitting: boolean
  /**
   * 提交。**返回是否真的建成了**，由调用方决定关不关弹窗 ——
   * 失败时不能关：那样作者填好的标题、选好的分卷状态会一起消失，
   * 而失败提示只是一闪而过的浮条。
   *
   * 弹窗自己不关，因为它不知道外面那次写入成没成（confirmLoading 只表示
   * 「还在写」）。这个职责留在调用方，判据才是真的。
   */
  onSubmit: (values: ChapterCreateValues) => Promise<boolean>
  onCancel: () => void
}

const INITIAL: ChapterCreateValues = { title: '', volumeId: null, status: 'draft' }

/**
 * 新建章节。
 *
 * 为什么标题、分卷、状态要在这里一次填完：这三项原本摊在编辑器的
 * 「保存信息」一行里，作者每开一章都要在正文上方再操作一遍 —— 而它们
 * 恰恰是在「决定要写这一章」的那一刻就已经想清楚的事，等进了正文再填
 * 只是把选择推迟到注意力已经被消耗之后。
 *
 * 每章最少字数**不在这里填**：那是书籍级规则，在新建/编辑书籍时定一次、
 * 全书生效。这里只把它显示出来，让作者知道这一章照着什么标准写。
 */
export function ChapterCreateModal({
  open,
  volumes,
  defaultVolumeId,
  suggestTitle,
  chapterWords,
  submitting,
  onSubmit,
  onCancel
}: ChapterCreateModalProps) {
  const [form] = Form.useForm<ChapterCreateValues>()

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ ...INITIAL, volumeId: defaultVolumeId, title: suggestTitle })
  }, [defaultVolumeId, form, open, suggestTitle])

  return (
    <Modal
      open={open}
      title="新建章节"
      okText="创建并开始写"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => {
        void form.validateFields().then(onSubmit).catch(() => undefined)
      }}
      onCancel={onCancel}
      width={460}
      destroyOnHidden={false}
    >
      <Form form={form} layout="vertical" initialValues={INITIAL} requiredMark="optional">
        <Form.Item
          name="title"
          label="章节标题"
          rules={[
            { required: true, message: '章节标题不能为空' },
            { max: CHAPTER_LIMITS.title, message: `最多 ${CHAPTER_LIMITS.title} 个字符` }
          ]}
        >
          <Input placeholder="例如：第一章 出港" autoFocus data-testid="chapter-create-title" />
        </Form.Item>

        <Form.Item name="volumeId" label="所属分卷">
          <Select
            data-testid="chapter-create-volume"
            options={[
              { value: null, label: '未分卷' },
              ...volumes.map((volume) => ({ value: volume.id, label: volume.title }))
            ]}
          />
        </Form.Item>

        <Form.Item name="status" label="状态">
          <Select
            data-testid="chapter-create-status"
            options={CHAPTER_STATUSES.map((status) => ({
              value: status,
              label: CHAPTER_STATUS_LABELS[status]
            }))}
          />
        </Form.Item>
      </Form>

      <Text type="secondary" className="chapter-create__hint">
        本章最少 {formatCount(chapterWords)} 字（书籍设置里的「每章最少字数」，全书统一）。
        要改就在书籍详情页编辑书籍。
      </Text>
    </Modal>
  )
}
