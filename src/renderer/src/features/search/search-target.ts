import type { SearchHit } from '@shared/modules/search'

/**
 * 检索结果 → 「点开它该去哪儿」。
 *
 * 单独成一个模块而不是写在组件里，是因为这段映射里有几处**必须一致**的约定，
 * 而它们跨了三个页面：
 *   - 章节要把「命中哪一段」通过查询参数带给编辑器（`find` + `at`），
 *     参数名与编辑器读取时必须逐字相同，写错的表现是「跳过去了但没定位」；
 *   - 卡片与大纲要把「选中哪一条」带给目标页面，用的是各自已有的查询参数名。
 * 把它们集中在这里，改一处就能同时看到四个来源的落点。
 */

export interface HitTarget {
  /** 目标路由（含查询参数） */
  path: string
  /** 目标页面里应当被选中 / 定位的对象 id —— 冒烟测试用它验证「真的打开了这一条」 */
  focus: number
}

export function targetOf(hit: SearchHit): HitTarget | null {
  switch (hit.source) {
    case 'chapter': {
      /*
       * 章节必然属于某本书（chapters.book_id 是 NOT NULL），
       * 但类型上仍是可空的。为 null 时返回 null 而不是拼一个 /books/null/... ——
       * 后者会让用户在地址里看到 null，并落到一个「书不存在」的错误页。
       */
      if (hit.bookId === null) return null

      /*
       * `find` 带的是**锚点关键词**而不是片段，`at` 是主进程算出的偏移。
       *
       * 两者都要带：编辑器不能直接相信这个偏移 —— 主进程搜的是库里的
       * content_text，编辑器手里的是自己从 TipTap 文档算出的纯文本，
       * 两套投影的换行约定并不完全一致（列表类结构会差字符）。
       * 因此编辑器拿关键词在自己文档里重新找全部出现位置，再用 at
       * 挑出离它最近的那一次。关键词负责「找得到」，偏移负责「是哪一次」。
       */
      const params = new URLSearchParams()
      params.set('find', hit.anchor)
      params.set('at', String(hit.offset))
      return {
        path: `/books/${hit.bookId}/chapters/${hit.id}?${params.toString()}`,
        focus: hit.id
      }
    }

    case 'card':
      // 通用卡片不属于任何书，卡片库的默认范围本来就是「全部书籍」，因此不需要带 bookId
      return { path: `/cards?cardId=${hit.id}`, focus: hit.id }

    case 'outline':
      // 大纲树是按书查的，必须把书一起带上，否则目标页面只能靠本地记忆猜一本书
      if (hit.bookId === null) return null
      return { path: `/outline?bookId=${hit.bookId}&nodeId=${hit.id}`, focus: hit.id }

    case 'book':
      return { path: `/books/${hit.id}`, focus: hit.id }
  }
}
