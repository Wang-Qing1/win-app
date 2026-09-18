import { z } from 'zod'

/** 分卷模块的领域契约。分卷是书籍下的一级容器，用于把章节分组（第一卷、第二卷…）。 */

export interface Volume {
  id: number
  bookId: number
  title: string
  summary: string
  orderIndex: number
  createdAt: string
  updatedAt: string
}

/** 分卷列表项带上聚合信息，避免前端为每个卷再查一次章节数 */
export interface VolumeListItem extends Volume {
  chapterCount: number
  hanziCount: number
}

export const VOLUME_LIMITS = {
  title: 80,
  summary: 1000,
  /** 同一本书内的分卷数量上限。防止误操作生成成千上万个卷把界面拖垮 */
  perBook: 200
} as const

const volumeFields = {
  title: z
    .string()
    .trim()
    .min(1, '分卷名称不能为空')
    .max(VOLUME_LIMITS.title, `分卷名称最多 ${VOLUME_LIMITS.title} 个字符`),
  summary: z.string().trim().max(VOLUME_LIMITS.summary, `分卷简介最多 ${VOLUME_LIMITS.summary} 个字符`)
}

export const volumeCreateSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  title: volumeFields.title,
  summary: volumeFields.summary.default('')
})

export type VolumeCreateInput = z.infer<typeof volumeCreateSchema>

export const volumeUpdateSchema = z.object({
  id: z.number().int().positive('分卷 ID 非法'),
  title: volumeFields.title,
  summary: volumeFields.summary
})

export type VolumeUpdateInput = z.infer<typeof volumeUpdateSchema>

export const volumeIdSchema = z.object({
  id: z.number().int().positive('分卷 ID 非法')
})

export type VolumeIdInput = z.infer<typeof volumeIdSchema>

export const volumeListQuerySchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法')
})

export type VolumeListQueryInput = z.infer<typeof volumeListQuerySchema>

/**
 * 重排：一次提交整个容器内的新顺序。
 *
 * 不用「上移/下移一格」这种增量接口：拖拽落点往往跨越多行，
 * 增量接口需要调用方连续发很多次请求，中途失败会留下半截顺序。
 * 一次提交完整顺序，服务端在一个事务里重写 order_index，要么全对要么全不变。
 */
export const volumeReorderSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  orderedIds: z.array(z.number().int().positive()).max(VOLUME_LIMITS.perBook, '分卷数量超出上限')
})

export type VolumeReorderInput = z.infer<typeof volumeReorderSchema>
