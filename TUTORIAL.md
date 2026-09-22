# winbook 上手教程

一份**从技术栈到自定义编码**的阅读材料。

> **与 README 的分工**
>
> | 文档 | 回答的问题 | 读者的用法 |
> |---|---|---|
> | `README.md` | 「**为什么**这样定」——设计决策、被否掉的方案、踩过的坑 | 当参考手册查，或评审时论证 |
> | `TUTORIAL.md`（本文） | 「**是什么 / 怎么跑 / 怎么改**」——技术栈全貌、调用链路、动手步骤 | 从头读一遍，然后照着第 9 章改代码 |
>
> 本文不重复 README 的论证过程，但会把每个结论落到**具体文件与具体代码**上。
> 遇到想深挖的「为什么」，文中的箭头会指向 README 的对应章节。

---

## 目录

- [1 技术栈：这套组合是怎么搭起来的](#1-技术栈这套组合是怎么搭起来的)
- [2 跑起来：五分钟从零到改代码](#2-跑起来五分钟从零到改代码)
- [3 进程模型：三个进程 + 一条边界](#3-进程模型三个进程--一条边界)
- [4 一次请求的完整生命周期](#4-一次请求的完整生命周期)
- [5 分层详解](#5-分层详解)
- [6 数据层](#6-数据层)
- [7 前端架构](#7-前端架构)
- [8 关键子系统导读](#8-关键子系统导读)
- [9 自定义编码手册](#9-自定义编码手册)
- [10 约定速查](#10-约定速查)
- [11 质量门与打包发布](#11-质量门与打包发布)
- [附录 A 文件地图](#附录-a-文件地图)
- [附录 B 命令速查](#附录-b-命令速查)
- [附录 C 术语表](#附录-c-术语表)
- [附录 D 按难度的源码阅读顺序](#附录-d-按难度的源码阅读顺序)

---

## 1 技术栈：这套组合是怎么搭起来的

winbook 是一个 **Windows 11 桌面端小说写作应用**：本地优先（全部数据在自己机器上的一个 SQLite 文件里）、离线可用、不依赖任何后端服务。

代码规模：**155 个 `.ts` / `.tsx` 文件，约 37,400 行**（其中冒烟测试 10,140 行，占总量的 27%）。

### 1.1 一张表看全

| 层 | 技术 | 版本 | 在本项目里扮演什么 | 关键文件 |
|---|---|---|---|---|
| **运行时宿主** | Electron | `^44.4.1` | 提供主进程 / 渲染进程 / preload 三进程模型 | `src/main/index.ts` |
| **构建工具** | electron-vite | `^5.0.0` | 一个配置同时构建三个目标（main / preload / renderer） | `electron.vite.config.ts` |
| | Vite | `^7.3.6` | 底层打包器 + 开发期 HMR | 同上 |
| **语言** | TypeScript | `^7.0.2` | `strict` 全开，另有 8 项额外严格开关 | `tsconfig.base.json` |
| **UI 框架** | React | `^19.3.0` | 渲染进程的全部界面 | `src/renderer/src/App.tsx` |
| **组件库** | Ant Design | `^6.6.4` | 表格 / 表单 / 弹窗 / 树等重型组件 | `src/renderer/src/theme/tokens.ts` |
| | @ant-design/icons | `^6.3.4` | 图标 | 各页面 |
| | @ant-design/plots | `^2.6.8` | 统计页的趋势图与热力图 | `features/stats/` |
| **路由** | react-router | `^8.4.0` | HashRouter（见 [7.2](#72-路由)） | `src/renderer/src/App.tsx` |
| **服务端状态** | TanStack React Query | `^5.103.1` | 缓存、失效、乐观更新、重试策略 | `lib/query-client.ts`、`lib/query-keys.ts` |
| **表单/边界校验** | Zod | `^4.6.5` | **一份 schema 同时用于主进程边界与前端表单** | `src/shared/modules/*.ts` |
| **富文本** | TipTap | `^3.31.3` | 正文编辑器（基于 ProseMirror） | `features/chapters/RichTextEditor.tsx` |
| **数据库** | better-sqlite3 | `^13.0.3` | 同步 API 的嵌入式 SQLite，进程内直接读写 | `src/main/db/` |
| **单元测试** | Vitest | `^5.0.1` | 纯函数与仓储的测试，node 环境 | `vitest.config.ts` |
| **端到端自检** | 自研冒烟测试 | — | 真主进程 + 真 SQLite + 真渲染进程 | `src/main/smoke-test.ts` |
| **打包** | electron-builder | `^26.15.3` | NSIS 安装包 + 免安装版 | `electron-builder.yml` |

### 1.2 三个版本约束（不满足就直接装不上 / 编不过）

这三条是实测出来的硬约束，**升级依赖前必须先看这里**：

**① TypeScript 7 移除了 `baseUrl`。**
`paths` 必须写成相对路径，否则报 `TS5090` + `TS5102`：

```jsonc
// tsconfig.base.json —— 正确写法
"paths": {
  "@shared/*": ["./src/shared/*"],      // 相对路径，不能配 baseUrl
  "@renderer/*": ["./src/renderer/src/*"]
}
```

**② Vite 8 与 electron-vite 5 不兼容。**
electron-vite 5 的 peer 依赖只到 Vite 7。必须锁 `vite@^7` + `@vitejs/plugin-react@^5`，否则 `npm install` 报 `ERESOLVE`。

**③ better-sqlite3 ≥ 13 不需要按 Electron 重编译。**
它发布 **N-API 预编译产物**（包内自带 `prebuilds/`），ABI 跨 Node / Electron 稳定。因此 `electron-builder.yml` 里必须：

```yaml
asarUnpack:
  - '**/*.node'                        # 原生模块不能留在 asar 里
  - node_modules/better-sqlite3/**
npmRebuild: false                      # 关键：别让 electron-builder 去重新编译
```

开了 `npmRebuild` 的话，`electron-builder install-app-deps` 会因为包里带了 `binding.gyp` 而**误判**成需要源码编译，在没有 Python / MSVC 的机器上必然失败。

> 如果 `npm install` 卡住很久：`.npmrc` 已把源指向国内镜像（`registry.npmmirror.com` + Electron 二进制镜像）。删掉 `.npmrc` 可恢复官方源。

### 1.3 为什么是这套组合（三段话）

- **Electron 而不是 Tauri / 纯 Web**：需要「本地文件 + 无网络 + 富文本编辑器 + 系统文件对话框」。Electron 的 `dialog.showSaveDialog`、`better-sqlite3` 的同步读写都在主进程里直接可用，不用自己搭服务。
- **better-sqlite3 而不是 Prisma / 一个服务端数据库**：它是**同步** API，而主进程的 IPC handler 本来就是 async 的 —— 同步 SQL 让「事务里连着做几件事」变成普通的顺序代码，没有 callback 地狱，也天然避免了「await 中途事务被别人插队」。详细权衡见 README「数据」一节。
- **React Query 而不是 Redux / Zustand**：这个应用的数据几乎全是**服务端状态**（数据库里的东西），本地 UI 状态很少且都可以用 `useState` 解决。React Query 的失效机制正好对上「写完一章要让书架、统计页一起刷新」的需求。详见 [7.3](#73-react-query键与失效)。

---

## 2 跑起来：五分钟从零到改代码

### 2.1 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | `>=20.19.0` | `package.json` 的 `engines` 里写死 |
| 操作系统 | Windows 11 | 代码里保留了 `darwin` 分支，但只在 Windows 上验证过 |
| GPU | 无要求 | 无显卡环境见下面的 `WINBOOK_DISABLE_GPU` |

### 2.2 四条命令

```bash
npm install          # 装依赖（已配置国内镜像，约几分钟）
cp .env.example .env # 可选：本地覆盖配置。.env 已在 .gitignore 里
npm run dev          # 开发模式：HMR + DevTools
npm run smoke        # 端到端自检：116 项断言，退出码 0 表示全通
```

**第一次跑 `npm run dev` 如果应用启动即崩溃**，且日志里有 `GPU process isn't usable. Goodbye.`（退出码 3），在 `.env` 里设 `WINBOOK_DISABLE_GPU=true`。虚拟机 / 远程桌面 / 无独显的机器上几乎必然遇到。原理见 [3.1](#31-各进程能做什么)。

### 2.3 目录地图

```
winbook/
├── src/
│   ├── shared/          ★ 唯一契约来源：跨进程共用的类型、Zod schema、纯函数
│   │   ├── modules/        每个业务模块一个文件（books / chapters / cards / outline / ...）
│   │   ├── api.ts          preload 暴露给渲染进程的 API 形状（WinbookApi）
│   │   ├── ipc-channels.ts IPC 通道名单一来源（60 个）
│   │   ├── result.ts       IpcResponse 信封 + 错误码定义
│   │   ├── text.ts         ★ 汉字计数与 HTML→文本，主进程与渲染进程共用
│   │   ├── datetime.ts     本地日期键等时间工具
│   │   └── proofread.ts    校对规则引擎（纯函数）
│   │
│   ├── main/            主进程：唯一能碰数据库与系统 API 的地方
│   │   ├── index.ts        ★ 启动编排 + 优雅停机
│   │   ├── config/env.ts   ★ 环境变量集中校验（快速失败）
│   │   ├── core/          errors / ipc-handler / logger / request-id
│   │   ├── db/            connection / migrator / migrations / sql-utils
│   │   ├── ipc/registry.ts ★ 组合根：手工装配所有依赖
│   │   ├── window/       主窗口创建 + 生产环境安全策略
│   │   ├── modules/      按功能组织，每个模块 controller → service → repository
│   │   └── smoke-test.ts 端到端自检（10,140 行）
│   │
│   ├── preload/index.ts    ★ 唯一的跨进程桥：显式白名单
│   │
│   └── renderer/        渲染进程：React 应用
│       ├── index.html
│       └── src/
│           ├── main.tsx / App.tsx / styles.css
│           ├── components/   AppShell / AppHeader / 通用小件
│           ├── features/     每个业务模块一个目录（页面 + hooks）
│           ├── hooks/        跨模块通用 hooks
│           ├── lib/          ★ api-client / query-client / query-keys
│           └── theme/        设计令牌 + 主题 Provider
│
├── build/               图标等构建资源
├── scripts/             generate-icons.cjs
├── out/                 构建产物（electron-vite 输出，已 gitignore）
├── release/             electron-builder 输出（安装包，已 gitignore）
├── electron.vite.config.ts ★ 三目标的构建配置
├── tsconfig.base.json   ★ 编译器开关与路径别名
├── vitest.config.ts
└── electron-builder.yml 打包配置
```

打星号（★）的是一开始就该读的十个文件。

### 2.4 六个 npm script

| 命令 | 做什么 | 什么时候用 |
|---|---|---|
| `npm run dev` | electron-vite 开发模式，渲染进程有 HMR | 日常开发 |
| `npm run typecheck` | 跑 `typecheck:node` + `typecheck:web`，即三份 tsconfig 全查一遍 | 每次改完代码 |
| `npm test` | Vitest 单测（130 项，node 环境） | 改了纯函数或仓储时 |
| `npm run smoke` | 构建 + 用**临时目录**跑真主进程，执行 116 项断言 | 提交前、发版前 |
| `npm run build` | typecheck + 构建到 `out/` | 打包前 |
| `npm run dist:win` | 构建 + 出 NSIS 安装包与 portable 版到 `release/` | 要发给别人时 |

`npm run smoke` 的退出码就是结果：**0 = 全通，1 = 有失败项**。它用 `mkdtempSync` 建临时 userData 目录，**绝不碰你真实的 `winbook.db`**（见 `src/main/index.ts:23-27`）。

---

## 3 进程模型：三个进程 + 一条边界

### 3.1 各进程能做什么

```
┌─────────────────────────────────────────────────────────────────┐
│  主进程 (Node.js 环境)                                            │
│  src/main/                                                       │
│  · 读写 SQLite（better-sqlite3）                                  │
│  · 系统 API：文件对话框、窗口、菜单、剪贴板                          │
│  · 业务规则、事务、校验、日志                                       │
│  · 注册 60 个 IPC handler                                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │  ipcMain.handle / ipcRenderer.invoke
                            │  （结构化克隆，只传可序列化的数据）
┌───────────────────────────┴─────────────────────────────────────┐
│  preload（唯一有双向权限的脚本）                                   │
│  src/preload/index.ts                                            │
│  · contextBridge.exposeInMainWorld('winbook', api)                │
│  · 只暴露一份显式白名单：没有 ipcRenderer 本体、没有 Node API        │
└───────────────────────────┬─────────────────────────────────────┘
                            │  window.winbook.*
┌───────────────────────────┴─────────────────────────────────────┐
│  渲染进程 (Chromium 环境)                                         │
│  src/renderer/                                                   │
│  · React 19 + antd 6 + TipTap                                    │
│  · 拿不到 require / process / fs —— 只能通过 window.winbook 说话   │
└─────────────────────────────────────────────────────────────────┘
```

窗口的关键四项配置（`src/main/window/main-window.ts:96-105`）：

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,   // 渲染进程与 preload 的 JS 上下文隔离
  nodeIntegration: false,   // 渲染进程里没有 require
  sandbox: true,            // 渲染进程连 Node 的底层都摸不到
  webSecurity: true,
  spellcheck: false
}
```

**这四项是本项目的安全底线，改动前先想清楚攻击面。**

### 3.2 为什么渲染进程不能直接读数据库

三个理由，按重要性排：

1. **安全**：渲染进程要运行 HTML 与富文本。正文是从外部粘贴进来的（网页、Word），一旦有注入，攻击者就能直接读写用户的整个数据库文件。
2. **正确性**：`better-sqlite3` 是 Node 原生模块，加载进渲染进程需要关掉 `sandbox`，等于把上面第 1 条彻底作废。
3. **单一事实源**：汉字数、章节顺序、级联删除这类规则如果两边都能算，迟早算出两个不一样的答案。所有派生值只由主进程产生（见 [10.1](#101-十六条硬约定) 约定 9–10）。

### 3.3 preload 的白名单

`src/preload/index.ts` 里只有一个对象，形如：

```ts
const api: WinbookApi = {
  version: BRIDGE_VERSION,        // '12'，协议版本
  books: {
    list: (query) => ipcRenderer.invoke(IpcChannel.BooksList, query),
    get: (input) => ipcRenderer.invoke(IpcChannel.BooksGet, input),
    // ...
  },
  // ...其余模块
}

contextBridge.exposeInMainWorld(WINBOOK_BRIDGE_KEY, api)
```

三点值得注意：

- **通道名来自 `IpcChannel` 常量**，不允许出现裸字符串。改名时如果漏改，会静默产生「通道不存在」的运行时错误。
- **所有方法返回 `IpcResponse` 信封（`{ok, data}` / `{ok, error}`）而不是抛异常**。跨 `contextBridge` 传 `Error` 实例语义不可靠，所以拆信封的职责放在渲染进程侧（`lib/api-client.ts`）。
- **`version` 是协议版本号**，渲染进程可以读它判断自己是否跑在预期版本的宿主上，避免「壳是旧的、前端是新的」这种升级期错配。**每次改 `WinbookApi` 形状都要在这里加一行版本说明并递增**。

---

## 4 一次请求的完整生命周期

这是全文最重要的一节。理解这一条线，剩下的都是它的变体。

### 4.1 主线：「打开书架页，列出书籍」

以 `books.list` 为例，从用户点进 `/books` 到表格渲染出来，一共 **11 跳**：

```
 ① BooksPage 组件渲染
      const query = { keyword: '', status: null, page: 1, ... }
      const { data, isPending, error } = useBookList(query)
        │
 ② React Query 查缓存
      键 = queryKeys.books.list(query)
      命中且未过期（staleTime 15s）→ 直接用，链路结束
      未命中 → 调用 queryFn
        │
 ③ queryFn: () => invoke(() => getBridge().books.list(query))
      getBridge() 取 window.winbook（preload 注入的那个对象）
        │
 ④ preload: books.list(query)
      → ipcRenderer.invoke('books:list', query)
      —— 这里是渲染进程能到达的最远处。参数被结构化克隆。
        │
════════ 跨进程边界 ════════
        │
 ⑤ 主进程 ipcMain.handle('books:list') 的包装器
      （由 core/ipc-handler.ts 的 registerHandler 注册，见下方代码）
      a. createRequestId()   → 生成本次调用的追踪 ID
      b. parse(rawInput)     → Zod 校验 + 归一化，非法立刻抛 ZodError
      c. handle(input, ctx)  → 调用控制器传进来的那个函数
      d. 包成 { ok: true, data }
        │
 ⑥ book.controller.ts 的 handler
      handle: (query) => service.list(query)
      —— 只有这一行。没有业务逻辑，不吞异常。
        │
 ⑦ BookService.list(query)
      return this.repository.list(query)
      —— 本例没有业务规则，纯转发。
        │
 ⑧ BookRepository.list(query)
      a. 拼 WHERE 条件（keyword / status）
      b. 先 COUNT(*) 拿总数，算 pageCount 与 safePage（越界页码夹回最后一页）
      c. 跑带聚合子查询的 SELECT 拿当页数据
      d. 行 → BookListItem 映射（toBookListItem）
        │
 ⑨ 原路返回：{ ok: true, data: BookListResult }
════════ 回到渲染进程 ════════
        │
 ⑩ api-client.ts 的 invoke()
      response.ok === true  → return response.data
        │
 ⑪ React Query 把结果按 ② 的键写进缓存 → 组件拿到 data 渲染
```

### 4.2 每一跳的代码

**⑤ 是整条链路的枢纽**，它把 RequestId、校验、错误收敛、日志全做完了，业务代码完全不用管：

```ts
// src/main/core/ipc-handler.ts（节选）
export function registerHandler<TInput, TResult>(
  channel: string,
  definition: HandlerDefinition<TInput, TResult>
): void {
  if (registeredChannels.has(channel)) {
    throw new Error(`IPC 通道重复注册：${channel}`)   // 重复注册直接炸，不静默覆盖
  }
  registeredChannels.add(channel)

  ipcMain.handle(channel, async (event, rawInput): Promise<IpcResponse<TResult>> => {
    const requestId = createRequestId()
    const startedAt = Date.now()
    const baseFields = { requestId, channel, label: definition.label, origin: ... }

    try {
      const input = definition.parse ? definition.parse(rawInput) : (rawInput as TInput)
      const data = await definition.handle(input, { requestId, channel, event })
      logger.debug('IPC 调用完成', { ...baseFields, durationMs: Date.now() - startedAt })
      return { ok: true, data }                    // ← 成功信封
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      // 预期内错误按 warn，内部错误按 error（带堆栈，只进日志）
      // ...
      return { ok: false, error: payload }         // ← 失败信封
    }
  })
}
```

**⑥ 控制器薄到什么程度**，看 `book.controller.ts` 全文的核心：

```ts
export function registerBookHandlers(service: BookService): void {
  registerHandler(IpcChannel.BooksList, {
    label: '查询书籍列表',
    parse: (raw) => normalizeBookListQuery(bookListQuerySchema.parse(raw ?? {})),
    handle: (query) => service.list(query)
  })

  registerHandler(IpcChannel.BooksCreate, {
    label: '新增书籍',
    parse: (raw) => bookCreateSchema.parse(raw),
    handle: (input) => service.create(input)
  })
  // ...每个通道 5 行
}
```

注意 `parse` 里做的是**两件事**：`parse` 校验 + `normalize...` 归一化。

- **校验**：类型对不对、长度超没超、值在不在枚举里。
- **归一化**：把「IPC 能传过来的形状」收敛成「服务层期望的形状」。比如 `sortBy: z.string()` 允许任意字符串（因为 IPC 那头可能传来的是个旧的非法值），归一化时再把它映射成 `'updatedAt'` 并**静默降级**——非法排序字段不该让整个书架页打不开。

**⑧ 仓储里唯一允许写 SQL**，看它的关键手法：

```ts
// src/main/modules/books/book.repository.ts（节选）

// 手法 A：防 N+1 —— 一条 SQL 带出聚合，而不是每本书再查一次
const AGGREGATE_JOINS = `
  LEFT JOIN (SELECT book_id, COUNT(*) AS volume_count FROM volumes GROUP BY book_id) v
         ON v.book_id = b.id
  LEFT JOIN (SELECT book_id, COUNT(*) AS chapter_count,
                    SUM(hanzi_count) AS hanzi_count,
                    MAX(updated_at)  AS last_edited_at
               FROM chapters GROUP BY book_id) c
         ON c.book_id = b.id
`
// 刻意用两个独立子查询而不是两次 JOIN：两个一对多同时 JOIN 会产生笛卡尔积，
// 章节会被按分卷数重复累加，SUM(hanzi_count) 于是虚高。各自先聚合再关联，从根上避免。

// 手法 B：排序白名单 —— 绝不把客户端字符串拼进 SQL
const SORT_COLUMN: Record<BookSortField, string> = {
  title: 'b.title COLLATE NOCASE',
  createdAt: 'b.created_at',
  updatedAt: 'b.updated_at',
  hanziCount: 'hanzi_count'
}
// ...
//   ORDER BY ${SORT_COLUMN[sortBy]} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}

// 手法 C：LIKE 转义统一走共享工具
params.keyword = containsPattern(keyword)   // src/main/db/sql-utils.ts
// SQL 里配 ... LIKE @keyword ESCAPE '\'
```

**手法 D：行 → 领域对象的映射收在一个函数里**，包括脏数据的兜底：

```ts
function toBook(row: BookRow): Book {
  return {
    status: (BOOK_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as BookStatus)
      : 'idea',        // 理论上不可能越界（写入侧有 Zod），但脏数据不该让前端崩掉
    // ...
  }
}
```

**⑩ 拆信封**在渲染进程侧：

```ts
// src/renderer/src/lib/api-client.ts
export async function invoke<T>(call: () => Promise<IpcResponse<T>>): Promise<T> {
  let response: IpcResponse<T>
  try {
    response = await call()
  } catch {
    // 主进程重启、通道被移除时 ipcRenderer.invoke 会直接 reject
    throw new ApiError({ code: 'INTERNAL_ERROR', message: '与主进程通信失败，请重启 winbook 后重试', requestId: '-' })
  }
  if (response.ok) return response.data
  throw new ApiError(response.error)
}
```

### 4.3 失败路径

同一条链路上失败时，**错误形态只有三种**，全都收敛成 `IpcResponse` 的失败分支：

| 触发点 | 抛什么 | 谁转成信封 | 前端拿到 |
|---|---|---|---|
| 入参非法（Zod 校验不过） | `ZodError` | `toErrorPayload` in `ipc-handler.ts` | `VALIDATION_ERROR` + `issues[]`（字段级） |
| 业务规则不过（找不到 / 冲突） | `AppError.notFound` / `.conflict` | 同上 | `NOT_FOUND` / `CONFLICT` + 可读文案 |
| 意料之外的异常 | 任意 `Error` | 同上 | `INTERNAL_ERROR` + 通用文案 + `requestId`，**堆栈只进日志** |

五类错误码定义在 `src/shared/result.ts`：

```ts
export type AppErrorCode =
  | 'VALIDATION_ERROR'   // 调用方问题，前端不应重试
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'     // 服务端内部，前端可有限重试
  | 'UNKNOWN'
```

前端拿到后：

```ts
// ApiError 自带两个便利方法
error.retryable          // 只有 INTERNAL_ERROR / UNKNOWN 才 true
error.fieldErrors()      // { 'title': '书名不能为空' } —— 直接喂给 antd Form 的 errors
```

React Query 的重试策略就挂在 `retryable` 上（`lib/query-client.ts`）：

```ts
queries: {
  retry: (failureCount, error) => isRetryableError(error) && failureCount < 3,
  retryDelay: (attempt) => Math.min(600 * 2 ** attempt, 6000),   // 指数退避，封顶 6s
  staleTime: 15_000,
  refetchOnWindowFocus: false     // 桌面应用窗口切换极频繁，聚焦就重取只会制造无谓请求
},
mutations: {
  retry: false                    // 写操作一律不自动重试：可能造成重复写入
}
```

**这套「信封 + 单一错误类型」的设计有一个不明显的收益**：`useQuery` 的 `error` 永远只有一个类型 `ApiError`，组件里写 `toUserMessage(error)` 就够了，不需要 `instanceof` 分支树。

---

## 5 分层详解

```
IPC handler（控制器）  →  Service（业务）  →  Repository（数据）
   解析与校验              业务规则与事务        SQL 与行映射
```

一条**唯一契约来源**贯穿三层：`src/shared/modules/<模块>.ts`。

### 5.1 `src/shared` —— 唯一契约来源

这是整个架构的支点。**改一个字段，前端会直接编译失败，而不是运行时才报错。**

一个模块文件的固定解剖结构（以 `cards` 之外的简单模块为例，看 `books.ts`）：

```ts
// src/shared/modules/books.ts

/* ① 枚举：用 as const 数组 + 类型推导 + 类型守卫，三件套 */
export const BOOK_STATUSES = ['idea', 'serializing', 'paused', 'completed'] as const
export type BookStatus = (typeof BOOK_STATUSES)[number]
export const BOOK_STATUS_LABELS: Record<BookStatus, string> = {
  idea: '构思中', serializing: '连载中', paused: '已暂停', completed: '已完结'
}
export function isBookStatus(value: unknown): value is BookStatus {
  return typeof value === 'string' && (BOOK_STATUSES as readonly string[]).includes(value)
}

/* ② 实体：与数据库列一一对应，用 camelCase 而不是 snake_case */
export interface Book { id: number; title: string; /* ... */ }

/* ③ 列表项：实体 + 聚合出来的信息。刻意带上统计而不是让前端逐本再查一次 */
export interface BookListItem extends Book {
  volumeCount: number
  chapterCount: number
  hanziCount: number
  lastEditedAt: string | null
}

/* ④ 常量：所有上限集中在一处，注释解释来由 */
export const BOOK_LIMITS = {
  title: 80, penName: 40, genre: 24, summary: 2000,
  targetWords: 100_000_000, chapterWords: 1_000_000
} as const

/* ⑤ 字段定义：抽成一份可复用的对象，create / update 各取所需 */
const bookFields = {
  title: z.string().trim().min(1, '书名不能为空').max(BOOK_LIMITS.title, `书名最多 ${BOOK_LIMITS.title} 个字符`),
  // ...
}

/* ⑥ 入参 schema：主进程边界校验 + 前端表单校验，同一份 */
export const bookCreateSchema = z.object({
  title: bookFields.title,
  penName: bookFields.penName.default(''),
  // ...
})
export type BookCreateInput = z.infer<typeof bookCreateSchema>   // 类型也从 schema 推

/* ⑦ 归一化函数：把 IPC 形状收敛成服务层形状，非法值静默降级 */
export function normalizeBookListQuery(input: BookListQueryInput): BookListQuery { /* ... */ }

/* ⑧ 默认值：导出给前端当表单初值 */
export const DEFAULT_BOOK_QUERY: BookListQuery = { /* ... */ }
```

**为什么枚举用 `z.string().refine()` 而不是 `z.enum()`**：一是要自定义中文错误信息，二是避开 Zod 各版本在「枚举 + 自定义 message」上的写法差异。

**`ChapterListItem` vs `Chapter` 的取舍**（`src/shared/modules/chapters.ts`）：

```ts
/** 章节元数据。列表接口返回的就是它，不含正文 */
export interface ChapterListItem { id: number; title: string; hanziCount: number; /* ... */ }

/** 章节详情，带正文 */
export interface Chapter extends ChapterListItem {
  contentHtml: string
  contentText: string
}
```

一本书的正文可能有几十上百万字。列表顺手带正文的话，书架每翻一页就要序列化几 MB 字符串过 IPC。**分两个类型的成本是「多写一个 interface」，收益是整个列表性能。**

> **对比**：`cards:list` 就**刻意连正文一起返回**（`src/shared/api.ts:205-212`），因为一张卡正文上限 5000 字符、一页 60 张最坏 300KB，换来的是点开卡片不用再发一次请求、也不会闪空表单。**同一个问题在量级不同时答案相反**——这类判断在本文里会反复出现。

### 5.2 Repository —— 唯一写 SQL 的地方

职责只有两件：**执行 SQL** 与**行 ↔ 领域对象映射**。不含任何业务判断。

一个典型的仓储长这样（`book.repository.ts`）：

```ts
export class BookRepository {
  constructor(private readonly db: Db) {}

  list(query: BookListQuery): BookListResult { /* 拼条件 → COUNT → SELECT → 映射 */ }
  findById(id: number): Book | null { /* ... */ }
  findByTitle(title: string, excludeId?: number): Book | null { /* 业务唯一性校验用 */ }
  exists(id: number): boolean { /* 只查 SELECT 1，不拉整行 */ }
  insert(input: BookCreateInput, now: string): Book { /* INSERT 后回读，保证返回的是真实落库值 */ }
  update(input: BookUpdateInput, now: string): Book | null { /* changes === 0 → null */ }
  touch(id: number, now: string): void { /* 只动 updated_at */ }
  deleteById(id: number): boolean { /* returns changes > 0 */ }
  countAll(): number
  stats(): BookStats { /* 多表 COUNT/SUM 聚合 */ }
}
```

几条反复出现的手法：

| 手法 | 为什么 |
|---|---|
| `insert` 后立刻 `findById(lastInsertRowid)` 回读 | 返回给前端的是**数据库真实值**（含 DEFAULT 填充的列），不是入参的回声 |
| `update` 用 `result.changes === 0` 判「没改到」 | SQLite 不会因为 WHERE 没匹配到就报错 |
| `exists()` 用 `SELECT 1` | 校验存在性不需要拉回整行，尤其章节那种带几十万字正文的表 |
| `touch()` 单独一个方法 | 章节保存后必须碰一下书，否则书架按 `updated_at` 排序时，用户写了三万字但书还停在创建那一刻的位置 |
| `run` 用**具名参数** (`@title`) 而不是 `?` | 有十几个字段的 INSERT 用位置参数，加一个字段就全部错位 |

`insert` 的具名参数写法：

```ts
this.db.prepare(`
  INSERT INTO books (title, pen_name, genre, status, /* ... */ created_at, updated_at)
  VALUES (@title, @penName, @genre, @status, /* ... */ @createdAt, @updatedAt)
`).run({
  title: input.title, penName: input.penName, /* ... */
  createdAt: now, updatedAt: now
})
```

### 5.3 Service —— 业务规则与事务

**Service 刻意不依赖任何 Electron / IPC 类型**，因此可以直接用真实数据库做集成测试，也可以在将来挂到别的传输层（HTTP、CLI）上而不用改一行代码。

> 唯一的例外是 `exporter` 与 `backup`：它们要弹系统文件对话框，必须拿 Electron 的 `dialog`。所以这两个模块被单独隔离出来，让 `chapters` 那套核心服务保持「可脱离 Electron 单测」的性质。见 `export.service.ts` 的类注释。

Service 的三件事：

**① 事务边界**。多步写入必须包在 `runInTransaction` 里：

```ts
// src/main/modules/books/book.service.ts
create(input: BookCreateInput): Book {
  return runInTransaction(() => {
    if (this.repository.findByTitle(input.title)) {
      throw AppError.conflict(`已存在同名书籍「${input.title}」，请换一个书名`)
    }
    const created = this.repository.insert(input, new Date().toISOString())
    logger.info('书籍已创建', { id: created.id })
    return created
  })
}
```

> **不用 `async`**：`better-sqlite3` 的 `transaction()` 是同步的，任何异常自动回滚。写成 async 会在 `await` 处让出线程，别的请求可能插进来，事务语义就破了。所以 Service 里凡是碰事务的方法**一律是同步函数**。

**② 业务规则**。以 `ChapterService.saveContent` 为例，注释写得比代码长，这是本项目的风格：

```ts
saveContent(input: ChapterSaveContentInput): ChapterSaveResult {
  return runInTransaction(() => {
    const existing = this.repository.findById(input.id)
    if (!existing) throw AppError.notFound(`章节不存在（ID: ${input.id}）`)

    // 只转一次文本：measureHtml 内部也要走一遍 htmlToText，两者都调用等于把同一份 HTML 解析两次
    const contentText = htmlToText(input.contentHtml)
    const metrics = measureText(contentText)
    const now = new Date().toISOString()

    // 留快照必须在覆盖之前，此时 existing 里还是旧正文
    const snapshotKept = this.keepSnapshot(existing, now)

    const saved = this.repository.saveContent(input, {
      contentText, hanziCount: metrics.hanzi, charCount: metrics.characters
    }, now)

    if (!saved) throw AppError.internal(`章节正文保存失败（ID: ${input.id}）`)

    this.bookRepository.touch(existing.bookId, now)     // 让书架按「最近写作」排序
    return saved
  })
}
```

**③ 复用其它仓储，而不是各写一套**。这是保持口径唯一的关键：

```ts
// src/main/modules/outline/outline.service.ts
constructor(
  private readonly repository: OutlineRepository,
  private readonly bookRepository: BookRepository,
  private readonly chapterRepository: ChapterRepository,
  /** 「落地成章节」复用章节服务，而不是自己往 chapters 表插一行。
   *  章节创建的规则（标题处理、字数初始化、分卷归属校验、书籍 touch）
   *  都在那里，另写一份迟早会与它漂移。 */
  private readonly chapterService: ChapterService
) {}
```

### 5.4 Controller —— 只解析与调用

见 [4.2](#42-每一跳的代码)。三条铁律：

- 不写业务逻辑（「书本不存在」交给 Service 判，因为只有 Service 知道哪种语境该抛 `NOT_FOUND`）。
- 不吞异常（异常交给 IPC 边界统一翻译）。
- 每个 handler 都带 `label`（人类可读名称，写进日志，出问题时能定位到具体功能）。

### 5.5 `registry.ts` —— 组合根

所有依赖**手工装配**在这一个文件里（`src/main/ipc/registry.ts`）：

```ts
export function registerAllIpcHandlers(config: AppConfig): void {
  const db = getDatabase()

  /* ---------------- 仓储（跨模块共享） ---------------- */
  const bookRepository = new BookRepository(db)
  const chapterRepository = new ChapterRepository(db)
  const chapterRevisionRepository = new ChapterRevisionRepository(db)
  // ...共 8 个仓储

  /* ---------------- 服务 ---------------- */
  const bookService = new BookService(bookRepository, db)
  const chapterService = new ChapterService(
    chapterRepository, bookRepository, volumeRepository, chapterRevisionRepository
  )
  const statsService = new StatsService(bookRepository, chapterRepository, sessionRepository)
  const searchService = new SearchService(searchRepository)
  // ...共 11 个服务

  /* ---------------- 控制器 ---------------- */
  registerBookHandlers(bookService)
  registerChapterHandlers(chapterService)
  // ...共 12 组
}
```

**为什么不引入 DI 容器**：桌面应用规模下，手写装配比容器更透明——谁依赖谁一眼可见，出问题只需要看这一个文件。

**注意仓储是单例复用的**：统计模块刻意不自己写 SQL，而是复用书籍、章节、会话三个仓储，因此**统计口径只有一份实现**。这也是为什么这里先建仓储、再建服务，而不是每个模块各自建一套。

---

## 6 数据层

### 6.1 迁移

**位置**：`src/main/db/migrations/index.ts`，目前 9 条（`001` – `009`）。

**执行器**：`src/main/db/migrator.ts`。逻辑很短，三条要点：

```ts
export function runMigrations(db: Db): { applied: string[]; current: string | null } {
  // ① 迁移记录表独立于业务表，因此可以在业务 DDL 之前安全创建
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL
  );`)

  const appliedNames = new Set(/* SELECT name FROM schema_migrations */)

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) continue
    try {
      // ② 每条迁移与它的记录写入放在同一个事务里 —— 要么都成功，要么都不发生
      db.transaction(() => {
        migration.up(db)
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run(migration.name, new Date().toISOString())
      })()
      logger.info('迁移已应用', { name: migration.name })
    } catch (error) {
      // ③ 失败即整条回滚，不会留下半成品 schema
      logger.error('迁移执行失败，已回滚', { name: migration.name, error })
      throw AppError.internal(`数据库迁移失败：${migration.name}`, error)
    }
  }
  // ...
}
```

**三条写迁移的规矩**（写在 `migrations/index.ts` 文件头上，务必遵守）：

**规矩一：只允许在末尾追加，已发布的条目禁止修改。**

已发布的迁移改动后，老用户的库**不会重新执行**。只有新增迁移才能保证「新装」与「升级」两条路径得到同一个 schema。看第 3 条迁移的实际做法：

```ts
{
  name: '003_drop_contacts',
  up(db) {
    // contacts 是脚手架阶段的示例模块，小说助手不需要它。
    // 单独一条迁移而不是回改 001：已发布的迁移改动后，老用户的库不会重新执行，
    // 只有新增迁移才能保证「新装」与「升级」两条路径得到同一个 schema。
    db.exec('DROP TABLE IF EXISTS contacts;')
  }
}
```

**规矩二：只对结构性不变式加 CHECK，不对枚举值域加。**

```ts
// ✅ 结构性不变式：非空、非负、取值范围
CHECK (length(trim(title)) > 0)
CHECK (target_words >= 0)

// ❌ 不要写：枚举值域
// CHECK (status IN ('idea','serializing','paused','completed'))
```

原因：**SQLite 无法 `ALTER` 一个已有的 CHECK**，改枚举值域必须走重建表流程。而枚举（书本状态、卡片类型、大纲节点类型）恰恰是最容易随需求扩张的部分。枚举值域由 `src/shared` 的 Zod schema 在 IPC 边界强制，两侧同一份定义。

**规矩三：迁移可以带数据搬迁，不只是建表。**

第 8 条迁移就是例子：人物卡旧的「与主角关系」是一行纯文本（`extra.relationship`），改成关系表之后，`normalizeExtra` 只保留登记过的键——**不动它的话，作者写过的那段关系会在下一次保存这张卡时无声消失**。所以迁移里把这段文本搬到正文末尾：

```ts
{
  name: '008_card_relations',
  up(db) {
    db.exec(`CREATE TABLE card_relations ( /* ... */ CHECK (card_id < related_id) );`)

    // 一次性搬迁：文本里没有指向哪张卡，没法自动转成关联，所以搬到正文末尾，
    // 让作者在下一次打开这张卡时看见自己记过什么，再手动建成结构化关系。
    const legacy = db.prepare(
      `SELECT id, content, json_extract(extra, '$.relationship') AS text
         FROM cards
        WHERE card_type = 'character' AND json_valid(extra)
          AND COALESCE(json_extract(extra, '$.relationship'), '') <> ''`
    ).all()
    // ...逐行 UPDATE
  }
}
```

> **写迁移时的自问**：这次改动会不会让用户已有的数据**变成看不见的东西**？JSON 列里删键、枚举值域收窄、必填字段新增——这三类都会。

### 6.2 连接与 pragma

`src/main/db/connection.ts`。四个 pragma **不是可选项**：

```ts
const db = new Database(file)
db.pragma('journal_mode = WAL')      // 读写并发不互相阻塞，桌面场景多窗口时很关键
db.pragma('synchronous = NORMAL')    // WAL 下的安全档位，兼顾性能与掉电安全
db.pragma('foreign_keys = ON')       // ★ SQLite 默认关闭外键约束，必须显式打开
db.pragma('busy_timeout = 5000')     // 遇到写锁时等待而不是立刻抛 SQLITE_BUSY
```

**`foreign_keys = ON` 尤其重要**：本项目大量依赖 `ON DELETE CASCADE` 做级联删除（删书 → 连带删分卷、章节、大纲节点、卡片、历史版本）。**这一条不打开，级联全部失效，删书会留下一堆孤儿行。**

数据库文件位置：`app.getPath('userData')/winbook.db`，即 `%APPDATA%\winbook\winbook.db`。

事务封装成一个函数，业务代码只写 `runInTransaction(() => { ... })`：

```ts
export function runInTransaction<T>(fn: () => T): T {
  return getDatabase().transaction(fn)()
}
```

优雅停机时会 `wal_checkpoint(TRUNCATE)` 再 `close()`，把 WAL 里的内容合并回主文件。

### 6.3 冗余派生字段与不变式

`chapters` 表里正文相关的列有四个：

| 列 | 内容 | 谁在用 |
|---|---|---|
| `content_html` | 富文本编辑器的真正来源 | 编辑器、导出（不含样式） |
| `content_text` | 它的纯文本投影 | 全文搜索、导出草稿 |
| `hanzi_count` | 汉字数（主口径） | 列表、统计页、进度条 |
| `char_count` | 非空白字符数 | 与网文平台对照 |

**为什么冗余存一份纯文本**（迁移里的原注释）：统计与搜索只需要文本。若每次都从 HTML 现解析，就要正确处理去标签、HTML 实体解码、块级标签转换——**任何一处漏掉字数就是错的**。纯文本体积约为 HTML 的 60%，用这点空间换掉一个高频且易错的解析步骤是划算的。

**不变式：改正文必须同步改这三个字段，且在同一条 UPDATE 内。** 由 Service 层的事务保证。这条不变式在历史版本功能里又一次出现——回档时若只回正文、不复算这三个，列表上会显示回档前的字数，与正文自相矛盾。

### 6.4 索引与查询

**索引的定法**：照着**真实要走的查询**建。看 `chapter_revisions` 的索引注释：

```sql
-- 唯一要走的查询就是「这一章的版本，最新的在前」，正好是这个顺序
CREATE INDEX idx_chapter_revisions_chapter ON chapter_revisions (chapter_id, created_at DESC);
```

几个典型：

```sql
CREATE INDEX idx_chapters_book_order    ON chapters(book_id, order_index);
CREATE INDEX idx_contacts_name          ON contacts(name COLLATE NOCASE);   -- 大小写不敏感搜索
CREATE INDEX idx_sessions_started_at    ON writing_sessions(started_at DESC); -- 时间倒序列表
```

**几个反复出现的 SQL 手法**：

**① LIKE 的转义必须统一走 `sql-utils.ts`**：

```ts
// src/main/db/sql-utils.ts
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
export function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`
}
```

> 不转义的话，用户搜索 `100%` 会变成「以 100 开头的任意内容」，搜索 `_` 会变成「任意一个字符」——结果看起来「能搜到东西」，所以这种 bug 通常很久才被发现。

**② JSON 列的安全解析**：内容坏掉时退回默认值，不让一行脏数据把整个列表打挂。

```ts
export function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch { return [] }
}
```

**③ `COALESCE(SUM(...), 0)` 仍然可能是 null，用 `toNumber` 收口**：

```ts
export function toNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
```

**④ 窗口函数算派生列表值**（历史版本的「相对上一版增减」）：

```sql
-- src/main/modules/chapters/chapter-revision.repository.ts
-- 注意别名是 earlierHanzi 与 seq，delta 在 JS 侧相减得到（见下）
LEAD(hanzi_count) OVER (ORDER BY created_at DESC, id DESC) AS earlierHanzi,
ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC)      AS seq,
COUNT(*) OVER ()                                          AS total
```

```ts
// 行 → 领域对象的映射里把 delta 算出来：null 表示这是最早的一版，前面没有可比对象
deltaHanzi: row.earlierHanzi === null ? null : row.hanziCount - row.earlierHanzi,
earlierCount: row.seq - 1
```

> 这里的设计选择：**delta 不落库**。如果落库，剪枝删掉一版之后剩下的那些 delta 就全错了，得重算一遍。
> 用窗口函数现算，剪枝天然正确——仓储自己的注释就是这么说的：
> 「存起来反而会引入『剪枝删掉中间某版后，存下来的 delta 全部失真』这类问题；用窗口函数现算，剪枝之后自动就是对的。」

**⑤ 剪枝不能用「删掉第 N 个之后的行」**，因为同一秒可能落两版：

```ts
prune(chapterId: number, keep: number): number {
  // 用 id NOT IN (最新的 keep 个)，因为同秒可能落两版
  return this.db.prepare(`
    DELETE FROM chapter_revisions
     WHERE chapter_id = @chapterId
       AND id NOT IN (SELECT id FROM chapter_revisions
                       WHERE chapter_id = @chapterId
                    ORDER BY created_at DESC, id DESC LIMIT @keep)
  `).run({ chapterId, keep }).changes
}
```

### 6.5 备份

`src/main/modules/backup/backup.service.ts` —— **全项目唯一需要它自己解释「为什么不能用 fs 复制」的地方**：

```ts
/**
 * 用 better-sqlite3 自带的 db.backup() 而不是直接 fs 复制 .db 文件：
 * 连接开的是 WAL 模式，最新写入可能还没 checkpoint 到 .db 文件中，还在 -wal 边档里。
 * 直接复制主文件会漏掉这部分，备份回来的书少了最后几行；
 * db.backup() 会自己处理这个问题，且在备份期间不阻塞其他读写。
 */
```

---

## 7 前端架构

### 7.1 启动链

```
src/renderer/index.html
  └── <script type="module" src="/src/main.tsx">
        └── main.tsx: createRoot(#root).render(<StrictMode><App /></StrictMode>)
              └── App.tsx
                    <QueryClientProvider client={queryClient}>   ← 服务端状态缓存
                      <ThemeModeProvider>                        ← antd ConfigProvider + App（主题/语言/toast）
                        <HashRouter>
                          <Routes>
                            <Route element={<AppShell />}>       ← 顶栏 + 内容区
                              <Route index element={<DashboardPage />} />
                              <Route path="books" element={<BooksPage />} />
                              <Route path="books/:bookId" element={<ChapterEditorPage />} />
                              <Route path="books/:bookId/chapters/:chapterId" element={<ChapterEditorPage />} />
                              <Route path="outline" element={<OutlinePage />} />
                              <Route path="cards" element={<CardsPage />} />
                              <Route path="stats" element={<StatsPage />} />
                              <Route path="*" element={<Navigate to="/" replace />} />
                            </Route>
                          </Routes>
                        </HashRouter>
                      </ThemeModeProvider>
                    </QueryClientProvider>
```

**`ThemeModeProvider` 必须在最外层**（在 `HashRouter` 之外、`QueryClientProvider` 之内）：它内部除了 `ConfigProvider` 还挂了 antd 的 `<App>` 组件，而 `useToast` 依赖 `App.useApp()` 提供的上下文。放在内层会让提示信息脱离主题与语言包。

### 7.2 路由

**用 `HashRouter` 而不是 `BrowserRouter`**：

> 打包后渲染进程是通过 `file://` 协议加载 `index.html` 的，history API 在这种协议下无法正确工作（刷新即 404，因为不存在一个会返回 `index.html` 的服务端）。hash 路由把路径放在 `#` 后面，对 `file://` 完全透明。

**导航的唯一来源是 `components/nav.tsx` 的 `MODULE_ITEMS`**：

```ts
export const MODULE_ITEMS: readonly ModuleItem[] = [
  { key: 'books',   path: '/books',   label: '书籍管理',  icon: <BookOutlined />,     hint: '书籍、分卷与章节正文' },
  { key: 'outline', path: '/outline', label: '大纲管理',  icon: <PartitionOutlined />, hint: '自由多层情节树，节点可落地成章节' },
  { key: 'cards',   path: '/cards',   label: '卡片库',    icon: <IdcardOutlined />,   hint: '人物、物品、灵感三类卡片，可归属到某本书' },
  { key: 'stats',   path: '/stats',   label: '时间与字数', icon: <BarChartOutlined />, hint: '字数趋势、写作时长与热力日历' }
] as const
```

信息架构是「**首页即启动台**」：应用启动落在首页，首页顶部四张模块卡片就是导航；点卡片进模块页，模块页顶栏左侧有「返回首页」图标回来。**顶部不常驻导航条**——它在 1280 宽的窗口里占掉整整一行，而模块一共只有四个。

**`AppShell` 的 `FLUSH_ROUTES`** 决定哪些路由占满整个内容区、自己管理滚动：

```ts
const FLUSH_ROUTES = [
  /^\/books\/\d+$/,
  /^\/books\/\d+\/chapters\/\d+$/,
  /^\/outline$/,
  /^\/cards$/
]
```

章节编辑器要的是「写作时视野完整」，大纲与卡片库要的是「两栏各自滚动」——它们都需要外部不加内边距、不做滚动。用**路由判断**而不是让页面自己负边距去抵消父容器的 padding，后者在改动 padding 时会静默错位。

### 7.3 React Query：键与失效

**这是前端最容易改错的地方。** 规则集中在 `lib/query-keys.ts` 一个文件里。

**为什么要集中**：失效范围是跨模块的——保存一章正文要同时让书籍列表、统计概览、趋势图失效。键散在四处时，漏掉某一个的表现是「界面上的数字不更新」，而且刷新一下就好了，**很难被当成 bug 报出来**。

键的结构是**层级数组**，靠前缀做批量失效：

```ts
export const queryKeys = {
  books: {
    all:    ['books'] as const,                  // 前缀：invalidate 它会命中下面全部
    list:   (query) => ['books', 'list', query] as const,
    detail: (id) => ['books', 'detail', id] as const,
    stats:  () => ['books', 'stats'] as const
  },
  chapters: {
    all:    ['chapters'] as const,
    lists:  ['chapters', 'list'] as const,       // ★ 只命中列表，不命中详情
    list:   (query) => ['chapters', 'list', query] as const,
    detail: (id) => ['chapters', 'detail', id] as const,
    revisions: (chapterId) => ['chapters', 'revisions', chapterId] as const
  },
  // ...volumes / outline / cards / cardLinks / cardRelations / search / sessions / stats
} as const
```

**`chapters.lists` 与 `chapters.detail` 必须能分别失效**——这是本项目里最值钱的一条设计，注释解释得很清楚：

```ts
/**
 * 只命中「章节列表」，不命中「章节详情」。
 *
 * 这个区分是必要的：结算写作会话时（编辑器空闲 90 秒或关闭）需要刷新
 * 列表里的字数，但绝不能顺带让正在编辑的正文被判定为过期 ——
 * 一次重取就意味着编辑器要拿服务端的 HTML 去覆盖本地文档，
 * 表现是光标跳回开头。列表与详情必须能分别失效。
 */
```

于是有两个**用途不同的失效函数**：

```ts
/** 结构性变更（增删章节、改书或分卷）：目录结构会变，书籍列表与统计都要重算 */
export function invalidateLibrary(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.books.all }),
    client.invalidateQueries({ queryKey: queryKeys.volumes.all }),
    client.invalidateQueries({ queryKey: queryKeys.chapters.all }),
    client.invalidateQueries({ queryKey: queryKeys.outline.all }),
    client.invalidateQueries({ queryKey: queryKeys.cards.all }),
    client.invalidateQueries({ queryKey: queryKeys.stats.all })
  ]).then(() => undefined)
}

/**
 * 正文保存后：刻意**不**失效章节详情与统计。
 *
 * 自动保存在用户打字过程中每 2 秒触发一次。若每次都让统计失效，
 * 首页那些聚合查询（多次跨表 SUM）会被反复重跑，而且编辑器自身的
 * 数据也会被判定为过期而重取，光标位置随之丢失。
 */
export function invalidateAfterSession(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.stats.all }),
    client.invalidateQueries({ queryKey: queryKeys.books.all }),
    client.invalidateQueries({ queryKey: queryKeys.chapters.lists })   // 只失效列表
  ]).then(() => undefined)
}
```

**自动保存走的是「就地写回」而不是「失效」**——因为失效必然带来一次重取，而重取正文就会顶掉光标。具体做法写在 hook 里（`features/chapters/use-chapters.ts`）：

```ts
export function useSaveChapterContent() {
  const queryClient = useQueryClient()
  return useMutation<ChapterSaveResult, ApiError, ChapterSaveContentInput>({
    mutationFn: (input) => invoke(() => getBridge().chapters.saveContent(input)),
    onSuccess: (result, input) => {
      patchChapterCounts(queryClient, result)         // ① 就地改列表里的字数
      queryClient.setQueryData(queryKeys.chapters.detail(result.id), (old) => {
        if (!old) return old
        return { ...old, contentHtml: input.contentHtml, hanziCount: result.hanziCount, /* ... */ }
      })                                              // ② 就地改详情缓存里的正文
    }
  })
}
```

> ② 这一步不是可选的。详情缓存的 `staleTime` 是 `Infinity`——编辑器重新挂载时直接拿它起稿。保存后不同步它的话，「输入 → 跳去别处 → 回来」读到的就是这一章**第一次加载时的旧正文**：字在库里，画面上却消失，重启应用才回来。

**`search` 的键刻意不被任何写操作失效**（`query-keys.ts:107-122`）：

> 编辑器每 2 秒自动保存一次，每次都让检索失效意味着「浮层开着时后台在不停重跑全库扫描」，而那份扫描是这个应用里最贵的一条查询。结果的时效性由 `staleTime: 0` 兜住（每次打开浮层都重新查一遍）。

**自定义 hook 的固定写法**（`features/books/use-books.ts`）：

```ts
export function useBookList(query: BookListQuery) {
  return useQuery<BookListResult, ApiError>({
    queryKey: queryKeys.books.list(query),
    queryFn: () => invoke(() => getBridge().books.list(query)),
    placeholderData: keepPreviousData     // 翻页/搜索时保留上一页，避免闪成骨架屏
  })
}

export function useBook(id: number | null) {
  return useQuery<Book, ApiError>({
    queryKey: queryKeys.books.detail(id ?? -1),
    queryFn: () => invoke(() => getBridge().books.get({ id: id as number })),
    enabled: id !== null && id > 0        // id 还没解析出来时不发请求
  })
}

export function useRemoveBook() {
  const queryClient = useQueryClient()
  return useMutation<BookRemovalResult, ApiError, BookIdInput, RemoveContext>({
    mutationFn: (input) => invoke(() => getBridge().books.remove(input)),
    onMutate: async (input) => { /* 乐观更新：先摘掉那一行 */ },
    onError: (_e, _i, context) => { /* 回滚到快照 */ },
    onSettled: () => invalidateLibrary(queryClient)   // 无论如何都失效，保证最终一致
  })
}
```

**乐观更新的适用边界**：本地 SQLite 删除几乎不可能失败，让用户等一个本地往返纯属浪费；但**破坏性操作的前提是调用方已经做了二次确认**。

### 7.4 `api-client.ts`

三个导出，职责清晰：

| 导出 | 作用 |
|---|---|
| `ApiError` | 类型化错误，带 `code` / `requestId` / `issues` / `retryable` / `fieldErrors()` |
| `getBridge()` | 取 `window.winbook`；不在桌面应用里运行时抛一个**说人话**的错误 |
| `invoke(fn)` | 唯一的 IPC 调用包装：拆信封 + 异常归一化 |

```ts
export function getBridge(): WinbookApi {
  if (bridge) return bridge
  if (typeof window === 'undefined' || window.winbook === undefined) {
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: '桥接未就绪：请通过 winbook 桌面应用启动，而不是用浏览器直接打开页面',
      requestId: '-'
    })
  }
  bridge = window.winbook
  return bridge
}
```

**所有对主进程的调用都必须经过 `invoke`**，避免各处重复写拆信封逻辑。

### 7.5 主题

`theme/tokens.ts`。目标不是「长得像 Ant Design 默认样子」，而是在**保留 antd 完整功能**（表格排序、表单校验、无障碍焦点管理）的前提下，把视觉规格调成 Windows 11 的观感。

做法是**尺寸令牌两套主题共用，只切颜色令牌与组件覆盖**：

```ts
const sharedTokens: ThemeConfig['token'] = {
  fontFamily: "'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', ..., sans-serif",
  fontFamilyCode: "'Cascadia Mono', Cascadia Code, Consolas, ...",
  fontSize: 14,
  borderRadius: 8,          // Win11 控件的标准圆角，比 antd 默认的 6px 更柔和
  controlHeight: 32,
  lineHeight: 1.6,          // 桌面端阅读距离更近，行高略放宽显著降低长时间使用的疲劳
  sizeStep: 4, sizeUnit: 4,
  wireframe: false
}

const lightTokens = { ...sharedTokens, colorPrimary: '#0f6cbd', /* Fluent 强调蓝 */ }
const darkTokens  = { ...sharedTokens, colorPrimary: '#479ef5', colorTextLightSolid: '#08243a' /* 见下 */ }

export const WINBOOK_THEMES: Record<ThemeMode, ThemeConfig> = {
  light: { token: lightTokens, components: lightComponents },
  dark:  { token: darkTokens,  components: darkComponents }
}
```

深色主题那行 `colorTextLightSolid: '#08243a'` 值得单说：

> Fluent 在深色下用的是偏亮的蓝。此时主色按钮如果沿用白字，对比度只有约 2.9:1，达不到可读要求；改配深色文字后升到约 9:1，这也正是 Fluent 官方深色主题的做法。

**主题模式三档**（`system` / `light` / `dark`），存在 `localStorage['winbook.theme']`，由 `TopBarMenu` 里的菜单项循环切换。

### 7.6 三态与锚点

**每个异步页面必须齐备三态**：加载态（骨架屏）、空状态、错误态。错误提示**附带追踪 ID**。

**空状态里的动作按钮**有专门约定：40px 正圆 + `data-empty-zone` 属性——因为「空状态里的那个动作被删掉、或又变回带文字的长条」是一类很容易悄悄发生的回归。

**UI 锚点**：所有可被测试点到的元素挂 `data-testid`。这份清单是**产品约定**，所以：

> 冒烟测试里的模块清单 / 菜单项清单都是**独立写一遍**，不从渲染进程 import。测试与被测对象共用同一份清单时，「清单本身被改错」就永远测不出来——两边一起错，断言照样全绿。

---

## 8 关键子系统导读

这一节逐个讲解「有独立设计、值得单独读一遍」的子系统。每个都给出**核心机制**、**关键文件**、**改动时要注意什么**。

### 8.1 富文本编辑器 + 自动保存

**文件**：`features/chapters/RichTextEditor.tsx`（296 行）、`ChapterEditorPage.tsx`（1,368 行，全项目最大的组件）

**编辑器选型**：TipTap 3（基于 ProseMirror）。

**两条设计立场**（写在 `RichTextEditor.tsx` 类注释里）：

**① 样式不进文档。** 字体、字号、行距、纸面背景全部通过 **CSS 变量作用在容器上**，不写进 `content_html`。这样导出的草稿永远是干净的纯文本，而作者在编辑器里看到的行距只是他本人的阅读偏好，不是作品的属性。若把 `font-size` 塞进正文，换台机器打开就会变成一堆行内样式垃圾。

**② 只开放「段落级」与「语义级」格式。** 粗体、斜体、标题、引用、列表可以；字号与颜色**不可以**。网文平台接收的是纯文本，字号颜色在投稿时会被剥掉，允许设置只会造成「我明明调了，发出去却变了」的落差。

```ts
const editor = useEditor({
  extensions: [
    StarterKit.configure({
      // 小说正文里不需要代码块、行内代码、链接与分割线；
      // 关掉它们能显著减少粘贴外部内容时的 schema 报错
      codeBlock: false, code: false, link: false, horizontalRule: false
    }),
    ProofreadHighlight.configure({ getMarks: () => marksRef.current })
  ],
  content: initialContent,
  editorProps: {
    attributes: {
      class: 'winbook-editor__content',
      spellcheck: 'false',        // 中文正文会被划满红波浪线，而它并不懂中文
      autocapitalize: 'off', autocomplete: 'off'
    },
    transformPastedHTML: normalizePastedHtml,   // 粘贴时先清洗：Word 与网页会带进行内样式、class、甚至 script
    handleKeyDown: (_view, event) => { /* Ctrl+S 交给页面做元数据保存 */ }
  }
})
```

**`chapterKey` —— 用「重建」代替「改内容」**：

```ts
interface RichTextEditorProps {
  initialContent: string
  /**
   * 重建键。它变化时编辑器会被整体重建 ——
   * 这比「监听 tags 变化再 setContent」可靠得多：后者在切换章节的瞬间
   * 会先渲染上一章的内容再替换，视觉上闪一下，而且很容易把
   * 「用户刚敲的字」和「新章节的正文」搞混。
   */
  chapterKey: string | number
  // ...
}
```

页面传的是 `` `${chapterId}:${restoreToken}` ``。`restoreToken` 的存在让**同一章**在回档后也能触发重建（正文换了一份，但章节没变）。

**自动保存的三件套**（`ChapterEditorPage.tsx:242-331`）：

```ts
const AUTOSAVE_MS = 2000

const pendingRef = useRef<{ chapterId: number; html: string } | null>(null)  // 待保存的内容
const lastSavedRef = useRef<string>('')                                     // 上次成功保存的 HTML

const flush = useCallback(async (): Promise<void> => {
  // ① 清掉定时器（手动 flush 时不该再被延迟的定时器打一次）
  if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }

  const pending = pendingRef.current
  pendingRef.current = null
  if (!pending) return
  if (pending.html === lastSavedRef.current) return    // ② 内容没变就不写库：
                                                       //    光标移动、装饰重绘都可能走到这里
  try {
    const result = await saveContentRef.current.mutateAsync({ id: pending.chapterId, contentHtml: pending.html })
    lastSavedRef.current = pending.html
    setSaveState('saved')
    // ③ 用服务端回传的字数而不是前端自己算的：主进程是唯一的口径来源
    setServerCounts({ hanzi: result.hanziCount, chars: result.charCount })
  } catch (error) {
    setSaveState('error')
    notifyError(`保存失败：${toUserMessage(error)}`)
    // ④ 放回队列。下一次编辑或离开页面时会再试一次，而不是把这段内容直接丢掉
    if (pendingRef.current === null) pendingRef.current = pending
  }
}, [notifyError])

const flushRef = useRef(flush)
flushRef.current = flush          // ★ 让下面那些「只跑一次」的 effect 拿到最新的 flush

const scheduleFlush = useCallback(() => {
  if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  timerRef.current = window.setTimeout(() => { timerRef.current = null; void flushRef.current() }, AUTOSAVE_MS)
}, [])

// 切章 / 离开页面：立刻落盘。这是「最后几秒的改动不能丢」的唯一保障
useEffect(() => () => { void flushRef.current() }, [chapterId])
```

**四个容易踩的点**：

1. **`flushRef` 这个模式**：`flush` 依赖 `notifyError`（每次渲染是新引用），但卸载 effect 只该跑一次。用 ref 存最新的 `flush`，effect 里只引用 ref。
2. **失败要放回队列**，不能直接丢——否则用户那两秒的输入就没了。
3. **`pending.html === lastSavedRef.current` 的短路**：TipTap 会因为 decoration 重绘等原因触发 `onChange`，内容其实没变。不短路的话，用户只是点一下页面也会写一次库，而每次写库都会**留一版历史**。
4. **回档后必须清空待保存队列**（`handleRestored`，`ChapterEditorPage.tsx:313-323`）：

```ts
const handleRestored = useCallback((contentHtml: string): void => {
  pendingRef.current = null              // ① 回档前的正文已在服务端留成一版历史；
                                         //    若此时还压着一段自动保存，它会在两秒后
                                         //    把刚回档掉的正文又覆盖回去
  lastSavedRef.current = contentHtml     // ② 同步，否则下次 flush 会认为「不一样」而白写一次
  if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
  setSaveState('saved')
  setRestoreToken((value) => value + 1)  // ③ 让编辑器重建并载入新正文
  notifySuccess('已回到所选版本')
}, [notifySuccess])
```

### 8.2 写作会话与统计口径

**文件**：`features/chapters/use-writing-session.ts`、`src/main/modules/sessions/`、`src/main/modules/stats/`

**这是整个统计功能的唯一数据来源**：统计页的每一个数字，最终都来自 `writing_sessions` 表。所以它必须满足三个性质（注释里写得很清楚）：

> 1. **不丢**：离开编辑器、窗口关闭、空闲超时，三个时机都要结算；
> 2. **不重**：同一个会话只能落一条记录（结算后立刻清空状态）；
> 3. **不假**：`startWords` 必须取自章节加载完成后的真实字数，而不是 0——否则每次打开老章节都会被记成「写了三万字」。

```ts
const IDLE_TIMEOUT_MS = 90_000       // 空闲多久算一段写作结束
const MIN_DURATION_SECONDS = 60      // 太短的会话不落库

/**
 * 空闲阈值取 90 秒：写作过程中「想词」停顿几十秒很常见，阈值太短会把
 * 一段连续的写作切成一堆碎片会话；而超过一分半还没敲键盘通常意味着
 * 人已经离开。结算后立即开启新会话，回来继续写仍然被统计。
 *
 * 太短的会话不落库：「点开章节看了一眼就退出」会留下一条 3 秒、0 字的记录。
 * 这类噪音有两个危害：把「日均写作时长」拉低到一个没有意义的数字；
 * 让热力图出现「明明没写但那天有记录」的格子。
 */
```

**为什么不直接拿章节目录的字数做统计**（迁移里的注释）：

> 章节目录只是「当前快照」，删掉一章就会让历史写作量凭空消失。而「我昨天写了 2000 字」是既成事实，不该因为今天的结构调整被抹掉。所以每次写作单独落一条记录。

**三个字数怎么用**——这是「仅统计汉字」口径下的必要设计：

| 字段 | 含义 | 用在哪 |
|---|---|---|
| `start_words` | 会话开始时的字数 | 下面两个的减数 |
| `end_words` | 会话结束时的字数 | 净值 |
| `peak_words` | 会话过程中的**最高**字数 | 写作量 |

```
写作量 = peak_words - start_words   →  首页今日数字、趋势图
净  增 = end_words  - start_words   →  书籍进度条、目标完成度
```

**为什么需要一个 `peak_words`**：校对会删字，净变化可能为负。若直接用它算「今日写了多少」，精修一天稿子会显示成负数，显然不对。

**汉字口径的实现**（`src/shared/text.ts`）——这个文件的**跨进程共用**是刻意的：

> 编辑器里实时显示的字数、主进程落库的 `hanzi_count`、统计页聚合出的总数，必须来自同一个函数。若两侧各写一份实现，界面上显示的字数会和统计页对不上，而且这种偏差很难被发现——用户只会觉得「这个软件的数字不准」。

```ts
/** 中日韩统一表意文字，\p{Script=Han} 已覆盖 CJK 各扩展平面（含生僻字） */
const HAN_PATTERN = /\p{Script=Han}/gu
const NON_WHITESPACE_PATTERN = /\S/gu

export function countHanzi(text: string): number {
  if (text.length === 0) return 0
  return text.match(HAN_PATTERN)?.length ?? 0
}
```

> 用 Unicode Script 属性而不是 `[\u4e00-\u9fa5]` 这类区间：后者漏掉扩展 B 区之后的生僻字，而这些字在小说的人名、古籍风设定里很常见，一旦漏算，作者会发现某些章节的字数「莫名其妙少了几百」。

**`htmlToText` 的顺序不能反**：

```ts
/**
 * 顺序很重要：必须**先剥标签再解实体**。反过来的话，正文里字面写出的
 * `&lt;p&gt;` 会在解码后变成 `<p>`，然后在下一步被当成标签删掉——
 * 作者写的示例标记就凭空消失了。
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html.replace(BR_TAG, '\n').replace(BLOCK_CLOSE_TAG, '\n').replace(BLOCK_OPEN_TAG, '\n').replace(ANY_TAG, '')
  ).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
```

### 8.3 大纲自由树

**文件**：`src/main/modules/outline/outline.service.ts`（511 行）、`src/shared/modules/outline.ts`

大纲是**自由多层树**：`parent_id` 自引用，可以任意层级（卷 → 主线 → 支线 → 事件）。这带来三个必须处理的算法问题。

**索引结构**：一次查询换两份映射，避免同一棵树被反复取回。

```ts
interface OutlineIndex {
  parentOf: Map<number, number | null>     // 用于「往上走」的判断（环检测、算层数）
  childrenOf: Map<number, number[]>        // 用于「往下走」的判断（算子树的自身高度）
}
```

**① 深度上限**：新建节点时只需看「父节点层数 + 1」（新节点自身没有子树）。移动节点时要额外考虑**被移动的子树自身有多高**——否则把一棵 3 层子树挂到第 4 层，整体会变成 7 层。

**② 环检测**：把节点移到自己的后代下面会形成环，树就变得不可遍历。判断方法是「沿着目标的父链往上走，看会不会遇到自己」。

**③ 移动后的重编号**：`order_index` 的作用域是「同一父节点下」，移动后要把源容器与目标容器两边的序号都合拢（不能留空洞，否则下次插入的落点会错）。

**「落地成章节」复用章节服务**（不是自己往 `chapters` 表插一行）：

```ts
create(input: OutlineNodeCreateInput): OutlineNode {
  return runInTransaction(() => {
    this.assertBookExists(input.bookId)
    if (this.repository.countByBook(input.bookId) >= OUTLINE_LIMITS.perBook) {
      throw AppError.validation(`单本书的大纲节点不能超过 ${OUTLINE_LIMITS.perBook} 个`)
    }
    // ...
  })
}
```

**前端一次取整棵树**（`queryKeys.outline.tree`），不做按层懒加载：

> 一本书的大纲节点在几百的量级，一次序列化比「展开一级发一次请求」简单得多，而且拖拽时上下文的树是完整一致的（**环检测、深度判断都需要全貌**，分片取回来的数据做不了这些判断）。

### 8.4 全库检索

**文件**：`src/main/modules/search/`、`src/shared/modules/search.ts`

一次调用跨四张表（章节正文 / 卡片 / 大纲 / 书籍信息）。

**选型：LIKE 扫描，不是 FTS5。** 理由在 README「全库检索」一节，核心是 SQLite 的内置 FTS5 对**中文分词**基本无用（它按空格分词，中文整段是一个词），要真正可用得自己接分词器，成本远超收益；而本应用的数据量级（个人作者几十万字）上，带索引前缀的 LIKE 扫描完全够快。

**仓储把四张表的结构差异抹平**，服务层只剩一个循环：

```ts
query(query: SearchQuery): SearchResult {
  // 空查询直接返回空结果、**不发任何 SQL**：全库扫描是有成本的，
  // 而「搜索框刚被聚焦、还没输入」是个非常高频的状态
  if (query.keywords.length === 0) return { keywords: [], groups: [], total: 0 }

  const groups: SearchGroup[] = []
  let total = 0
  for (const source of SEARCH_SOURCE_ORDER) {
    const page = this.repository.searchSource(source, query)
    total += page.total
    if (page.rows.length === 0) continue      // 只把有命中的来源放进结果：
                                              // 显示「书籍信息 0」既不提供信息，又会把
                                              // 真正有结果的来源挤到下面去
    groups.push({ source, hits: page.rows.map((row) => this.toHit(source, row, query.keywords)),
                  total: page.total, truncated: page.truncated })
  }
  return { keywords: query.keywords, groups, total }
}
```

SQL 侧用「多字段 OR + 统一转义」：

```ts
const ors = spec.fields.map((field) => `${field.column} LIKE @${name} ESCAPE '\\'`).join(' OR ')
```

### 8.5 章节历史版本（一个完整功能的样板）

**这一节值得精读**——它是第三期第 4 件，涵盖了「加一个完整功能」的全部要素，而且设计上有几处非显然的取舍。

**问题**：自动保存只覆盖不留存。编辑器把每次改动都写回 `chapters` 那一行，前一版正文当场就没了。作者删掉三千字、切走、过一会儿才后悔，就没救了。

**方案**：新表 `chapter_revisions` 存快照 + 面板列出「历史版本」+ 差异对比 + 回到某一版。

**四个关键决策**：

**① 存整份快照，不存 diff**（迁移注释）：
> diff 省空间，但要还原第 N 版必须从基线一路重放，任何一版缺失或算法改动都会让老数据算不出来；而正文是换行很多的纯文本，gzip 之前一章也就几十 KB，作者一本书撑死几百章、每章留几十版，总量仍在几十 MB 量级。用空间换「任何一版都能独立读出来」，是这类本地优先应用该做的取舍。

**② 快照抓「改动前」的正文，不抓「改动后」**（契约注释）：
> 作者后悔的时刻永远是「我刚刚那一下弄坏了什么」。抓旧的，那么历史列表里的每一条都对应一次「回到这里就撤销掉了从那以后的全部改动」，语义单一。若抓新的，最新一版与当前正文重复，列表首行永远是没用的「和现在一样」。
>
> **于是：当前正文永远不在版本列表里，列表全是可回档的过去。**

**③ 去重规则：三条阈值**（`CHAPTER_REVISION_LIMITS`）：

```ts
export const CHAPTER_REVISION_LIMITS = {
  perChapter: 50,        // 每章保留多少版
  minHanzi: 10,          // 短于这个长度的正文不留版
  minDeltaRatio: 0.05    // 「与基准的差异小于这个比例」时不留版
} as const
```

`minDeltaRatio` 是整套规则里最关键的一条：
> 自动保存的粒度是**两秒**，也就是说作者每敲两三个字就会触发一次保存。若每次改动都留一版，50 版的配额会在两分钟内被填满——而那 50 版全是「上一版多了一个字」，真正想找的「半小时前那一大段」早在剪枝时被挤掉了。
>
> 取 5%：一章 3000 字时约 150 字，正好是「改了个词、补了半句」的量级；而「删掉一整段」（通常几百字）一定超过它，会被如实留下。用比例而不是绝对值，是因为同一本书里既有 500 字的短章也有 8000 字的长章，固定阈值在两头都会失准。

**④ 去重的「基准」是这道题真正的难点。** 服务层用了一个内存 `Map` 存基准，注释记录了三次试错：

```ts
/**
 * 上一次**真正留版**时被替换掉的那份正文，按章节 id 索引。
 *
 * 基准既不能用「最新一版快照」（被拒的改动不留快照，基准会越来越旧），
 * 也不能用「上一次见过的正文」（基准会随每次保存前移，小改动永远累积不到阈值）。
 * 只有「留版那一刻的正文」才能让比较有意义。
 *
 * 只存一章一份，因此内存占用与「正在被编辑的章节数」同阶，
 * 而不是与全书章节数同阶。进程重启后为空，由首次调用就地初始化。
 * **不做持久化**：它只是一个比较用的缓存，丢了最坏是多留一版重复内容，
 * 不值得为它加一张表或一列。
 */
private readonly revisionBaseline = new Map<number, { contentHtml: string; hanziCount: number }>()
```

三种写法为什么会错，值得记下来：

| 基准取法 | 后果 |
|---|---|
| 最新一版**快照** | 被拒的改动不留快照 → 快照表停在更早的位置 → 接下来每次改动都在跟越来越旧的版本比 → 比例越算越大 → **每敲一个字都留一版** |
| **上一次见过的正文**（每次保存后无条件前移） | 基准变「新」得太快。作者写满一整段（够留下）之后又敲了几个字，基准已被推到「写满那一版」，于是那几个字是在跟仅仅两秒前的自己比 → 比例必然很小 → **小改动永远累积不到阈值** |
| **上一次真正留版时的正文** ✅ | 被拒掉时保留旧基准，让差距一路**累积**到下一次 —— 这才是「持续小改」这种真实写作节奏该有的行为 |

**⑤ 回档本身也可以再回档**：`restoreRevision` 在覆盖之前也调一次 `keepSnapshot`，把「回档前的正文」留成一版。所以点错回档还能退回来。

**前端侧的配套改动**（这是「一个功能要动多少地方」的真实样本）：

| 文件 | 改了什么 |
|---|---|
| `src/shared/modules/chapters.ts` | 新增 3 个类型 + `CHAPTER_REVISION_LIMITS` + 3 个 schema |
| `src/main/db/migrations/index.ts` | 追加 `009_chapter_revisions` |
| `src/main/modules/chapters/chapter-revision.repository.ts` | 新文件：listByChapter / findById / insertSnapshot / prune |
| `chapter.service.ts` | 注入新仓储 + `revisionBaseline` Map + `keepSnapshot` + 3 个公开方法 |
| `chapter.controller.ts` | 3 个新 handler |
| `src/shared/ipc-channels.ts` | 3 个新通道常量（57 → 60） |
| `src/shared/api.ts` | `WinbookApi.chapters` 加 3 个方法签名 |
| `src/preload/index.ts` | 3 个转发 + `BRIDGE_VERSION` `'11'` → `'12'` |
| `src/main/ipc/registry.ts` | 装配新仓储、`ChapterService` 构造从 3 参 → 4 参 |
| `lib/query-keys.ts` | 新增 `chapters.revisions(chapterId)` |
| `use-chapters.ts` | 3 个新 hook + `revisionHtmlCache` |
| `ChapterHistoryPanel.tsx` | 新文件：约 290 行 |
| `revision-diff.ts` + `.test.ts` | 新文件：纯函数差异算法 + 12 个单测 |
| `ChapterEditorPage.tsx` | `historyOpen` / `restoreToken` state、`handleRestored`、顶栏按钮、条件渲染面板 |
| `RichTextEditor.tsx` | `chapterKey: number` → `string \| number` |
| `styles.css` | 追加 `.history` 与 `.diff` 两段样式 |
| `smoke-test.ts` | 10 条后端断言 + 1 条渲染检查 |
| `README.md` | 断言总数、功能节、规划表、目录结构 |

**差异算法的坑**（`revision-diff.ts`）——这是本功能里唯一需要算法的部分：

> LCS 在「删一段留一段」时并不唯一。实测 `甲/乙/丙 → 甲/丙` 时，dp 表分不出「删乙」和「删丙」哪个更优，会把 `乙` 判成 `丙`。
>
> **修法：配对成 `changed` 之前先比内容。** 只有成对且内容不同的才算改写，多出来的老实当纯删/纯增。

```ts
export type DiffKind = 'same' | 'changed' | 'removed' | 'added'
export interface DiffRow { old: string | null; new: string | null; kind: DiffKind }
```

**不变式：两侧行数必须相等**，缺的一侧标 `diff__line--absent`。超过 `MAX_CELLS = 4_000_000` 时退化成整块替换（避免超大正文把界面卡死）。

### 8.6 校对与格式整理：纯函数放在哪

**文件**：`src/shared/proofread.ts`（582 行）、`features/chapters/doc-tidy.ts`

这两个都是**纯函数模块**，放在 `shared` 或渲染层而不是主进程，理由值得记：

```ts
/**
 * 这是纯函数模块：输入一段文本，输出「在哪儿、什么问题」。它刻意不依赖
 * 任何 DOM 或富文本库，原因有三：
 *   1. 主进程可以在冒烟测试里直接校验规则，不需要起渲染进程；
 *   2. 编辑器换实现（TipTap → 别的）时规则一行都不用改；
 *   3. 位置用**纯文本下标**表达，映射回编辑器文档位置是调用方的事，
 *      两件事分开后各自都能单独测。
 */
```

**校对的一条产品立场**（很值得学的取舍）：

> 关于误报的一条立场：**宁可少报，不可乱报**。「的地得」误用、句式重复这类规则听着很美好，但准确率很难做上去，而作者看到满屏红色下划线时的反应是**关掉这个功能**，而不是逐个修改。因此本文件只收录确定性高的规则：标点重复、引号不配对、中英标点混用，这些要么对要么错，没有解释空间。

**「一键格式整理」刻意不做的事**（`doc-tidy.ts`）：

> - 不改标点。把「...」换成「……」看着很爽，但那是在替作者改稿，而这一键的定位是「排版清理」，不是「文字润色」。
> - 不折叠段落**内部**的空格。作者可能真的在用空格排版对话与落款。
> - 不拆列表与引用的结构。列表项里的空段落是结构的一部分，折叠它会让列表断成两截。

实现上按「**返回同一个节点表示没改动**」写：调用方靠 `next !== current` 判断要不要提交事务，这样点一次空按钮不会白白写入一次撤销历史。

### 8.7 冒烟测试

**文件**：`src/main/smoke-test.ts`（10,140 行，全项目最大的文件）

**为什么需要它**：桌面应用没有 HTTP 端点可以 curl。所以用一条等价路径替代——**用临时 userData 目录跑真实的主进程**，把「数据库 → 迁移 → 服务业务规则 → IPC 注册 → 渲染进程真的渲染出来」整条链路串起来验证一遍。

**核心立场**（写在文件头）：

> 不是「调用了没报错就算通过」，而是构造**已知输入**并校验**精确输出**。例如正文里的汉字个数是数得出来的，统计口径是不是真的对，只有比对精确数字才能验证——「返回了一个正数」这种断言挡不住口径算错。

**分两段执行**：

```ts
// src/main/index.ts
async function runSmokeTest(config: AppConfig): Promise<void> {
  const backend = await runBackendSmokeChecks()                    // ① 后端链路（不起窗口）

  const smokeWindow = createMainWindow(config, { showWindow: false })  // ② 真的渲染出来
  const rendererResults = await runRendererSmokeChecks(smokeWindow, backend.showcase)
  smokeWindow.destroy()

  const passed = reportSmokeResults([...backend.results, ...rendererResults],
    join(process.cwd(), 'smoke-report.txt'))
  await shutdown()
  app.exit(passed ? 0 : 1)
}
```

`backend.showcase` 是一个 `ShowcaseTargets` 结构（`smoke-test.ts:231`），后端跑完把「渲染检查需要的 id」交给渲染段，还带一些**主进程现读的回读函数**，用来对账：

```ts
export interface ShowcaseTargets {
  bookId: number
  chapterId: number
  // ...
  /** 主进程现读某一章的历史版本数 —— 断言靠它判断「自动保存跑完了没」 */
  revisionsOf: (chapterId: number) => Array<{ id: number; hanziCount: number }>
}
```

**三条最有价值的断言纪律**（详细版见 README「二十一条踩过坑的断言约定」）：

**① 清单独立写一遍，不从被测对象 import。** 两边一起改错就永远测不出来。

**② 断言必须「等待目标状态」，不能等文案。** 底栏的「已保存」是**状态**不是**事件**——它可能在你开始等之前就已经是这个值，等待瞬间返回：

```ts
// ❌ 错：底栏状态在进入本函数时**已经是「已保存」**，这个等待瞬间返回，
//       自动保存还有两秒防抖没走完，就已经断言「打完字应该有历史版本」了
await waitForSaveState(window, 'saved', 10_000)

// ✅ 对：轮询主进程的版本数。它只会在真的写库之后才变化
const after = await waitForRevisionCount(ctx, ctx.chapterId, before + 1, 15_000)
```

**③ 一个块抛异常必须就地接住。** 否则它会穿过播种函数、以**别人的名字**报错，并且**后面几十条断言一条都不执行**——断言总数从 116 静默掉到 92，那 24 项里包含全部渲染检查。

```ts
try {
  // ...主进程断言块
  for (const [name, ok, detail] of revisionChecks) push(name, ok, detail)
} catch (error) {
  // 就地接住，报自己的名字，不让后续断言消失
  push('章节历史版本（后端）', false, `用例抛出异常：${messageOf(error)}`)
} finally {
  bookService.remove(revBook.id)     // 临时书必须在 finally 里删，理由见下
}
```

**为什么临时书必须在 `finally` 里删**（这条踩得很痛）：

> 不删的话它会成为书籍列表里最新的一本，而大纲页与卡片页在没有 `?bookId` 时都回落到「列表里的第一本书」——于是这一次新增的临时书会把那些页面的默认落点整体挪走，**后面的渲染断言全部跑到一本空书上**，表现为「情节树未渲染」这种与本次改动毫无关系的红。

**如何按需截图**：设 `WINBOOK_SMOKE_CAPTURE` 环境变量，见 README「按需截图」。

---

## 9 自定义编码手册

前面都是「读懂」，这一章是「动手」。八个常见改法，每个从易到难给出完整步骤。

### 9.0 共同前提

**改任何东西之前，先记住这条链路**：

```
src/shared/modules/X.ts        ← 契约（类型 + Zod schema）★ 永远从这里开始
      ↓
src/main/db/migrations/        ← 需要落库的话加迁移
      ↓
src/main/modules/X/            ← repository → service → controller
      ↓
src/main/ipc/registry.ts       ← 装配依赖
src/shared/ipc-channels.ts     ← 通道常量
src/shared/api.ts              ← WinbookApi 方法签名
src/preload/index.ts           ← 白名单转发 + BRIDGE_VERSION 递增
      ↓
src/renderer/src/features/X/   ← 页面 + hooks
src/renderer/src/lib/query-keys.ts ← 缓存键
      ↓
src/main/smoke-test.ts         ← 断言
```

**改完必跑**：

```bash
npm run typecheck && npm test && npm run smoke
```

TypeScript 会替你抓出**大多数**遗漏——改了 `shared` 的类型而没改 preload，前端立刻编译失败。**这正是跨进程类型安全的价值：它把一类运行时错误变成了编译错误。**

### 9.1 给已有实体加一个字段（端到端）

目标：给书籍加一个「标签颜色」。假设叫 `accentColor` 已经存在，我们加 `subtitle`（副标题）。

**① 迁移**（`src/main/db/migrations/index.ts` 末尾追加）：

```ts
{
  name: '010_book_subtitle',
  up(db) {
    // ALTER TABLE ADD COLUMN 带非空默认值是 SQLite 支持的常量默认场景，
    // 老数据自动填空串，不需要回填脚本。
    db.exec("ALTER TABLE books ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';")
  }
}
```

**② 契约**（`src/shared/modules/books.ts`）：

```ts
// 实体加字段
export interface Book {
  // ...
  subtitle: string
}

// 上限表加一条
export const BOOK_LIMITS = { /* ... */ subtitle: 120 } as const

// 字段定义加一条
const bookFields = {
  // ...
  subtitle: z.string().trim().max(BOOK_LIMITS.subtitle, `副标题最多 ${BOOK_LIMITS.subtitle} 个字符`)
}

// create / update schema 各加一行
export const bookCreateSchema = z.object({
  // ...
  subtitle: bookFields.subtitle.default('')
})
export const bookUpdateSchema = z.object({
  // ...
  subtitle: bookFields.subtitle        // update 不给 default：整体替换语义
})
```

**③ 仓储**（`book.repository.ts`）：`BookRow` 加 `subtitle: string`、`toBook` 加映射、`insert` / `update` 的 SQL 与参数各加一处。

```ts
interface BookRow { /* ... */ subtitle: string }

function toBook(row: BookRow): Book {
  return { /* ... */ subtitle: row.subtitle }
}

// INSERT / UPDATE 的列名与 @subtitle 参数各补一处
```

**④ 前端表单**（`features/books/BookFormModal.tsx`）：加一个 `<Form.Item name="subtitle">`。**校验规则不用重写**——直接复用 `bookCreateSchema` 的形状（本项目表单的常见做法是让 antd Form 的 rules 与 shared schema 对齐）。

**⑤ 断言**（`smoke-test.ts`）：在书籍那块加一条，覆盖「新建时带上 subtitle → 回库对账 → 更新后读回新值」。**别忘了也验一下边界**（超长应被拦）。

**⑥ 验证**：

```bash
npm run typecheck && npm test && npm run smoke
```

**易错点**：
- 忘了改 `toBook` → 数据库里有值，但接口返回里没有（TypeScript 会报错，因为是 `strict`）。
- `update` 用了 `.default('')` → 前端不传时会被静默填成空串，把用户已填的值擦掉。**`update` 不给 default 是有意的**。
- 迁移名重复或改了已发布的迁移。

### 9.2 加一个完整功能模块（六步）

这是 README「加新功能模块」一节的展开版。以「**时间线**」（把卡片与大纲节点按故事内时间排成一条线）为例。

#### 第 1 步：契约 `src/shared/modules/timeline.ts`

定义一个模块文件该有的全部要素（照 [5.1](#51-srcshared--唯一契约来源) 的解剖结构）：

```ts
import { z } from 'zod'

/* ① 枚举 */
export const TIMELINE_GRANULARITIES = ['year', 'month', 'day'] as const
export type TimelineGranularity = (typeof TIMELINE_GRANULARITIES)[number]
export function isTimelineGranularity(value: unknown): value is TimelineGranularity {
  return typeof value === 'string' && (TIMELINE_GRANULARITIES as readonly string[]).includes(value)
}

/* ② 实体 */
export interface TimelineEntry {
  id: number
  bookId: number
  title: string
  storyTime: string          // 故事内时间，ISO 字符串
  granularity: TimelineGranularity
  cardId: number | null      // 关联的卡片（可选）
  nodeId: number | null      // 关联的大纲节点（可选）
  createdAt: string
  updatedAt: string
}

/* ③ 常量 */
export const TIMELINE_LIMITS = { title: 120, perBook: 5_000 } as const

/* ④ 入参 schema */
export const timelineCreateSchema = z.object({
  bookId: z.number().int().positive('书籍 ID 非法'),
  title: z.string().trim().min(1, '标题不能为空').max(TIMELINE_LIMITS.title),
  storyTime: z.string().trim().min(1, '故事时间不能为空'),
  granularity: z.string().refine(isTimelineGranularity, '时间粒度不合法').default('day'),
  cardId: z.number().int().positive().nullable().default(null),
  nodeId: z.number().int().positive().nullable().default(null)
})
export type TimelineCreateInput = z.infer<typeof timelineCreateSchema>
```

**这一份 schema 会被两个地方消费**：主进程的 `parse`（边界校验）与前端表单。**规则不可能漂移。**

#### 第 2 步：迁移（只在需要新表时）

```ts
{
  name: '010_timeline_entries',
  up(db) {
    db.exec(`
      CREATE TABLE timeline_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        title       TEXT    NOT NULL,
        story_time  TEXT    NOT NULL,
        granularity TEXT    NOT NULL DEFAULT 'day',
        card_id     INTEGER REFERENCES cards(id) ON DELETE SET NULL,
        node_id     INTEGER REFERENCES outline_nodes(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        CHECK (length(trim(title)) > 0)
      );
      -- 索引照真实查询建：这条线永远是「某本书的条目，按故事时间排」
      CREATE INDEX idx_timeline_book_time ON timeline_entries (book_id, story_time);
    `)
  }
}
```

**注意外键的删除行为要逐个想清楚**：
- `book_id` 用 `CASCADE`：删书，这条时间线整体消失。
- `card_id` / `node_id` 用 `SET NULL`：删掉一张卡片不该把「这个时间点上发生过什么」也删掉，只是失去了指向。

#### 第 3 步：三个文件 `src/main/modules/timeline/`

```
timeline.repository.ts   ← 唯一写 SQL：list / findById / insert / update / deleteById
timeline.service.ts      ← 业务规则 + 事务
timeline.controller.ts   ← 只解析 + 调用
```

参考实现直接抄同构的 `card-links` 模块（它的 `card-link.repository.ts` 只有 334 行，结构最干净）。

#### 第 4 步：接线（四个文件，一处都不能少）

```ts
// ① src/shared/ipc-channels.ts —— 加通道常量
export const IpcChannel = {
  // ...
  TimelineList: 'timeline:list',
  TimelineCreate: 'timeline:create',
  TimelineUpdate: 'timeline:update',
  TimelineRemove: 'timeline:remove'
} as const

// ② src/shared/api.ts —— 加方法签名（import 类型 + 在 interface 里加一段）
export interface WinbookApi {
  // ...
  timeline: {
    list: (query: TimelineListQuery) => Promise<IpcResponse<TimelineEntry[]>>
    create: (input: TimelineCreateInput) => Promise<IpcResponse<TimelineEntry>>
    update: (input: TimelineUpdateInput) => Promise<IpcResponse<TimelineEntry>>
    remove: (input: TimelineIdInput) => Promise<IpcResponse<{ id: number }>>
  }
}

// ③ src/preload/index.ts —— 白名单转发
const api: WinbookApi = {
  // ...
  timeline: {
    list: (query) => ipcRenderer.invoke(IpcChannel.TimelineList, query),
    create: (input) => ipcRenderer.invoke(IpcChannel.TimelineCreate, input),
    update: (input) => ipcRenderer.invoke(IpcChannel.TimelineUpdate, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.TimelineRemove, input)
  }
}
// ★ 同时把 BRIDGE_VERSION 递增，并在上面的注释块里加一行说明

// ④ src/main/ipc/registry.ts —— 装配
const timelineRepository = new TimelineRepository(db)
const timelineService = new TimelineService(timelineRepository, bookRepository, cardRepository)
registerTimelineHandlers(timelineService)
```

**漏任何一处前端就编译不过**——这正是跨进程类型安全在起作用。

#### 第 5 步：前端 `src/renderer/src/features/timeline/`

```
TimelinePage.tsx       页面
use-timeline.ts        React Query hooks
TimelineFormModal.tsx  新建/编辑弹窗
```

三处登记：

```tsx
// ① components/nav.tsx —— 加模块（导航唯一来源，首页卡片读它）
export const MODULE_ITEMS: readonly ModuleItem[] = [
  // ...
  { key: 'timeline', path: '/timeline', label: '故事时间线',
    icon: <FieldTimeOutlined />, hint: '把卡片与情节按故事内时间排成一条线' }
]

// ② App.tsx —— 挂路由
<Route path="timeline" element={<TimelinePage />} />

// ③ components/AppShell.tsx —— 如果需要两栏各自滚动，往 FLUSH_ROUTES 加一条
const FLUSH_ROUTES = [ /* ... */ , /^\/timeline$/ ]

// ④ lib/query-keys.ts —— 加缓存键
export const queryKeys = {
  // ...
  timeline: {
    all: ['timeline'] as const,
    list: (bookId: number) => ['timeline', 'list', bookId] as const
  }
} as const
```

**页面骨架**照 `features/cards/` 抄：筛选条 + 列表 + 编辑面板的两栏布局，含分页、空状态、错误态与 `data-testid` 锚点。页头用 `PageHeader` 摆操作按钮。

#### 第 6 步：断言（`src/main/smoke-test.ts`）

两处：

```ts
// ① 后端：业务规则用例（构造已知输入，校验精确输出）
const timelineChecks: Array<[string, boolean, string]> = [
  ['新建时间线条目', /* ... */],
  ['删除卡片后条目保留但关联置空', /* ... */],     // 覆盖 SET NULL 那条外键语义
  // ...
]
for (const [name, ok, detail] of timelineChecks) push(name, ok, detail)

// ② 往 HOME_MODULES 里补上新模块（那份清单是独立写的，不会自己跟上）
const HOME_MODULES = [
  // ...
  { key: 'timeline', path: '/timeline', label: '故事时间线' }
] as const
```

#### 验证

```bash
npm run typecheck && npm test && npm run smoke
```

冒烟应该从 116 项涨到 116 + 你新增的项数，且 `EXIT=0`。

### 9.3 只加一个 IPC 通道（在已有模块上加功能）

已有模块上加一个操作，比加模块省事得多。以「通过 ID 批量取章节」为例：

```ts
// ① src/shared/modules/chapters.ts —— 入参 schema
export const chapterListByIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).max(500, '一次最多 500 章')
})
export type ChapterListByIdsInput = z.infer<typeof chapterListByIdsSchema>

// ② src/shared/ipc-channels.ts
ChaptersListByIds: 'chapters:list-by-ids',

// ③ src/main/modules/chapters/chapter.controller.ts —— 一个 registerHandler
registerHandler(IpcChannel.ChaptersListByIds, {
  label: '按 ID 批量取章节',
  parse: (raw) => chapterListByIdsSchema.parse(raw),
  handle: (input) => service.listByIds(input.ids)
})

// ④ src/main/modules/chapters/chapter.service.ts —— 业务方法
listByIds(ids: number[]): ChapterListItem[] { /* 校验 + 调用仓储 */ }

// ⑤ src/main/modules/chapters/chapter.repository.ts —— SQL
listByIds(ids: number[]): ChapterListItem[] { /* WHERE id IN (...) */ }

// ⑥ src/shared/api.ts + src/preload/index.ts —— 各加一行
```

**注意**：`IN (?)` 的写法在 SQLite 里参数个数是动态的，需要用 `ids.map(() => '?').join(',')` 拼占位符——**但绝不要把 id 的值拼进 SQL**，只拼占位符。

### 9.4 加一条迁移

三条规矩（见 [6.1](#61-迁移)），再加五条实操细节：

1. **命名格式**：`0XX_描述`，序号连续。取当前最大序号 +1（现在是 `009`）。
2. **一条迁移只做一件事**，便于失败时定位。多条相关的 DDL 可以放一条（如建表 + 建索引），但「加字段」与「搬迁数据」最好分开。
3. **`up` 里只写 SQL，不写业务逻辑**。需要用 JS 循环处理数据时（如 `008` 的搬迁），直接写普通的 for 循环 + `prepare`，**不要 import 服务层**——迁移一旦发布就不能改，而服务层会变。
4. **失败即整条回滚**，所以不用自己写清理逻辑。
5. **改完必须验「新装」与「升级」两条路径**：删掉 `out/` 与临时库跑一次 `npm run smoke`（新装路径）；已有库直接跑一次（升级路径）。

### 9.5 加一个页面

```tsx
// ① src/renderer/src/features/<模块>/XxxPage.tsx
export function XxxPage() {
  const { data, isPending, error } = useXxx()
  // ★ 三态必须齐备
  if (isPending) return <Skeleton active />
  if (error) return <ErrorAlert error={error} />      // 错误态带追踪 ID
  if (data.length === 0) return <EmptyState /* 挂 data-empty-zone 的正圆按钮 */ />
  return <>{/* 内容 */}</>
}

// ② App.tsx 挂路由
// ③ nav.tsx 加模块（如果它是个顶层模块）
// ④ AppShell.tsx 的 FLUSH_ROUTES（如果需要自己管滚动）
```

**页面的三条 UI 约定**（详见 README 的「界面与主题」）：

- **页标题一律不显示**（`PageHeader` 只做隐藏锚点）。
- 页面头部的操作按钮用**圆形图标钮** + `data-testid`。
- **同一件事只给一个入口**；事后修改类的操作藏在右键菜单里。

### 9.6 改编辑器

按改动的位置分四类：

| 想改什么 | 改哪里 | 注意 |
|---|---|---|
| 加一个格式按钮 | `EditorToolbar.tsx` | 格式必须在 TipTap schema 里已启用；本项目刻意不开放字号/颜色 |
| 加一条校对规则 | `src/shared/proofread.ts` | 纯函数。**只收确定性高的规则**，误报会让作者关掉整个功能 |
| 改自动保存的时机 | `ChapterEditorPage.tsx` 的 `AUTOSAVE_MS` | 改小会频繁写库（每次写库都可能留一版历史）；改大则丢字风险上升 |
| 让某类内容不可编辑 | `RichTextEditor.tsx` 的 `editorProps` | 见 `readOnly` prop |

**改编辑器最要紧的一条**：**不要试图通过 `setContent()` 来换章节内容**。用 `chapterKey` 触发重建——`setContent` 在切换章节的瞬间会先渲染上一章的内容再替换，视觉上闪一下，而且很容易把「用户刚敲的字」和「新章节的正文」搞混。

### 9.7 调主题

`src/renderer/src/theme/tokens.ts`：

```ts
// ① 尺寸令牌（两套主题共用）—— 改这里会影响全部界面
const sharedTokens: ThemeConfig['token'] = {
  borderRadius: 8, controlHeight: 32, lineHeight: 1.6, /* ... */
}

// ② 颜色令牌 —— 分别改 light / dark
const lightTokens = { ...sharedTokens, colorPrimary: '#0f6cbd', /* ... */ }

// ③ 组件级覆盖 —— 特定 antd 组件的细调
const lightComponents: ThemeConfig['components'] = {
  Layout: { headerHeight: 56, /* ... */ },
  Table:  { headerBg: '#fafafa', /* ... */ },
  /* ... */
}
```

**改颜色时的硬要求**：**两套主题都要改，并核对对比度**。深色主题的 `colorTextLightSolid` 之所以是 `#08243a` 而不是白，就是因为白字在 `#479ef5` 上只有约 2.9:1。

**风格不一的 CSS 怎么办**：`src/renderer/src/styles.css`（约 3,200 行）是唯一的样式文件，按功能分段（`.history` / `.diff` / `.editor-*` 等）。新加一段前先 `grep` 一下有没有已存在的同类段落。

### 9.8 加一条冒烟断言

```ts
// 后端断言：构造已知输入 → 校验精确输出
const [ok, detail] = (() => {
  const created = bookService.create({ /* 已知输入 */ })
  const read = bookService.getById(created.id)
  return [
    read.subtitle === '已知的副标题',                    // ★ 精确值，不是「非空」
    read.subtitle === '已知的副标题' ? '副标题已正确落库' : `读回的是「${read.subtitle}」`
  ]
})()
push('书籍副标题往返', ok, detail)
```

**四条纪律**（见 [8.7](#87-冒烟测试) 与 README 的二十一条）：

1. **等目标状态，不等文案**。要等「保存完成」，就轮询主进程里的确定性状态，不要等底栏文本。
2. **块内抛异常必须就地接住**，否则后续几十条断言全部消失。
3. **临时数据必须在 `finally` 里清理**，否则会把后续渲染断言的落点挪走。
4. **要验「拦截」类行为，必须走真实的 IPC 边界**：

```ts
// 校验统一收口在 ipc-handler 的 parse 里，服务层不重复做
// → 直接调服务层测不到「非法数据被拒」
const parser = getChannelParser(IpcChannel.BooksCreate)
const result = parser?.({ title: '' })
// 断言 result 抛了 ZodError
```

**验证**：

```bash
npm run smoke          # 看断言总数涨了没、EXIT 是否 0
```

---

## 10 约定速查

### 10.1 十六条硬约定

**契约与分层**

1. **`src/shared` 是唯一契约来源。** 类型、Zod schema、常量、纯函数都在这里。主进程边界校验与前端表单用**同一份 schema**。
2. **控制器不写业务逻辑，不吞异常。** 每个 handler 只做「parse → 调 service → 返回」，并带一个 `label`。
3. **Service 不依赖 Electron / IPC 类型。** 例外只有 `exporter` / `backup`（需要 `dialog`），它们被单独隔离。
4. **Repository 是唯一写 SQL 的地方**，且只做「执行 SQL + 行 ↔ 对象映射」，不含业务判断。
5. **校验统一收口在 IPC 边界（`parse`）**，服务层不重复校验。推论：**直接调服务层测不到校验**，冒烟里凡「拦截」类用例都走真实边界。
6. **枚举用 `as const` 数组 + `typeof[number]` + 类型守卫**，Zod 侧用 `z.string().refine()` 而不是 `z.enum()`（要中文报错文案）。

**数据库**

7. **迁移只允许末尾追加，已发布的禁止修改。** 老用户的库不会重跑已应用的迁移。
8. **CHECK 只覆盖结构性不变式**（非空 / 非负 / 取值范围），**不覆盖枚举值域**（SQLite 无法 ALTER CHECK）。枚举由 shared 的 Zod 强制。
9. **派生字段必须与来源在同一条 UPDATE 内写入。** `content_html` 一变，`content_text` / `hanzi_count` / `char_count` 必须在同一条语句里跟着变。
10. **派生值只由主进程算。** 前端算的字数不落库——服务端回传的字数才是权威口径。
11. **`foreign_keys = ON` 必须开着。** 本项目大量依赖 `ON DELETE CASCADE`，关掉会留下一堆孤儿行。
12. **外键的删除行为逐个想清楚**：`CASCADE`（从属数据）/ `SET NULL`（保留记录、失去归属）/ `RESTRICT`（禁止删除）。

**跨进程与前端**

13. **`null` 不是 `undefined`。** Zod 的 `.default()` 只对 `undefined` 生效，拦不住 `null`。渲染端用 `null` 表示「该筛选项不生效」时，schema 必须显式 `.nullable()`。
14. **`update` schema 不给 `.default()`。** 整体替换语义下，default 会把用户已填的值静默擦掉。
15. **通道名只用 `IpcChannel` 常量**，禁止裸字符串。改 `WinbookApi` 形状要递增 `BRIDGE_VERSION`。
16. **自动保存不整体失效查询，走就地写回。** 失效必然带来重取，重取正文就会顶掉光标。

**测试**

17. **清单独立写一遍，不从被测对象 import。** 两边一起改错永远测不出来。
18. **断言等目标状态，不等文案。** 文案是呈现，状态才是事实。

> 上面 18 条里有几条是「同一枚硬币的两面」，README 里按 21 条展开并逐条给了踩坑现场。

### 10.2 五个最容易踩的坑

**① `null` 与 `undefined` 混用导致整页查询被拒。**
`books:list` 的 `status` 一开始只写了 `z.string()`，而渲染端传 `null` 表示不筛选。结果每次查询都被边界校验拒掉，前端把失败降级成空下拉、页面照常渲染——**缺陷只留在主进程日志里**。修法是 `.nullable()`。

**② 忘记在 `toBook` 之类的映射函数里加新字段。**
数据库里有值，接口返回里没有。`strict` 会报错，但只有在字段是必填时才报——可选字段会静默丢失。

**③ 用 `setContent()` 换章节内容。**
会先渲染上一章再替换（闪一下），而且容易把「用户刚敲的字」和「新章节的正文」搞混。**用 `chapterKey` 触发重建。**

**④ 冒烟里一个断言抛异常，后面几十条静默消失。**
断言总数从 116 掉到 92 时没人发现，因为「失败的项」看起来只有一条。**块内就地 `catch`。**

**⑤ 临时测试数据没在 `finally` 里删。**
它会成为「列表里的第一本书」，而多个页面在没有 `?bookId` 时都回落到第一本——于是后续渲染断言全部跑到空数据上，报出与本次改动毫无关系的红。

---

## 11 质量门与打包发布

### 三道质量门

```
① npm run typecheck   三份 tsconfig 全查（node / web / root），0 错误
② npm test            130 项单测（node 环境）
③ npm run smoke       116 项端到端断言，退出码必须为 0
```

**什么时候用哪个**：

| 场景 | 用哪个 |
|---|---|
| 改了纯函数（`text.ts` / `proofread.ts` / `revision-diff.ts` / `datetime.ts`） | `npm test` —— 快，毫秒级 |
| 改了仓储的 SQL | `npm test`（仓储有集成测试，用真实数据库 + 事务回滚） |
| 改了任何跨进程契约、UI、IPC | `npm run smoke` —— 唯一能覆盖「渲染进程真的渲染出来」的手段 |
| 准备提交 / 发版 | 三道全跑 |

**单测与冒烟的分工**（这是刻意的）：单测测**纯函数与仓储**（快、可脱离 Electron），冒烟测**整条链路**（慢、但覆盖 UI）。**不要为了速度在集成测试里 mock 服务层**——那会漏掉真实 SQL 的行为差异。

### 打包

```bash
npm run dist:win     # NSIS 安装包 + portable 免安装版 → release/
```

**四件必须记住的事**（都在 `electron-builder.yml` 里）：

```yaml
files:
  - out/**/*            # 只打包构建产物
  - package.json
  - '!**/*.{md,map,ts,tsx}'          # 源码与文档不进包

asarUnpack:
  - '**/*.node'
  - node_modules/better-sqlite3/**   # 原生模块必须解包到 asar 之外

npmRebuild: false       # ★ better-sqlite3 用 N-API 预编译产物，别重新编译

win:
  target:
    - { target: nsis, arch: [x64] }
    - { target: portable, arch: [x64] }
  requestedExecutionLevel: asInvoker   # 不要求管理员权限

nsis:
  deleteAppDataOnUninstall: false      # ★ 卸载时保留 userData 下的数据库
```

**`deleteAppDataOnUninstall: false` 是**——卸载时保留用户的 `winbook.db`，避免多年创作一键蒸发。

---

## 附录 A 文件地图

按「你想改什么」索引：

| 我想改… | 去哪个文件 |
|---|---|
| 某个字段的校验规则 / 上限 | `src/shared/modules/<模块>.ts` |
| 数据库表结构 | `src/main/db/migrations/index.ts`（末尾追加） |
| 数据库连接参数 | `src/main/db/connection.ts` |
| 某个查询的 SQL | `src/main/modules/<模块>/<模块>.repository.ts` |
| 业务规则 / 事务边界 | `src/main/modules/<模块>/<模块>.service.ts` |
| 某个 IPC 通道的行为 | `src/main/modules/<模块>/<模块>.controller.ts` |
| IPC 边界校验 / 错误信封 | `src/main/core/ipc-handler.ts` |
| 通道名 | `src/shared/ipc-channels.ts` |
| preload 暴露的 API 形状 | `src/shared/api.ts` + `src/preload/index.ts` |
| 依赖装配 | `src/main/ipc/registry.ts` |
| 窗口行为 / 安全策略 | `src/main/window/main-window.ts` |
| 启动流程 / 优雅停机 | `src/main/index.ts` |
| 环境变量 | `src/main/config/env.ts` + `.env.example` |
| 日志格式 / 脱敏规则 | `src/main/core/logger.ts` |
| 错误码 | `src/shared/result.ts` + `src/main/core/errors.ts` |
| 汉字计数 / HTML 转文本 | `src/shared/text.ts` |
| 路由 | `src/renderer/src/App.tsx` |
| 模块导航 | `src/renderer/src/components/nav.tsx` |
| 应用外壳 / 滚动区 | `src/renderer/src/components/AppShell.tsx` |
| 缓存键 / 失效策略 | `src/renderer/src/lib/query-keys.ts` |
| React Query 全局默认 | `src/renderer/src/lib/query-client.ts` |
| IPC 调用包装 / 错误类型 | `src/renderer/src/lib/api-client.ts` |
| 主题 / 设计令牌 | `src/renderer/src/theme/tokens.ts` |
| 全局样式 | `src/renderer/src/styles.css` |
| 正文编辑器 | `features/chapters/RichTextEditor.tsx` |
| 自动保存 / 编辑器页面 | `features/chapters/ChapterEditorPage.tsx` |
| 写作会话采集 | `features/chapters/use-writing-session.ts` |
| 校对规则 | `src/shared/proofread.ts` |
| 一键格式整理 | `features/chapters/doc-tidy.ts` |
| 断言 | `src/main/smoke-test.ts` |
| 构建配置 | `electron.vite.config.ts` |
| 编译器开关 | `tsconfig.base.json` |
| 打包配置 | `electron-builder.yml` |

## 附录 B 命令速查

```bash
# 开发
npm run dev                   # 开发模式（HMR + DevTools）

# 检查
npm run typecheck             # 三份 tsconfig 全查
npm run typecheck:node        # 只查主进程 / preload / shared
npm run typecheck:web         # 只查渲染进程
npm test                      # 单测（130 项）
npm test -- text              # 只跑文件名匹配 text 的单测
npm run smoke                 # 端到端自检（116 项，退出码 0=全通）

# 构建与打包
npm run build                 # typecheck + 构建到 out/
npm run dist:win              # 出安装包 → release/
npm run dist:dir              # 只出解包目录（调试用，快）
npm run clean                 # 删 out/ 与 release/

# 图标
npm run icons                 # 从 SVG 生成多尺寸 .ico
```

**带环境变量跑**：

```bash
# 关闭硬件加速（无 GPU 环境）
WINBOOK_DISABLE_GPU=true npm run dev

# 冒烟时截图（见 README「按需截图」）
WINBOOK_SMOKE_CAPTURE=1 npm run smoke
```

## 附录 C 术语表

| 术语 | 含义 |
|---|---|
| **契约（contract）** | `src/shared/modules/*.ts` 里的类型 + Zod schema，主进程与渲染进程共用 |
| **信封（envelope）** | `IpcResponse<T>`，即 `{ ok: true, data }` 或 `{ ok: false, error }` |
| **控制器 / 服务 / 仓储** | 三层：解析与校验 / 业务规则与事务 / SQL 与行映射 |
| **组合根（composition root）** | `src/main/ipc/registry.ts`，手工装配所有依赖 |
| **派生字段** | 可以从其它字段算出来的列，如 `content_text` / `hanzi_count` |
| **不变式（invariant）** | 必须始终成立的约束，如「改正文必须同步改三个派生字段」 |
| **锚点（anchor）** | `data-testid` 属性，供冒烟测试定位元素 |
| **锚定字段（anchor field）** | 检索结果里命中了关键词的那些字段，决定展示标题与片段 |
| **流失路由（flush route）** | 占满内容区、自己管滚动的路由，见 `AppShell.tsx` |
| **基准（baseline）** | 历史版本去重时用来比较的那份正文，见 [8.5](#85-章节历史版本一个完整功能的样板) |
| **乐观更新** | 先改本地缓存再发请求，失败回滚 |
| **冒烟测试** | 用临时目录跑真主进程 + 真渲染进程的端到端自检 |

## 附录 D 按难度的源码阅读顺序

**第一遍（半天）—— 理解骨架，不用管细节**

1. `README.md` 的「架构约定」一节（约 70 行）
2. `src/shared/result.ts`（65 行）—— 错误码与信封
3. `src/main/core/ipc-handler.ts`（165 行）—— 整条链路的枢纽
4. `src/shared/ipc-channels.ts`（89 行）—— 60 个通道，一眼看清应用有哪些能力
5. `src/preload/index.ts`（132 行）—— 跨进程边界
6. `src/main/ipc/registry.ts`（129 行）—— 组合根，看清模块间依赖
7. `src/renderer/src/App.tsx`（61 行）—— 路由与 Provider 层

**第二遍（一天）—— 走通一条完整链路**

8. `src/shared/modules/books.ts`（285 行）—— 契约的完整解剖
9. `src/main/modules/books/book.controller.ts`（55 行）—— 控制器有多薄
10. `src/main/modules/books/book.service.ts`（101 行）—— 服务层
11. `src/main/modules/books/book.repository.ts`（339 行）—— 仓储的全部手法
12. `src/renderer/src/lib/api-client.ts`（89 行）+ `query-client.ts`（25 行）
13. `src/renderer/src/lib/query-keys.ts`（174 行）—— ★ 前端设计的核心
14. `src/renderer/src/features/books/use-books.ts`（103 行）—— hooks 的固定写法
15. `src/renderer/src/features/books/BooksPage.tsx`（422 行）—— 一个完整页面

**第三遍（两天）—— 深入核心子系统**

16. `src/shared/text.ts`（132 行）—— 汉字口径，短但关键
17. `src/main/db/migrator.ts`（74 行）+ `migrations/index.ts`（447 行）—— ★ 逐条注释都值得读
18. `src/main/modules/chapters/chapter.service.ts`（565 行）—— 最核心的业务逻辑
19. `src/main/modules/chapters/chapter-revision.repository.ts`（166 行）—— 窗口函数与剪枝
20. `features/chapters/RichTextEditor.tsx`（296 行）—— 编辑器
21. `features/chapters/ChapterEditorPage.tsx`（1,368 行）—— 最大组件，先读「自动保存」那一段
22. `src/main/modules/outline/outline.service.ts`（511 行）—— 树的算法
23. `features/chapters/revision-diff.ts` + `.test.ts` —— 一个纯函数模块的完整样本

**第四遍（可选）—— 测试与打包**

24. `src/main/smoke-test.ts` 的**文件头 + 常量区**（前 230 行）—— 断言的设计立场
25. `smoke-test.ts` 里挑一个断言块精读（推荐「章节历史版本」那一段）
26. `electron.vite.config.ts` + `electron-builder.yml` —— 构建与打包
27. `README.md` 全读 —— 这时候每个「为什么」你都能对上一段真实代码

---

**最后一句**：这个项目里注释比代码值钱。`chapter.service.ts` 的 `keepSnapshot` 有 60 行注释、20 行代码——那 60 行记录的是**三次试错**，读完能省下你自己踩那三次的时间。改代码前先读注释。
