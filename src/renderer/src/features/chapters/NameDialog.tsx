import { useCallback, useEffect, useState } from 'react'
import { Button, Flex, Modal, Segmented, Tag, Typography } from 'antd'
import { CopyOutlined, ImportOutlined, ReloadOutlined } from '@ant-design/icons'
import { useToast } from '../../components/Toast'
import {
  NAME_GENDERS,
  NAME_GENDER_LABELS,
  NAME_STYLES,
  NAME_STYLE_LABELS,
  generateNames,
  readTakenNames,
  rememberTakenName,
  type NameGender,
  type NameStyle,
  type NameSuggestion
} from './name-generator'

const { Text } = Typography

/** 一批给多少个候选。12 个正好铺满 3×4，再多就变成「选择困难」而不是「给灵感」 */
const BATCH_SIZE = 12

interface NameDialogProps {
  open: boolean
  onClose: () => void
  /** 把选中的名字插到正文光标处 */
  onInsert: (name: string) => void
}

/**
 * 取名器。
 *
 * 交互上最重要的一点是「换一批」要快：取名的心理过程是「扫一眼、不满意、
 * 再来一批」，而不是逐个体检式地评估。所以候选以卡片密集排列，
 * 换一批不做任何过渡动画，点一下立刻是新的一屏。
 */
export function NameDialog({ open, onClose, onInsert }: NameDialogProps) {
  const { notifySuccess } = useToast()
  const [style, setStyle] = useState<NameStyle>('modern')
  const [gender, setGender] = useState<NameGender>('male')
  const [length, setLength] = useState<1 | 2>(2)
  const [names, setNames] = useState<NameSuggestion[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [taken, setTaken] = useState<string[]>([])

  const regenerate = useCallback((): void => {
    setNames(generateNames({ style, gender, length, count: BATCH_SIZE }))
    setSelected(null)
  }, [style, gender, length])

  // 条件变化就重来一批：让「风格」这类开关的反馈是立即的，
  // 否则用户改完还要再点一次「换一批」，多一步毫无必要的操作
  useEffect(() => {
    if (!open) return
    setTaken(readTakenNames())
    setNames(generateNames({ style, gender, length, count: BATCH_SIZE }))
    setSelected(null)
  }, [open, style, gender, length])

  const handleCopy = useCallback(
    async (name: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(name)
        rememberTakenName(name)
        setTaken(readTakenNames())
        notifySuccess(`已复制「${name}」`)
      } catch {
        // 剪贴板权限被拒时不要静默失败，否则用户会以为按钮坏了
        notifySuccess(`已选中「${name}」，但复制到剪贴板失败`)
      }
    },
    [notifySuccess]
  )

  const handleInsert = useCallback((): void => {
    if (selected === null) return
    onInsert(selected)
    rememberTakenName(selected)
    notifySuccess(`已插入「${selected}」`)
    onClose()
  }, [notifySuccess, onClose, onInsert, selected])

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      title="取名"
    >
      <Flex vertical gap={14} data-testid="name-dialog">
        <Flex align="center" gap={8} wrap>
          <Text type="secondary" className="name-dialog__label">
            风格
          </Text>
          <Segmented
            size="small"
            value={style}
            options={NAME_STYLES.map((item) => ({ value: item, label: NAME_STYLE_LABELS[item] }))}
            onChange={(value) => setStyle(value as NameStyle)}
          />
          <Text type="secondary" className="name-dialog__label">
            性别
          </Text>
          <Segmented
            size="small"
            value={gender}
            options={NAME_GENDERS.map((item) => ({ value: item, label: NAME_GENDER_LABELS[item] }))}
            onChange={(value) => setGender(value as NameGender)}
          />
          <Text type="secondary" className="name-dialog__label">
            字数
          </Text>
          <Segmented
            size="small"
            value={length}
            options={[
              { value: 1, label: '单字' },
              { value: 2, label: '双字' }
            ]}
            onChange={(value) => setLength(value as 1 | 2)}
          />
        </Flex>

        <div className="name-grid" data-testid="name-grid">
          {names.map((item) => {
            const usedBefore = taken.includes(item.full)
            return (
              <button
                key={item.full}
                type="button"
                className={`name-card${selected === item.full ? ' name-card--active' : ''}`}
                onClick={() => setSelected(item.full)}
                onDoubleClick={() => void handleCopy(item.full)}
              >
                <span className="name-card__full">{item.full}</span>
                {usedBefore ? (
                  <Tag className="tag--flush name-card__tag" color="warning">
                    用过
                  </Tag>
                ) : null}
              </button>
            )
          })}
        </div>

        <Text type="secondary" className="name-dialog__hint">
          单击选中，双击复制。「用过」的标记存在本机，避免同一本书里出现两个同名角色。
        </Text>

        <Flex gap={8} justify="space-between">
          <Button icon={<ReloadOutlined />} onClick={regenerate}>
            换一批
          </Button>
          <Flex gap={8}>
            <Button
              icon={<CopyOutlined />}
              disabled={selected === null}
              onClick={() => selected !== null && void handleCopy(selected)}
            >
              复制
            </Button>
            <Button
              type="primary"
              icon={<ImportOutlined />}
              disabled={selected === null}
              onClick={handleInsert}
            >
              插入到正文
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </Modal>
  )
}
