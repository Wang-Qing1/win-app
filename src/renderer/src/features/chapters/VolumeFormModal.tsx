import { useEffect } from 'react'
import { Form, Input, Modal } from 'antd'
import { VOLUME_LIMITS } from '@shared/modules/volumes'
import type { VolumeListItem } from '@shared/modules/volumes'

export interface VolumeFormValues {
  title: string
  summary: string
}

interface VolumeFormModalProps {
  open: boolean
  /** null = 新建；非 null = 编辑这一卷 */
  volume: VolumeListItem | null
  submitting: boolean
  /**
   * 提交。**返回是否真的写成了**，由调用方决定关不关弹窗 ——
   * 失败时不能关：作者填好的名字会跟着一起消失，而失败提示只是
   * 一闪而过的浮条（与 ChapterCreateModal 同一条约定）。
   */
  onSubmit: (values: VolumeFormValues) => Promise<boolean>
  onCancel: () => void
}

const INITIAL: VolumeFormValues = { title: '', summary: '' }

/**
 * 新建 / 编辑分卷弹窗。
 *
 * 以前新建卷是目录栏里的一小条行内输入、改名是行内再换一条输入框
 * （用户 2026-09-20：「新建/编辑卷也要是弹窗的形式」）。收进弹窗的理由：
 *
 * - 目录栏只有 184px 宽，行内输入挤掉了章节标题的宽度；弹窗不占布局。
 * - 分卷其实有**两个字段**（名称 + 简介），简介在行内那条小输入框里
 *   根本放不下 —— 以前等于把简介这个字段整个藏没了。
 * - 新建与编辑共用一个弹窗，两种入口不会长成两种样子。
 *
 * 弹窗由目录栏持有（而不是编辑页）：两个入口（头部「新建卷」圆钮、
 * 分卷行右键菜单「重命名分卷」）都在目录栏里，弹窗跟入口走最近。
 */
export function VolumeFormModal({ open, volume, submitting, onSubmit, onCancel }: VolumeFormModalProps) {
  const [form] = Form.useForm<VolumeFormValues>()
  const editing = volume !== null

  useEffect(() => {
    if (!open) return
    form.setFieldsValue(
      editing ? { title: volume.title, summary: volume.summary } : INITIAL
    )
  }, [editing, form, open, volume])

  return (
    <Modal
      open={open}
      title={editing ? `编辑分卷「${volume.title}」` : '新建分卷'}
      okText={editing ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ 'data-testid': 'volume-modal-ok' }}
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
          label="分卷名称"
          rules={[
            { required: true, message: '分卷名称不能为空' },
            { max: VOLUME_LIMITS.title, message: `最多 ${VOLUME_LIMITS.title} 个字符` }
          ]}
        >
          <Input placeholder="例如：第一卷 出海" autoFocus data-testid="volume-title-input" />
        </Form.Item>

        <Form.Item
          name="summary"
          label="简介（可不填）"
          rules={[{ max: VOLUME_LIMITS.summary, message: `最多 ${VOLUME_LIMITS.summary} 个字符` }]}
        >
          <Input.TextArea
            placeholder="这一卷讲什么、写到哪儿算一卷"
            autoSize={{ minRows: 3, maxRows: 8 }}
            data-testid="volume-summary-input"
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
