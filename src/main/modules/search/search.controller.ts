import { IpcChannel } from '@shared/ipc-channels'
import { normalizeSearchQuery, searchQuerySchema } from '@shared/modules/search'
import { registerHandler } from '../../core/ipc-handler'
import type { SearchService } from './search.service'

/** 控制器层：解析请求 → 调用服务 → 返回结果。不含业务判断，也不吞异常。 */
export function registerSearchHandlers(service: SearchService): void {
  registerHandler(IpcChannel.SearchQuery, {
    label: '全库检索',
    /*
     * 与列表类查询一样是两步：先按 schema 收口长度与类型，
     * 再跑一遍解读规则。切词放在 normalizeSearchQuery 里 ——
     * 它必须与渲染进程高亮用的实现是同一个函数，否则会出现
     * 「界面显示搜了 3 个词、后端只搜了 2 个」这种对不上的情况。
     */
    parse: (raw) => normalizeSearchQuery(searchQuerySchema.parse(raw ?? {})),
    handle: (query) => service.query(query)
  })
}
