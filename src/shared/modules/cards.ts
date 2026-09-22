import { z } from 'zod'

/**
 * 卡片库的领域契约。
 *
 * 四类卡片（人物 / 物品 / 灵感 / 设定）**共用一张 cards 表**，靠 card_type 列区分：
 * 它们的共性（标题、一句话简介、正文、标签、归属书籍）占了绝大部分，
 * 差异只有几个专属字段（人物有身份与关系、物品有品阶与来源）。
 * 专属字段放进 extra 这一列 JSON，于是四套增删改查只写一遍，
 * 将来加「地点」「势力」卡也不用动表结构、不用写迁移。
 *
 * 第四类「设定」是 2026-09-20 补上的（编辑器右侧竖栏里那一格当时挂着一个
 * 「第二期」的置灰项）：它记的是**世界观条目**，用 extra.category 区分
 * 地点 / 势力 / 规则体系 / 时间线 —— 而不是把四类拆成四种 card_type。
 * 拆成四种的话，每加一类就要动枚举、颜色、图标、筛选下拉、类型计数五处，
 * 而它们的字段与行为其实完全相同；做成「一类卡 + 一个类别字段」，
 * 新增类别只是往 SETTING_CATEGORIES 里加一个词。
 *
 * 这个选择的代价必须自己补上：**extra 里的字段没有数据库层面的约束**，
 * 一个字段名写错、或把人物卡的 extra 直接搬到物品卡上，SQLite 不会吭声。
 * 所以下面这张 CARD_EXTRA_FIELDS 表是唯一的字段来源，它同时驱动三件事：
 *   1. Zod 校验的字段形状（本文件）
 *   2. 编辑面板渲染哪些输入框（renderer）
 *   3. 类型切换时的字段迁移（service 的 normalizeExtra）
 * 一处新增字段，三处自动跟上 —— 这是统一建模能成立的前提。
 */

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

export const CARD_TYPES = ['character', 'item', 'inspiration', 'setting'] as const
export type CardType = (typeof CARD_TYPES)[number]

export const CARD_TYPE_LABELS: Record<CardType, string> = {
  character: '人物',
  item: '物品',
  inspiration: '灵感',
  setting: '设定'
}

/**
 * 设定卡的类别。
 *
 * 四类世界观条目共用「设定」这一种卡片：地点的写法是「在哪儿、什么规矩」，
 * 势力是「谁、图什么」，规则体系是「能做什么、代价是什么」，时间线是
 * 「什么时候发生了什么」—— 它们的结构一致（标题 + 一句话 + 正文 + 类别），
 * 只是**读的人关心的问题**不同。所以类别是一个字段，不是一种卡片类型。
 */
export const SETTING_CATEGORIES = ['地点', '势力', '规则体系', '时间线'] as const
export type SettingCategory = (typeof SETTING_CATEGORIES)[number]

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value)
}

export function isSettingCategory(value: unknown): value is SettingCategory {
  return typeof value === 'string' && (SETTING_CATEGORIES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 类型专属字段
 * ------------------------------------------------------------------ */

export interface CardExtraField {
  readonly key: string
  readonly label: string
  /** 隐藏字段没有输入框，也就不需要占位文案（见 hidden 的说明） */
  readonly placeholder?: string
  /**
   * 取值被限定在这几个选项里时，界面渲染成下拉而不是输入框。
   *
   * 用途是「这一栏填的是分类」而不是「这一栏填的是自由发挥的一句话」：
   * 类别要能按它聚合（四张地点卡凑成地理篇），自由输入会写成「地点」
   * 「地理位置」「地名」三种说法，聚合就废了。
   */
  readonly options?: readonly string[]
  /**
   * 只存值、不在表单里渲染。
   *
   * 给「界面不该让人手填、但数据要落在这张卡上」的字段用 —— 目前只有
   * 设定卡的时间线排序号：它由时间线视图的上下移动写入，手填一个数字
   * 既没有意义（作者关心的是先后，不是具体数值），也很容易填成重复值。
   *
   * 仍然登记在 CARD_EXTRA_FIELDS 里而不是绕过它：`normalizeExtra` 只保留
   * 这张表里登记过的键，绕过它的话，排序号会在下一次保存卡片时被丢掉。
   */
  readonly hidden?: boolean
}

/**
 * 每类卡片的专属字段。
 *
 * `as const` 是为了让 key 保持字面量类型（CardExtraKey 由它推导），
 * `satisfies` 是为了保证三类卡片都齐全 —— 漏掉一类会在编译期报错，
 * 而不是等到运行时 `CARD_EXTRA_FIELDS[type]` 返回 undefined。
 */
export const CARD_EXTRA_FIELDS = {
  /*
   * 人物卡的字段里**没有「关系」**：关系在第三期第 3 件改成了指向另一张
   * 卡的关联（card_relations 表），编辑面板下方有专门的一块。
   * 留一个纯文本字段的话，两边会各记一份互相矛盾的关系。
   */
  character: [
    { key: 'identity', label: '身份定位', placeholder: '如：星舰工程师 / 流亡贵族' },
    { key: 'affiliation', label: '所属阵营', placeholder: '如：星海联邦第七舰队' },
    { key: 'appearance', label: '外貌特征', placeholder: '如：左眉有一道旧疤' }
  ],
  item: [
    { key: 'grade', label: '品阶', placeholder: '如：传说级 / 一次性消耗品' },
    { key: 'origin', label: '来源', placeholder: '如：遗迹出土 / 主角自制' },
    { key: 'effect', label: '作用与代价', placeholder: '如：短距跃迁，冷却一整天' }
  ],
  inspiration: [
    { key: 'source', label: '灵感来源', placeholder: '如：一条新闻 / 一个梦' },
    { key: 'usage', label: '打算用在哪儿', placeholder: '如：第三卷的转折点' }
  ],
  setting: [
    { key: 'category', label: '设定类别', placeholder: '这条设定属于哪一类', options: SETTING_CATEGORIES },
    /*
     * 时点是**自由文本**而不是日期：虚构世界的计时方式五花八门
     * （星历 2103 年、霜降之月、开战前三天），强行套 ISO 日期只会让人
     * 把「星历 2103」写成 2103-01-01 然后自己都不信。排序另有一个隐藏的
     * 序号字段 —— 时点是给人看的，先后是给机器排的，两者分开。
     */
    { key: 'timePoint', label: '时点', placeholder: '如：星历 2103 年 / 开战前三天' },
    { key: 'order', label: '时间线序号', hidden: true }
  ]
} as const satisfies Record<CardType, readonly CardExtraField[]>

/** 设定卡「时点」的键。时间线视图与冒烟断言共用，避免各处写裸字符串 */
export const SETTING_TIME_POINT_KEY = 'timePoint'

/** 设定卡「时间线序号」的键。由时间线视图的上下移动写入，不出现在表单里 */
export const SETTING_ORDER_KEY = 'order'

/** 所有类型专属字段的键。用于把 extra 的键收在一个联合类型里 */
export type CardExtraKey = (typeof CARD_EXTRA_FIELDS)[CardType][number]['key']

/**
 * 类型专属字段的取值集合。
 *
 * 刻意用 `Record<string, string>` 而不是 `Partial<Record<CardExtraKey, string>>`：
 * 前者在 `normalizeExtra` 填充之后每个键都必然存在，索引时不带 `| undefined`，
 * 表单与面板里不必到处写 `?? ''`。键的合法范围由 CARD_EXTRA_FIELDS 与
 * normalizeExtra 保证，类型系统在这里帮不上更多忙 —— 与其给一个会骗人的
 * 精确类型，不如给一个诚实的宽类型 + 一处集中收敛。
 */
export type CardExtra = Record<string, string>

/**
 * 把任意的 extra 收敛成目标类型的字段集合。
 *
 * **这是统一建模里最关键的一个函数**：它同时做两件事 ——
 * 丢掉不属于该类型的键（人物卡改成物品卡后，旧的「身份定位」必须消失，
 * 否则数据里会留着一个永远不会被界面显示、但会被导出带走的幽灵字段），
 * 以及补齐缺失的键（老数据、手工改库、新增字段后都靠它兜底）。
 *
 * 写入与读取两侧都走它，因此「数据库里的 extra 一定是当前类型的完整字段集」
 * 这条不变式只有一处实现。
 *
 * 带 `options` 的字段额外做一步：**不在选项里的值一律回落成空串**。
 * 类别是要被聚合的，一个拼错的「地理」会永远聚合不到「地点」那一组里，
 * 而它看起来又完全正常（有值、能显示）。宁可让它空着 —— 空着是
 * 「这条还没分类」，一眼看得出来，错了却没人知道。
 */
export function normalizeExtra(type: CardType, raw: unknown): CardExtra {
  const source =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  /*
   * 显式标成宽类型再遍历：`CARD_EXTRA_FIELDS` 是 as const，每一项的字面量
   * 类型里只有自己写过的那几个属性，直接 `field.options` 会在「这一项没写
   * options」的分支上报「属性不存在」。而运行时它们本来就是同一类东西。
   */
  const fields: readonly CardExtraField[] = CARD_EXTRA_FIELDS[type]

  const extra: CardExtra = {}
  for (const field of fields) {
    const value = source[field.key]
    const text = typeof value === 'string' ? value.trim() : ''
    if (field.options !== undefined && text.length > 0 && !field.options.includes(text)) {
      extra[field.key] = ''
      continue
    }
    extra[field.key] = text
  }
  return extra
}

/**
 * 标签规范化：去首尾空白、丢掉空标签、去重。
 *
 * 放在共享层而不是服务层：前端在输入框里解析标签时也用同一份规则，
 * 否则会出现「输入时显示 3 个标签、保存后变成 2 个」的不一致。
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of tags) {
    const tag = raw.trim()
    if (tag.length === 0 || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }

  return result
}

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

export interface Card {
  id: number
  /** null 表示通用卡片（不归属任何书）—— 灵感常常如此 */
  bookId: number | null
  cardType: CardType
  title: string
  /** 一句话简介：列表里只占一行，比截断正文更有信息量 */
  subtitle: string
  content: string
  tags: string[]
  extra: CardExtra
  createdAt: string
  updatedAt: string
}

export interface CardListResult {
  items: Card[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  /**
   * 按类型计数，**忽略 cardType 这一项筛选**。
   *
   * 这是刻意的：若把类型筛选也算进去，选中「人物」之后另外两类的数字
   * 会全变成 0，「物品 0 张」会让人以为物品卡没了，而不是「被筛掉了」。
   * 它是一组导航用的计数，不是当前结果集的分解。
   */
  typeCounts: Record<CardType, number>
  /**
   * 设定卡按类别计数（忽略 settingCategory 这一项筛选）。
   *
   * 与 typeCounts 同理：它是导航用的数字，不是当前结果集的分解。
   * 只在按「设定」类型浏览时界面才读它。
   */
  settingCounts: Record<SettingCategory, number>
  /** 当前筛选条件下不归属任何书的卡片数，用于提示「其中通用 N 张」 */
  globalCount: number
}

export interface CardRemovalResult {
  id: number
  title: string
}

/* ------------------------------------------------------------------ *
 * 筛选与排序
 * ------------------------------------------------------------------ */

/**
 * 书籍筛选范围。
 *
 * 用三个值而不是「bookId 为 null 就是全部」：卡片允许不归属书籍，
 * 于是「全部书籍」与「只看通用卡片」是两种不同的查询，
 * 而它们都没法用 bookId 是数字还是 null 单独表达出来。
 */
export const CARD_BOOK_SCOPES = ['all', 'book', 'global'] as const
export type CardBookScope = (typeof CARD_BOOK_SCOPES)[number]

export const CARD_BOOK_SCOPE_LABELS: Record<CardBookScope, string> = {
  all: '全部书籍',
  book: '指定书籍',
  global: '仅通用卡片'
}

export function isCardBookScope(value: unknown): value is CardBookScope {
  return typeof value === 'string' && (CARD_BOOK_SCOPES as readonly string[]).includes(value)
}

export const CARD_SORT_FIELDS = ['updatedAt', 'createdAt', 'title'] as const
export type CardSortField = (typeof CARD_SORT_FIELDS)[number]

export const CARD_SORT_ORDERS = ['asc', 'desc'] as const
export type CardSortOrder = (typeof CARD_SORT_ORDERS)[number]

export function isCardSortField(value: unknown): value is CardSortField {
  return typeof value === 'string' && (CARD_SORT_FIELDS as readonly string[]).includes(value)
}

export function isCardSortOrder(value: unknown): value is CardSortOrder {
  return typeof value === 'string' && (CARD_SORT_ORDERS as readonly string[]).includes(value)
}

export function normalizeCardSortField(value: unknown): CardSortField {
  return isCardSortField(value) ? value : 'updatedAt'
}

export function normalizeCardSortOrder(value: unknown): CardSortOrder {
  return isCardSortOrder(value) ? value : 'desc'
}

/* ------------------------------------------------------------------ *
 * 字段与上限
 * ------------------------------------------------------------------ */

export const CARD_LIMITS = {
  title: 80,
  subtitle: 120,
  /** 单张卡片的正文上限。定成 5000 是因为它随列表一起返回（见 CardListResult 的说明） */
  content: 5000,
  tag: 24,
  tagCount: 12,
  /** 单个类型专属字段的上限。它们本来就是一行摘要，不该写成一段 */
  extra: 120
} as const

/* ------------------------------------------------------------------ *
 * 入参
 * ------------------------------------------------------------------ */

const cardBookScopeSchema = z.string().refine(isCardBookScope, '书籍筛选范围不合法')

function extraFieldSchema(label: string, options?: readonly string[]) {
  const base = z
    .string()
    .trim()
    .max(CARD_LIMITS.extra, `${label}最多 ${CARD_LIMITS.extra} 个字符`)
    .default('')

  // 枚举字段：空串是「还没分类」，合法；有值就必须是选项之一
  return options === undefined
    ? base
    : base.refine(
        (value) => value.length === 0 || options.includes(value),
        `${label}只能是：${options.join(' / ')}`
      )
}

/**
 * 按 CARD_EXTRA_FIELDS 生成某一类卡片的 extra 校验器。
 *
 * 动态生成而不是手写三段：手写就意味着「新增一个字段时可能只改了表、
 * 忘了改 schema」，而那样的漏改不会报错 —— 只会让新字段的输入被静默丢弃，
 * 用户填了却存不进去。
 */
function cardExtraSchemaFor(type: CardType) {
  // 同 normalizeExtra：先拓宽成 CardExtraField 再读 options
  const fields: readonly CardExtraField[] = CARD_EXTRA_FIELDS[type]
  const shape = Object.fromEntries(
    fields.map((field) => [field.key, extraFieldSchema(field.label, field.options)] as const)
  )
  return z.object(shape)
}

const cardIdField = z.number().int().positive('卡片 ID 非法')

const cardBaseShape = {
  /**
   * 归属书籍。显式 `.nullable()` 而不是只写 `.default(null)`：
   * `default` 只对 `undefined` 生效，拦不住 `null`，而「通用卡片」传的就是 null。
   */
  bookId: z.number().int().positive('书籍 ID 非法').nullable().default(null),

  title: z
    .string()
    .trim()
    .min(1, '卡片标题不能为空')
    .max(CARD_LIMITS.title, `卡片标题最多 ${CARD_LIMITS.title} 个字符`),

  subtitle: z
    .string()
    .trim()
    .max(CARD_LIMITS.subtitle, `一句话简介最多 ${CARD_LIMITS.subtitle} 个字符`)
    .default(''),

  content: z
    .string()
    .trim()
    .max(CARD_LIMITS.content, `卡片正文最多 ${CARD_LIMITS.content} 个字符`)
    .default(''),

  tags: z
    .array(z.string().trim().min(1).max(CARD_LIMITS.tag, `单个标签最多 ${CARD_LIMITS.tag} 个字符`))
    .max(CARD_LIMITS.tagCount, `最多 ${CARD_LIMITS.tagCount} 个标签`)
    .default([])
}

/**
 * 新建卡片。
 *
 * 用 discriminated union 按 cardType 分支，而不是让 extra 自己带一个
 * 类型标记字段：客户端只需要写一次类型，校验器就知道该收哪些专属字段。
 * 分支里没声明的键会被 Zod 剥掉 —— 也就是说「给物品卡塞一个身份定位」
 * 在 IPC 边界就被拦下了，根本走不到服务层。
 */
export const cardCreateSchema = z.discriminatedUnion('cardType', [
  z.object({
    ...cardBaseShape,
    cardType: z.literal('character'),
    extra: cardExtraSchemaFor('character')
  }),
  z.object({
    ...cardBaseShape,
    cardType: z.literal('item'),
    extra: cardExtraSchemaFor('item')
  }),
  z.object({
    ...cardBaseShape,
    cardType: z.literal('inspiration'),
    extra: cardExtraSchemaFor('inspiration')
  }),
  z.object({
    ...cardBaseShape,
    cardType: z.literal('setting'),
    extra: cardExtraSchemaFor('setting')
  })
])

export type CardCreateInput = z.infer<typeof cardCreateSchema>

/** 更新是整体替换：表单本来整体提交，避免「部分字段 undefined 该不该覆盖」的歧义 */
export const cardUpdateSchema = z.discriminatedUnion('cardType', [
  z.object({
    ...cardBaseShape,
    id: cardIdField,
    cardType: z.literal('character'),
    extra: cardExtraSchemaFor('character')
  }),
  z.object({
    ...cardBaseShape,
    id: cardIdField,
    cardType: z.literal('item'),
    extra: cardExtraSchemaFor('item')
  }),
  z.object({
    ...cardBaseShape,
    id: cardIdField,
    cardType: z.literal('inspiration'),
    extra: cardExtraSchemaFor('inspiration')
  }),
  z.object({
    ...cardBaseShape,
    id: cardIdField,
    cardType: z.literal('setting'),
    extra: cardExtraSchemaFor('setting')
  })
])

export type CardUpdateInput = z.infer<typeof cardUpdateSchema>

export const cardIdSchema = z.object({
  id: cardIdField
})

export type CardIdInput = z.infer<typeof cardIdSchema>

/**
 * 列表查询。
 *
 * `cardType` 与书本页的 `status` 同样的处理：空串与 null 都表示「不筛选」。
 * 只写 z.string() 的话，默认（未选类型）那一次查询会每次都被边界拒掉，
 * 而前端会把它降级成空列表 —— 页面照常渲染、断言全绿、数据是空的。
 */
export const cardListQuerySchema = z.object({
  bookScope: cardBookScopeSchema.default('all'),
  bookId: z.number().int().positive('书籍 ID 非法').nullable().default(null),
  cardType: z.union([z.string().trim(), z.null()]).default(''),
  settingCategory: z.union([z.string().trim(), z.null()]).default(''),
  keyword: z.string().trim().max(CARD_LIMITS.title, '搜索关键词过长').default(''),
  page: z.number().int().min(1, '页码非法').default(1),
  pageSize: z.number().int().min(1, '每页条数非法').max(200, '每页最多 200 条').default(60),
  sortBy: z.string().default('updatedAt'),
  sortOrder: z.string().default('desc')
})

export type CardListQueryInput = z.infer<typeof cardListQuerySchema>

export interface CardListQuery {
  bookScope: CardBookScope
  /** 仅当 bookScope 为 'book' 时有意义 */
  bookId: number | null
  /** null 表示不按类型筛选 */
  cardType: CardType | null
  /**
   * null 表示不按类别筛选。
   *
   * 只有设定卡的 extra 里有 category 键，所以这一项**隐含了「只看设定卡」** ——
   * 界面上选类别时会顺手把类型定成设定，否则「人物 + 地点」会查出一片空白，
   * 而空白看起来跟「这本书还没有设定」一模一样。
   */
  settingCategory: SettingCategory | null
  keyword: string
  page: number
  pageSize: number
  sortBy: CardSortField
  sortOrder: CardSortOrder
}

export function normalizeCardListQuery(input: CardListQueryInput): CardListQuery {
  const scope = isCardBookScope(input.bookScope) ? input.bookScope : 'all'

  return {
    // 「要看某本书」却没说哪本：降级为全部，而不是查出一片空白。
    // 前端切换下拉的中间态会短暂产生这种组合，此时报错没有意义
    bookScope: scope === 'book' && input.bookId === null ? 'all' : scope,
    bookId: scope === 'book' ? input.bookId : null,
    // 非法类型值静默降级为「不筛选」，与书籍列表对 status 的处理一致
    cardType: isCardType(input.cardType) ? input.cardType : null,
    settingCategory: isSettingCategory(input.settingCategory) ? input.settingCategory : null,
    keyword: input.keyword,
    page: input.page,
    pageSize: input.pageSize,
    sortBy: normalizeCardSortField(input.sortBy),
    sortOrder: normalizeCardSortOrder(input.sortOrder)
  }
}

/* ------------------------------------------------------------------ *
 * 设定卡时间线（第三期第 2 件）
 * ------------------------------------------------------------------ */

export const TIMELINE_LIMITS = {
  /** 一次能重排多少张。设定卡的数量级是几十条，200 是宽容的上限不是预期值 */
  items: 200
} as const

/**
 * 设定卡在时间线上的序号。
 *
 * 没排过序（空串 / 非法值）返回 **null 而不是 0**：0 是一个合法序号
 * （排在最早），「还没排过」与「排在第一位」必须分得开 —— 否则新建的
 * 设定卡会一出现就插到时间线最前面，把作者排好的顺序挤乱。
 */
export function timelineOrderOf(card: Card): number | null {
  const raw = card.extra[SETTING_ORDER_KEY]
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * 时间线重排。
 *
 * 一次提交**整组顺序**而不是「把 A 移到 B 后面」：后者的语义要依赖
 * 服务层当前的排序状态，客户端与服务端的顺序一旦不一致（比如另一个窗口
 * 刚改过），移动的结果就会错位；而整组提交是幂等的 —— 同样的顺序
 * 提交两次结果相同，中间夹杂别的改动也不会累积偏差。
 */
export const cardTimelineOrderSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法').nullable().default(null),
  category: z.union([z.string().trim(), z.null()]).default(''),
  orderedIds: z
    .array(z.number().int().positive('卡片 ID 非法'))
    .max(TIMELINE_LIMITS.items, `一次最多排 ${TIMELINE_LIMITS.items} 张设定卡`)
})

export type CardTimelineOrderRawInput = z.infer<typeof cardTimelineOrderSchema>

export interface CardTimelineOrderInput {
  bookId: number | null
  /** null 表示不校验类别（时间线视图可能横跨各类别） */
  category: SettingCategory | null
  orderedIds: number[]
}

export function normalizeTimelineOrder(input: CardTimelineOrderRawInput): CardTimelineOrderInput {
  return {
    bookId: input.bookId,
    category: isSettingCategory(input.category) ? input.category : null,
    orderedIds: input.orderedIds
  }
}

export const DEFAULT_CARD_QUERY: CardListQuery = {
  bookScope: 'all',
  bookId: null,
  cardType: null,
  settingCategory: null,
  keyword: '',
  page: 1,
  pageSize: 60,
  sortBy: 'updatedAt',
  sortOrder: 'desc'
}
