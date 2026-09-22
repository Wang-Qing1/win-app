import { useEffect, useState } from 'react'
import {
  Descriptions,
  Divider,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography
} from 'antd'
import { CopyOutlined, DeleteOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons'
import {
  CARD_EXTRA_FIELDS,
  CARD_LIMITS,
  CARD_TYPES,
  CARD_TYPE_LABELS,
  normalizeExtra,
  normalizeTags,
  type Card,
  type CardExtra,
  type CardExtraField,
  type CardType
} from '@shared/modules/cards'
import { useToast } from '../../components/Toast'
import { IconButton } from '../../components/IconButton'
import { formatDateTime } from '../../lib/format'
import { CardChapterLinks } from './CardChapterLinks'
import { CardOutlineLinks } from './CardOutlineLinks'
import { CardRelations } from './CardRelations'
import { CARD_TYPE_COLORS, CARD_TYPE_ICONS } from './card-meta'

const { Text, Paragraph } = Typography

/**
 * 可编辑字段的草稿。
 *
 * 面板不碰数据层：保存、复制、删除都由页面（也就是持有 mutation 的那一层）
 * 去做。于是「改到一半切走」「保存失败后回到原值」都只涉及这一个 state，
 * 不会出现「面板已经改了、数据层没改」的中间态。
 */
export interface CardDraft {
  bookId: number | null
  cardType: CardType
  title: string
  subtitle: string
  content: string
  tags: string[]
  extra: CardExtra
}

function toDraft(card: Card): CardDraft {
  return {
    bookId: card.bookId,
    cardType: card.cardType,
    title: card.title,
    subtitle: card.subtitle,
    content: card.content,
    tags: [...card.tags],
    extra: { ...card.extra }
  }
}

/** 新建时的空草稿。type 与 bookId 由页面按当前筛选范围决定 */
export function emptyCardDraft(cardType: CardType, bookId: number | null): CardDraft {
  return {
    bookId,
    cardType,
    title: '',
    subtitle: '',
    content: '',
    tags: [],
    // 直接由共享层的字段表生成，新增字段时这里不用改
    extra: normalizeExtra(cardType, {})
  }
}

export interface CardEditorPanelProps {
  /** 已有卡片。为 null 时看 draftSeed */
  card: Card | null
  /**
   * 新建草稿。**必须是稳定引用**（页面放在 state 里），
   * 每次渲染都新建一个对象的话，下面的同步 effect 会把用户正在输入的内容冲掉
   */
  draftSeed: CardDraft | null
  /** 归属书籍下拉的选项。「通用」由 allowClear 清空表达，不占一个选项位 */
  bookOptions: Array<{ value: number; label: string }>
  onDuplicate: (card: Card) => Promise<void>
  onDelete: (card: Card) => Promise<void>
  onSave: (card: Card, draft: CardDraft) => Promise<void>
  onCreate: (draft: CardDraft) => Promise<void>
}

export function CardEditorPanel({
  card,
  draftSeed,
  bookOptions,
  onDuplicate,
  onDelete,
  onSave,
  onCreate
}: CardEditorPanelProps) {
  const toast = useToast()
  const [draft, setDraft] = useState<CardDraft | null>(null)
  const [busy, setBusy] = useState(false)

  /*
   * 换选中的卡片就重置草稿。
   *
   * 不重置的话，在 A 卡上改了一半的正文会被带到 B 卡，点保存就把 B
   * 覆盖成了 A 的内容 —— 而这种丢失是静默的，用户只会觉得「刚才写的东西不见了」。
   */
  useEffect(() => {
    setDraft(card !== null ? toDraft(card) : draftSeed)
  }, [card, draftSeed])

  if (draft === null) {
    return (
      <div className="cards-panel cards-panel--empty" data-testid="card-editor">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Flex vertical gap={6} align="center">
              <Text type="secondary">在左侧选一张卡片来编辑</Text>
              <Text type="secondary" className="cards-panel__hint">
                人物卡记身份与关系，物品卡记品阶与来源，灵感卡随手记想法，
                设定卡收地点 / 势力 / 规则体系 / 时间线。
              </Text>
            </Flex>
          }
        />
      </div>
    )
  }

  const isNew = card === null

  const dirty =
    isNew ||
    draft.bookId !== card.bookId ||
    draft.cardType !== card.cardType ||
    draft.title !== card.title ||
    draft.subtitle !== card.subtitle ||
    draft.content !== card.content ||
    // 标签用分隔符拼起来比较：数组直接 !== 永远为真，会让「有未保存改动」
    // 一直亮着，而按钮的 disabled 也就永远放开了
    draft.tags.join('\u0000') !== card.tags.join('\u0000') ||
    CARD_EXTRA_FIELDS[card.cardType].some(
      (field) => draft.extra[field.key] !== card.extra[field.key]
    )

  const canSave = draft.title.trim().length > 0 && (isNew || dirty)

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

  /**
   * 切换类型时立刻按新类型投影 extra。
   *
   * 用的是共享层的 `normalizeExtra` —— 与主进程写入前跑的是同一个函数。
   * 前端先跑一遍有两个好处：表单当场换成新类型的字段（旧字段的值不再
   * 留在面板里误导人），以及「界面显示什么」与「库里存什么」不可能不一致。
   * 主进程那边仍会再跑一次：界面可以被绕过，服务层才是唯一防线。
   */
  const changeType = (cardType: CardType): void => {
    setDraft({ ...draft, cardType, extra: normalizeExtra(cardType, draft.extra) })
  }

  // 显式标成宽类型：`CARD_EXTRA_FIELDS` 是 as const，没有 options 的那几项
  // 在字面量类型里也没有这个属性，直接 `field.options` 会报属性不存在
  const fields: readonly CardExtraField[] = CARD_EXTRA_FIELDS[draft.cardType]

  return (
    <div
      className="cards-panel"
      data-testid="card-editor"
      data-card-id={card?.id ?? 'new'}
      data-mode={isNew ? 'new' : 'edit'}
    >
      <Flex vertical gap={14}>
        <Flex justify="space-between" align="center" gap={8}>
          <Space size={6} wrap>
            {isNew ? (
              <Tag color="processing">新建</Tag>
            ) : (
              <Tag color={CARD_TYPE_COLORS[card.cardType]} icon={CARD_TYPE_ICONS[card.cardType]}>
                {CARD_TYPE_LABELS[card.cardType]}
              </Tag>
            )}
            <Text type="secondary" className="cards-panel__meta">
              {isNew ? '填好标题后保存' : `正文 ${card.content.length} 字符`}
            </Text>
          </Space>
          {card === null ? null : (
            /*
             * 面板头部右侧这一枚跟着统一成圆形图标按钮（用户 2026-09-20：
             * 「各个界面中的图标也要跟着改」）。它和下方表单区里的保存 / 还原
             * 不是一类：那两个是**表单动作**，文字得留着；这一枚是标题行上的操作，
             * 和书籍详情页卡片头里的「新建分卷」是同一形态。
             */
            <IconButton
              label="复制这张卡（复制一张同样的卡再改几笔）"
              icon={<CopyOutlined />}
              data-testid="card-duplicate"
              loading={busy}
              onClick={() => run(() => onDuplicate(card))}
            />
          )}
        </Flex>

        <label className="cards-field">
          <span className="cards-field__label">标题</span>
          <Input
            data-testid="card-title-input"
            value={draft.title}
            maxLength={CARD_LIMITS.title}
            placeholder="这张卡叫什么"
            autoFocus={isNew}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>

        <Flex gap={12} wrap>
          <label className="cards-field cards-field--grow">
            <span className="cards-field__label">类型</span>
            <Select
              data-testid="card-type-select"
              value={draft.cardType}
              onChange={changeType}
              options={CARD_TYPES.map((type) => ({
                value: type,
                label: CARD_TYPE_LABELS[type]
              }))}
            />
          </label>

          <label className="cards-field cards-field--grow">
            <span className="cards-field__label">归属书籍</span>
            <Select
              data-testid="card-book-select"
              value={draft.bookId}
              placeholder="通用（不归属任何书）"
              allowClear
              onChange={(value: number | null | undefined) =>
                setDraft({ ...draft, bookId: value ?? null })
              }
              options={bookOptions}
            />
          </label>
        </Flex>

        <label className="cards-field">
          <span className="cards-field__label">一句话简介</span>
          <Input
            value={draft.subtitle}
            maxLength={CARD_LIMITS.subtitle}
            placeholder="列表里只占一行，比截断正文更有信息量"
            onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })}
          />
        </label>

        <label className="cards-field">
          <span className="cards-field__label">标签</span>
          <Select
            data-testid="card-tags-input"
            mode="tags"
            value={draft.tags}
            placeholder="回车添加，或用逗号分隔"
            tokenSeparators={[',', '，']}
            maxCount={CARD_LIMITS.tagCount}
            // 与主进程用同一个规范化函数：否则会出现「输入时 3 个标签、
            // 保存后变 2 个」这种前后端规则不一致的现象
            onChange={(value: string[]) => setDraft({ ...draft, tags: normalizeTags(value) })}
          />
        </label>

        <Divider className="cards-panel__divider">
          {CARD_TYPE_LABELS[draft.cardType]}卡的专属字段
        </Divider>

        {/*
          专属字段由共享层的 CARD_EXTRA_FIELDS 驱动，新增类型或新增字段都不用
          改这里。带 `options` 的字段渲染成下拉（设定卡的「类别」就是）——
          类别是拿来聚合的，自由输入会写成「地点」「地名」两种说法。
        */}
        {/*
          hidden 字段不渲染：它们由别处写入（目前只有时间线序号），
          放进表单只会多出一个没人看得懂的数字输入框。
          值仍然留在 draft.extra 里，保存时一并回传 —— 否则改一次标题
          就会把这张卡排好的顺序清掉。
         */}
        {fields
          .filter((field) => field.hidden !== true)
          .map((field) => (
          <label className="cards-field" key={field.key}>
            <span className="cards-field__label">{field.label}</span>
            {field.options === undefined ? (
              <Input
                data-testid={`card-extra-${field.key}`}
                value={draft.extra[field.key] ?? ''}
                maxLength={CARD_LIMITS.extra}
                placeholder={field.placeholder}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    extra: { ...draft.extra, [field.key]: event.target.value }
                  })
                }
              />
            ) : (
              <Select
                data-testid={`card-extra-${field.key}`}
                value={draft.extra[field.key] ?? ''}
                placeholder={field.placeholder}
                allowClear
                options={field.options.map((option) => ({ value: option, label: option }))}
                onChange={(value: string | undefined) =>
                  setDraft({
                    ...draft,
                    extra: { ...draft.extra, [field.key]: value ?? '' }
                  })
                }
              />
            )}
          </label>
          ))}

        <label className="cards-field">
          <span className="cards-field__label">正文</span>
          <Input.TextArea
            data-testid="card-content-input"
            value={draft.content}
            autoSize={{ minRows: 6, maxRows: 18 }}
            maxLength={CARD_LIMITS.content}
            placeholder="细节、来历、想写的那场戏……随手记，回头再来整理"
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        </label>

        <Flex gap={8} align="center" wrap>
          <IconButton
            label={isNew ? '新建卡片' : '保存卡片'}
            icon={<SaveOutlined />}
            tone="primary"
            disabled={!canSave}
            loading={busy}
            data-testid="card-save"
            onClick={() =>
              run(async () => {
                if (card === null) await onCreate(draft)
                else await onSave(card, draft)
                toast.notifySuccess(isNew ? '已新建卡片' : '已保存')
              })
            }
          />
          <IconButton
            label="还原改动"
            icon={<UndoOutlined />}
            disabled={!dirty}
            onClick={() => setDraft(card === null ? draftSeed : toDraft(card))}
          />
          {dirty && !isNew ? (
            <Text type="warning" className="cards-panel__meta">
              有未保存的改动
            </Text>
          ) : null}
        </Flex>

        {card === null ? (
          <Paragraph type="secondary" className="cards-panel__hint">
            保存后会出现在左侧列表里，并自动选中。
          </Paragraph>
        ) : (
          <>
            {/*
             * 用 card.bookId 而不是 draft.bookId：关联的是**已经存下来的
             * 这张卡**，而它的归属只有在保存之后才算数。用草稿里的值，
             * 改了归属却还没保存就去关联章节，会按一本它还不属于的书
             * 去列章节。
             */}
            {/*
             * 关系排在章节 / 节点关联之前：前两块连的是「这条资料出现在
             * 故事的哪个位置」，关系连的是「它与另一条资料之间是什么」——
             * 后者更贴近这张卡本身，也是打开一张人物卡最常要看的东西。
             */}
            <CardRelations cardId={card.id} bookId={card.bookId} />

            <CardChapterLinks cardId={card.id} bookId={card.bookId} />

            {/* 节点侧与章节侧并列：一个是「写过的地方」，一个是「打算写的地方」 */}
            <CardOutlineLinks cardId={card.id} bookId={card.bookId} />

            <Divider className="cards-panel__divider">其它</Divider>

            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'created', label: '创建于', children: formatDateTime(card.createdAt) },
                { key: 'updated', label: '更新于', children: formatDateTime(card.updatedAt) },
                { key: 'id', label: '卡片 ID', children: `#${card.id}` }
              ]}
            />

            <Paragraph type="secondary" className="cards-panel__hint">
              同一本书、同一类型下标题不能重复 —— 两张看起来一样的卡片，删的时候很难分辨该删哪张。
            </Paragraph>

            <Popconfirm
              title="删除这张卡片？"
              description={
                card.tags.length > 0
                  ? `标签「${card.tags.join('、')}」也会一起消失，且无法撤销。`
                  : '删除后无法撤销。'
              }
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() =>
                run(async () => {
                  await onDelete(card)
                  toast.notifySuccess('已删除')
                })
              }
            >
              <IconButton
                tone="danger"
                label="删除卡片"
                icon={<DeleteOutlined />}
                data-testid="card-delete"
              />
            </Popconfirm>
          </>
        )}
      </Flex>
    </div>
  )
}
