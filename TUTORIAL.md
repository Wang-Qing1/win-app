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
- [3 两个进程，一条通道](#3-两个进程一条通道)
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

代码规模：**前端约 120 个 `.ts` / `.tsx` 文件**，加 **Rust 侧约 80 个 `.rs` 文件**。

> 本项目 2026-09 从 Electron 重写为 Rust + Tauri 2。渲染层与业务规则是原样搬过来的，
> 所以下面「前端」那部分与重写前几乎一致，变的是**壳**：后端从 Node.js 换成 Rust，
> 进程模型从「三个进程」换成「一个 Rust 进程 + WebView，一条 `invoke` 通道」。
> 为什么换、换的时候踩了什么，见 README 开头。

### 1.1 一张表看全

| 层 | 技术 | 版本 | 在本项目里扮演什么 | 关键文件 |
|---|---|---|---|---|
| **运行时宿主** | Tauri | `2.x` | Rust 进程 + 系统 WebView（Windows 上是 WebView2），一条 `invoke` 通道 | `src-tauri/src/lib.rs` |
| **后端语言** | Rust | `edition 2021`，`rust-version = 1.77` | 业务规则、SQL、迁移、日志、系统对话框 | `src-tauri/src/` |
| **前端构建** | Vite | `^7.3.6` | 打包 + 开发期 HMR；**纯前端配置**，不再管后端 | `vite.config.ts` |
| **打包** | Tauri CLI | `^2.12.0` | NSIS 安装包（前端产物内嵌进可执行文件）。**必须与 tauri crate 同版本** | `src-tauri/tauri.conf.json` |
| **语言（前端）** | TypeScript | `^7.0.2` | `strict` 全开，另有额外严格开关 | `tsconfig.base.json` |
| **UI 框架** | React | `^19.3.0` | WebView 里的全部界面 | `src/renderer/src/App.tsx` |
| **组件库** | Ant Design | `^6.6.4` | 表格 / 表单 / 弹窗 / 树等重型组件 | `src/renderer/src/theme/tokens.ts` |
| | @ant-design/icons | `^6.3.4` | 图标 | 各页面 |
| | @ant-design/plots | `^2.6.8` | 统计页的趋势图与热力图 | `features/stats/` |
| **路由** | react-router | `^8.4.0` | HashRouter（见 [7.2](#72-路由)） | `src/renderer/src/App.tsx` |
| **服务端状态** | TanStack React Query | `^5.103.1` | 缓存、失效、乐观更新、重试策略 | `lib/query-client.ts`、`lib/query-keys.ts` |
| **前端表单校验** | Zod | `^4.6.5` | 表单校验 + 前端类型推导。**后端另有一套手写校验**（见 [5.3](#53-service--业务规则与事务)） | `src/shared/modules/*.ts` |
| **富文本** | TipTap | `^3.31.3` | 正文编辑器（基于 ProseMirror） | `features/chapters/RichTextEditor.tsx` |
| **数据库** | rusqlite（`bundled`） | `0.32` | 嵌入式 SQLite；SQLite 的 C 源码一起编进产物 | `src-tauri/src/db/` |
| **单元测试（前端）** | Vitest | `^5.0.1` | 纯函数测试（7 个文件 / 114 条） | `vitest.config.ts` |
| **单元测试（后端）** | `cargo test` | — | 目前只有 `core/text.rs` 的 5 条 | `src-tauri/src/core/text.rs` |
| **系统对话框** | tauri-plugin-dialog / fs / opener | `2` | 导出时的「另存为」、在文件夹中显示 | `src-tauri/src/modules/exporter/` |

### 1.2 两条版本约束（不满足就直接装不上 / 编不过）

这两条是实测出来的硬约束，**升级依赖前必须先看这里**：

**① TypeScript 7 移除了 `baseUrl`。**
`paths` 必须写成相对路径，否则报 `TS5090` + `TS5102`：

```jsonc
// tsconfig.base.json —— 正确写法
"paths": {
  "@shared/*": ["./src/shared/*"],      // 相对路径，不能配 baseUrl
  "@renderer/*": ["./src/renderer/src/*"]
}
```

**② `rusqlite` 要开 `bundled`，备份还要另开 `backup`。**

```toml
# src-tauri/Cargo.toml
rusqlite = { version = "0.32", features = ["bundled", "backup"] }
```

- `bundled`：把 SQLite 的 C 源码编进产物，用户机器上不需要任何 `sqlite3.dll`。
  于是不必操心 ABI、预编译产物，也不需要外部 DLL。
- `backup`：打开 `Connection::backup`（在线备份 API）。**备份不能用「复制 `.db` 文件」
  代替** —— 库跑在 WAL 模式，最后一次自动保存很可能还压在 `-wal` 边档里，
  复制主文件会静默少掉最后一章。

> 如果 `npm install` 卡住很久：`.npmrc` 已把 npm 源指向国内镜像
> （`registry.npmmirror.com`）。删掉 `.npmrc` 可恢复官方源。
> Rust 侧走 crates.io，如需国内镜像要另配 `~/.cargo/config.toml`。

### 1.3 为什么是这套组合（三段话）

- **Tauri 而不是自己打包一个浏览器内核**：动机只有体积一条 —— 后者安装包 127 MB、
  解包后约 390 MB，其中约 97% 是浏览器内核，应用自身代码只占 3.9 MB；Tauri 复用
  系统里的 WebView2，主程序 7.1 MB、安装包 3.1 MB。代价是要写 Rust，并且放弃
  Node 生态里那些现成的库。
- **rusqlite（同步 API）而不是 ORM / 服务端数据库**：同步 SQL 让「事务里连着做几件事」
  变成普通的顺序代码，没有 `await` 把事务切成两半的风险；而 Rust 里 `Connection`
  本来就不允许跨线程随意共享，边界更硬。详细权衡见 README「数据」一节。
- **React Query 而不是 Redux / Zustand**：这个应用的数据几乎全是**服务端状态**
  （数据库里的东西），本地 UI 状态很少且都可以用 `useState` 解决。React Query 的失效机制
  正好对上「写完一章要让书架、统计页一起刷新」的需求。详见 [7.3](#73-react-query键与失效)。

---

## 2 跑起来：五分钟从零到改代码

### 2.1 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | `>=20.19.0` | 只用于跑前端构建与测试；`package.json` 的 `engines` 里写死 |
| Rust | `1.77+`（MSVC toolchain） | 后端编译。Windows 上需要 VS Build Tools 的 C++ 组件 |
| WebView2 | 系统自带 | Windows 11 预装；Win10 由安装包的 bootstrapper 自动装 |
| 操作系统 | Windows 11 | 代码里保留了 `darwin` 分支，但只在 Windows 上验证过 |
| GPU | 无要求 | 无显卡环境见下面的 `WINBOOK_DISABLE_GPU` |

### 2.2 四条命令

```bash
npm install          # 装前端依赖（已配置国内镜像，约几分钟）
cp .env.example .env # 可选：本地覆盖配置。.env 已在 .gitignore 里
npm run tauri:dev    # 开发模式：编译 Rust + 起 WebView，前端有 HMR
```

**第一次跑 `npm run tauri:dev` 如果窗口是白的、或者应用直接退出**，先在 `.env` 里设
`WINBOOK_DISABLE_GPU=true` 再试一次 —— 虚拟机 / 远程桌面 / 无独显的机器上几乎必然遇到
GPU 进程崩溃。原理见 [3.1](#31-两个进程各能做什么)。

> **首次编译比较久**（Rust 侧几百个 crate，实测十几分钟）。之后改前端是秒级热更新；
> 只有改 Rust 才重新编译，而且只编受影响的 crate。

### 2.3 目录地图

```text
winbook/
├── src/
│   ├── shared/          ★ 前端侧的契约来源：类型、Zod schema、纯函数
│   │   ├── modules/        每个业务模块一个文件（books / chapters / cards / outline / ...）
│   │   ├── api.ts          WinbookApi 形状（桥接层实现它）
│   │   ├── ipc-channels.ts IPC 通道名单一来源（64 个）
│   │   ├── result.ts       IpcResponse 信封 + 错误码定义
│   │   ├── text.ts         ★ 汉字计数与 HTML→文本
│   │   ├── datetime.ts     本地日期键等时间工具
│   │   └── proofread.ts    校对规则引擎（纯函数）
│   │
│   └── renderer/        前端：React 应用（由 WebView 加载）
│       ├── index.html
│       └── src/
│           ├── main.tsx / App.tsx / styles.css
│           ├── lib/          ★ tauri-bridge / api-client / query-client / query-keys
│           ├── components/   AppShell / AppHeader / 通用小件
│           ├── features/     每个业务模块一个目录（页面 + hooks）
│           ├── hooks/        跨模块通用 hooks
│           └── theme/        设计令牌 + 主题 Provider
│
├── src-tauri/           ★ 后端：Rust
│   ├── src/
│   │   ├── lib.rs           ★ 启动编排 + 64 个命令的注册（组合根）
│   │   ├── main.rs          只调用 lib.rs 的 run()
│   │   ├── state.rs         全局状态（数据库连接）
│   │   ├── config.rs        ★ 环境变量集中校验（快速失败）
│   │   ├── core/            dispatch / input(Validator) / errors / response / logger
│   │   ├── db/              mod(连接 + SAVEPOINT) / migrator / migrations / sql_utils
│   │   └── modules/         按功能组织，每个模块 commands → service → repository
│   ├── capabilities/        权限清单（只放开用到的插件能力）
│   ├── icons/               应用图标（含 SVG 矢量源）
│   ├── tauri.conf.json      ★ 窗口、devUrl、产物路径、打包与图标
│   └── Cargo.toml
│
├── dist/                前端构建产物（已 gitignore）
├── vite.config.ts       ★ 前端构建配置
├── tsconfig.base.json   ★ 编译器开关与路径别名
└── vitest.config.ts
```

打星号（★）的是一开始就该读的文件。

### 2.4 八个 npm script

| 命令 | 做什么 | 什么时候用 |
|---|---|---|
| `npm run tauri:dev` | 编译 Rust + 起 WebView，前端有 HMR | 日常开发 |
| `npm run dev:web` | 只起前端 vite（没有后端，任何数据调用都会失败） | 只调纯 UI 样式时 |
| `npm run typecheck` | `tsc --noEmit`，查前端全部类型 | 每次改完前端代码 |
| `npm test` | Vitest 单测（7 个文件 / 114 条） | 改了纯函数时 |
| `npm run build:web` | 前端产物到 `dist/` | 打包时会由 CLI 自动调 |
| `npm run tauri:build` | 出 NSIS 安装包 → `src-tauri/target/release/bundle/nsis/` | 要发给别人时 |
| `npm run clean` | 删 `dist/` | 前端产物异常时 |
| `npm run clean:tauri` | 删打包产物 | 换图标后重新打包时 |

Rust 侧的检查没有 npm 包装，直接 `cargo`：

```bash
cd src-tauri
cargo check              # 开发态
cargo check --release    # ★ 发布态也必须过一遍，理由见 11 章
cargo test
```

---

## 3 两个进程，一条通道

### 3.1 两个进程各能做什么

```
┌─────────────────────────────────────────────────────────────────┐
│  Rust 进程（后端）                                                │
│  src-tauri/                                                      │
│  · 读写 SQLite（rusqlite；连接持在 AppState 里）                   │
│  · 系统 API：文件对话框、在文件夹中显示（走 tauri-plugin-*）        │
│  · 业务规则、事务、校验、日志                                      │
│  · 注册 64 个命令（#[tauri::command]）                            │
│  · 权限由 capabilities/default.json 逐条放开                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │  invoke('books_list', { input })
                            │  只传可序列化数据（serde_json 往返）
┌───────────────────────────┴─────────────────────────────────────┐
│  WebView（系统 WebView2 的 Chromium 内核）                        │
│  src/renderer/                                                   │
│  · React 19 + antd 6 + TipTap                                    │
│  · 拿不到 process / require / fs —— **根本没有 Node 运行时**       │
│  · 只能通过 window.winbook（由 tauri-bridge.ts 造出来）说话        │
└─────────────────────────────────────────────────────────────────┘
```

**最大的结构差别：中间那一层注入脚本没有了。** 重写前 WebView 与后端之间隔着一个注入
脚本，靠它把白名单挂到 `window` 上；现在 WebView 直接调 `invoke`，于是「白名单」从
**一份代码**变成了**两处各自成立的清单**：

| 重写前由谁保证 | 现在由谁保证 |
|---|---|
| 注入脚本只暴露列出的方法 | `src-tauri/src/lib.rs` 的 `generate_handler![]`：没注册的命令名一律「命令不存在」 |
| 页面里拿不到通用 IPC 本体 | WebView 里没有 Node，也没有任何通用 IPC 对象 —— 只能按名字调命令 |
| 不放开 Node API | `capabilities/default.json` 逐条列出允许的插件权限（目前是 `core` 与 `dialog` 两项），**不做通配** |

窗口与权限的关键配置：

```jsonc
// src-tauri/tauri.conf.json
{
  "app": {
    "withGlobalTauri": true,            // 直接用 window.__TAURI__，不必装 @tauri-apps/api
    "windows": [{ "label": "main", "title": "winbook", "width": 1280, "height": 820,
                  "minWidth": 960, "minHeight": 640, "center": true }],
    "security": { "csp": null }
  },
  "bundle": { "icon": ["icons/32.png", "icons/128.png", "icons/256.png", "icons/icon.ico"] }
}
```

> `resizable` 特意没写：它就是默认值 `true`，写出来只会让人以为是特意打开的开关。
> 窗口尺寸（`width` / `height`）也只能在这里改 —— 没有对应的环境变量。

```jsonc
// src-tauri/capabilities/default.json —— 权限清单，全部内容就这三条
{ "identifier": "default", "windows": ["main"],
  "permissions": ["core:default", "dialog:allow-save", "dialog:allow-message"] }
```

**`security.csp` 目前是 `null`（未启用）—— 这是一处已知欠账**，见 README 的「待办」。

**关硬件加速走的是窗口配置，不是环境变量。** 无显卡机器上需要 `--disable-gpu*`，
而 WebView2 只在**建窗那一刻**才接受这些参数，所以 `run()` 里必须在
`Builder::build()` 之前把它们写进窗口配置：

```rust
let mut context = tauri::generate_context!();
if config::disable_gpu_requested() {
    for window in context.config_mut().app.windows.iter_mut() {
        window.additional_browser_args = Some(config::SOFTWARE_RENDERING_ARGS.to_string());
    }
}
```

三个必须知道的点（都踩过）：

1. **不能放在 setup 钩子里。** Tauri 先用 `tauri.conf.json` 把窗口建完，**再**调用你的
   setup 钩子（tauri 2.12 `app.rs::setup()`：先
   `WebviewWindowBuilder::from_config(..).build()`，再调钩子），那时 WebView2 环境
   早已创建。所以求值必须早于 `Builder::build()`，`config::disable_gpu_requested()`
   才单独开了一个入口。
2. **不能靠 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量。** wry 建 WebView2
   环境时是 `pl_attrs.additional_browser_args.unwrap_or_else(..)` —— 即使没给，它自己
   也拼一份默认串**显式**传下去，永远不传 `None`；而这个属性一旦被显式设置，
   WebView2 就不再去看那个环境变量。设了也白设。
3. **`additional_browser_args` 是替换而不是追加。** 设了就丢掉了 wry 的默认串
   `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`（少它会有右键
   迷你菜单与 SmartScreen 拦截），所以 `config::SOFTWARE_RENDERING_ARGS` 里把这一段
   原样抄了回去。

### 3.2 为什么 WebView 不能直接读数据库

三个理由，按重要性排：

1. **安全**：WebView 要运行 HTML 与富文本。正文是从外部粘贴进来的（网页、Word），
   一旦有注入，攻击者就能直接读写用户的整个数据库文件。**Rust 进程持有文件句柄，
   WebView 里连文件系统的名字都拿不到** —— 这条边界是结构性的，不靠自觉。
2. **正确性**：SQLite 连接不能跨进程共享；就算能，也要在 WebView 里加载原生库，
   等于把上面第 1 条彻底作废。
3. **单一事实源**：汉字数、章节顺序、级联删除这类规则如果两边都能算，
   迟早算出两个不一样的答案。所有派生值只由 Rust 侧产生
   （见 [10.1](#101-十八条硬约定) 约定 9–12）。

### 3.3 桥接层的白名单

`src/renderer/src/lib/tauri-bridge.ts` 造出 `window.winbook`，形如：

```ts
const api: WinbookApi = {
  version: BRIDGE_VERSION,        // '12'，协议版本
  books: {
    list: (query) => call(IpcChannel.BooksList, query),
    get: (input) => call(IpcChannel.BooksGet, input),
    // ...
  },
  // ...其余模块
}
```

`call` 里包着 `window.__TAURI__.core.invoke`，**通道名到 Rust 命令名走确定性映射**
（`:` 与 `-` 变 `_`、驼峰转下划线，如 `chapters:saveContent` → `chapters_save_content`）。
三点值得注意：

- **通道名来自 `IpcChannel` 常量**，不允许出现裸字符串。改名时如果漏改，
  会静默产生「命令不存在」的运行时错误。
- **所有方法返回 `IpcResponse` 信封（`{ok, data}` / `{ok, error}`）而不是抛异常。**
  于是前端代码与重写前**逐字不变** —— 拆信封的职责仍在 `lib/api-client.ts`。
  跨壳传 `Error` 实例语义不可靠，这条设计从第一天起就是对的。
- **`version` 是协议版本号**：前端可以读它判断自己是否跑在预期版本的宿主上，
  避免「壳是旧的、前端是新的」这种错配。**每次改 `WinbookApi` 形状都要递增它**。

---

## 4 一次请求的完整生命周期

这是全文最重要的一节。理解这一条线，剩下的都是它的变体。

### 4.1 主线：「打开书架页，列出书籍」

以 `books:list` 为例，从用户点进 `/books` 到表格渲染出来，一共 **10 跳**：

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
      getBridge() 取 window.winbook（tauri-bridge 装上去的那个对象）
        │
 ④ tauri-bridge: call('books:list', query)
      → invoke('books_list', { input: query })
      —— 这里是 WebView 能到达的最远处。参数被序列化成 JSON。
        │
════════ 跨壳边界 ════════
        │
 ⑤ Rust 命令 books_list 的包装
      （由 core/dispatch.rs 统一包，见下方代码）
      a. 取 state 拿到数据库连接
      b. parse_*()  → Validator 逐字段校验 + 归一化，非法则记进问题清单
      c. dispatch 里 create_request_id() 生成本次调用的追踪 ID、记耗时日志
      d. 包成 IpcResponse { ok: true, data }
        │
 ⑥ books/commands.rs 里那句调用
      service::list(&conn, &query)
      —— 只有这一行。没有业务逻辑，不吞异常。
        │
 ⑦ books/service.rs::list(conn, query)
      repository::list(conn, query)
      —— 本例没有业务规则，纯转发。
        │
 ⑧ books/repository.rs::list(conn, query)
      a. 拼 WHERE 条件（keyword / status）
      b. 先 COUNT(*) 拿总数，算 page_count 与 safe_page（越界页码夹回最后一页）
      c. 跑带聚合子查询的 SELECT 拿当页数据
      d. 行 → BookListItem 映射（row_to_book_list_item）
        │
 ⑨ 原路返回：IpcResponse { ok: true, data: BookListResult }
════════ 回到 WebView ════════
        │
 ⑩ api-client.ts 的 invoke()
      response.ok === true  → return response.data
        │
 ⑪ React Query 把结果按 ② 的键写进缓存 → 组件拿到 data 渲染
```

（编号到 ⑪ 是因为 ①–④ 与 ⑤–⑨、⑩–⑪ 要分段读；跳数按「跨了几次边界」数是 1 次。
这条链路里**只有一处真正的边界**，就是 ④ 与 ⑤ 之间 —— 重写换掉的正是这一处。）

### 4.2 每一跳的代码

**⑤ 是整条链路的枢纽**，它把 requestId、耗时日志、错误收敛全做完了，业务代码完全不用管：

```rust
// src-tauri/src/core/dispatch.rs（节选）
pub fn dispatch<T, F>(label: &str, channel: &str, run: F) -> IpcResponse<T>
where
    T: Serialize,
    F: FnOnce() -> AppResult<T>,
{
    let request_id = create_request_id();
    let started_at = std::time::Instant::now();

    match run() {
        Ok(data) => {
            logger::debug("命令调用完成", json!({
                "requestId": request_id, "channel": channel, "label": label,
                "durationMs": started_at.elapsed().as_millis() as u64,
            }));
            ok(data)                                   // ← 成功信封
        }
        Err(error) => {
            report_rejection(channel, &error, label, &request_id, started_at);
            fail(AppErrorPayload {                     // ← 失败信封
                code: error.code, message: error.message.clone(),
                request_id, issues: error.issues.clone(),
            })
        }
    }
}
```

**⑥ 控制器薄到什么程度**，看 `books/commands.rs`：

```rust
#[tauri::command]
pub fn books_list(state: State<'_, AppState>, input: Option<Value>) -> IpcResponse<BookListResult> {
    dispatch("查询书籍列表", "books:list", || {
        let query = parse_list_query(input)?;     // 校验 + 归一化，见下
        let conn = state.connection()?;           // ← 拿到数据库连接
        service::list(&conn, &query)
    })
}
```

注意 `parse_list_query` 里做的是**两件事**：

- **校验**：类型对不对、长度超没超、值在不在枚举里。`Validator` **边验证边记账** ——
  它不会在第一个错误处停下，而是把所有问题收集起来，最后 `validator.finish()?`
  一次性返回 `VALIDATION_ERROR` + 字段级 `issues[]`，让表单能一次把所有红框标出来。
- **归一化**：把「前端能传过来的形状」收敛成「服务层期望的形状」。比如状态筛选，
  `null` 与空串都表示「不筛选」，非法值**静默降级为不筛选**而不是报错 ——
  地址栏里带过来的旧值不该让整个书架页打不开。

```rust
fn parse_list_query(input: Option<Value>) -> AppResult<BookListQuery> {
    let source = payload(input);
    let mut validator = Validator::new(&source);

    let keyword = validator.string("keyword", "", LIMIT_TITLE, "搜索关键词过长", "搜索关键词过长");
    let raw_status = validator.string("status", "", 32, "状态筛选值非法", "状态筛选值非法");
    let page = validator.number("page", 1, 1, i64::MAX, "页码非法", "页码非法", "页码非法");

    validator.finish()?;                          // ← 一次报出全部问题

    Ok(BookListQuery {
        keyword,
        // 非法状态值静默降级为「不筛选」，而不是报错
        status: is_valid_status(&raw_status).then_some(raw_status),
        page,
        // ...
    })
}
```

> **为什么命令是普通同步函数，而导出/备份那三个是 `#[tauri::command(async)]`**：
> Tauri 默认把同步命令放在主线程（事件循环）上跑，单次查询都是毫秒级，可以接受；
> 而导出要弹**阻塞式**系统对话框（`blocking_save_file`：等回调把结果经通道传回来），
> 跑在事件循环线程上会自己等自己 —— 所以那三个必须离开主线程。
> 注意写法是 `#[tauri::command(async)]` + **同步函数体**，而不是 `async fn`：
> `async fn` 会把函数体包成一个必须 `'static` 的 future，于是 `State<'_, AppState>`
> 这种带生命周期的入参就进不了签名（编译期报 "async commands that contain references
> as inputs must return a `Result`"）。`command(async)` 则只是把同步体派到线程池。

**⑧ 仓储里唯一允许写 SQL**，看它的关键手法：

```rust
// src-tauri/src/modules/books/repository.rs（节选）

// 手法 A：防 N+1 —— 一条 SQL 带出聚合，而不是每本书再查一次
const AGGREGATE_JOINS: &str = "
  LEFT JOIN (SELECT book_id, COUNT(*) AS volume_count FROM volumes GROUP BY book_id) v
         ON v.book_id = b.id
  LEFT JOIN (SELECT book_id, COUNT(*) AS chapter_count, SUM(hanzi_count) AS hanzi_count,
                    MAX(updated_at) AS last_edited_at
               FROM chapters GROUP BY book_id) c
         ON c.book_id = b.id
";
// 刻意用两个独立子查询而不是两次 JOIN：两个一对多同时 JOIN 会产生笛卡尔积，
// 章节会被按分卷数重复累加，SUM(hanzi_count) 于是虚高。各自先聚合再关联，从根上避免。

// 手法 B：排序白名单 —— 绝不把客户端字符串拼进 SQL
fn sort_column(field: BookSortField) -> &'static str {
    match field {
        BookSortField::Title      => "b.title COLLATE NOCASE",
        BookSortField::CreatedAt  => "b.created_at",
        BookSortField::UpdatedAt  => "b.updated_at",
        BookSortField::HanziCount => "hanzi_count",
    }
}
//   format!("ORDER BY {} {}", sort_column(sort_by), if asc { "ASC" } else { "DESC" })

// 手法 C：LIKE 转义统一走共享工具
let keyword = contains_pattern(keyword);   // src-tauri/src/db/sql_utils.rs
// SQL 里配 ... LIKE :keyword ESCAPE '\'
```

**手法 D：行 → 领域对象的映射收在一个函数里**，包括脏数据的兜底：

```rust
fn row_to_book(row: &Row) -> AppResult<Book> {
    Ok(Book {
        // 理论上不可能越界（写入侧有校验），但脏数据不该让前端崩掉
        status: BookStatus::parse(row.get::<_, String>("status")?).unwrap_or(BookStatus::Idea),
        // ...
    })
}
```

**⑩ 拆信封**在前端，**重写后一行没改**：

```ts
// src/renderer/src/lib/api-client.ts
export async function invoke<T>(call: () => Promise<IpcResponse<T>>): Promise<T> {
  let response: IpcResponse<T>
  try {
    response = await call()
  } catch {
    // 宿主重启、命令名写错时 invoke 会直接 reject
    throw new ApiError({ code: 'INTERNAL_ERROR', message: '与后端通信失败，请重启 winbook 后重试', requestId: '-' })
  }
  if (response.ok) return response.data
  throw new ApiError(response.error)
}
```

### 4.3 失败路径

同一条链路上失败时，**错误形态只有三种**，全都收敛成 `IpcResponse` 的失败分支：

| 触发点 | 抛什么 | 谁转成信封 | 前端拿到 |
|---|---|---|---|
| 入参非法（Validator 记到问题） | `AppError::validation` / `validation_issues` | 命令体自己（`finish()?`） | `VALIDATION_ERROR` + `issues[]`（字段级） |
| 业务规则不过（找不到 / 冲突） | `AppError::not_found` / `.conflict` | `dispatch` | `NOT_FOUND` / `CONFLICT` + 可读文案 |
| 意料之外的异常 | 任意 `AppError::internal` / `.unclassified` | `dispatch` | `INTERNAL_ERROR` + 通用文案 + `requestId`，**堆栈只进日志** |

五类错误码在两侧各有一份**同值定义**：TS 侧在 `src/shared/result.ts`，
Rust 侧在 `core/response.rs` 的 `AppErrorCode`（`serde(rename_all = "SCREAMING_SNAKE_CASE")`
序列化成同名大写下划线）：

```ts
export type AppErrorCode =
  | 'VALIDATION_ERROR'   // 调用方问题，前端不应重试
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'     // 后端内部，前端可有限重试
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
command（控制器）  →  Service（业务）  →  Repository（数据）
   解析与校验              业务规则与事务        SQL 与行映射
```

契约在前端那一侧由 `src/shared/modules/<模块>.ts` 定义；**Rust 侧的输入校验要照着它再写一遍**
（这是重写之后最大的一处退步，见 [5.3](#53-service--业务规则与事务)）。

### 5.1 `src/shared` —— 前端的契约来源

这是**前端那一侧**的架构支点。**改一个字段，前端会直接编译失败，而不是运行时才报错。**

> **但这条保证跨不过 Rust 那道边界。** 重写前后端与前端共用同一份 Zod schema，
> 规则不可能漂移；现在 Rust 侧是**手写**的一套校验（`core/input.rs` 的 `Validator`），
> 只有「人肉对齐」这一层保障。改契约时两侧都要动 —— 详见 [5.3](#53-service--业务规则与事务)。

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

/* ⑥ 入参 schema：前端表单校验 + 类型推导（后端另有一套手写校验） */
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

一个典型的仓储长这样（`src-tauri/src/modules/books/repository.rs`）：

```rust
pub fn list(conn: &Connection, query: &BookListQuery) -> AppResult<BookListResult> { /* 拼条件 → COUNT → SELECT → 映射 */ }
pub fn find_by_id(conn: &Connection, id: i64) -> AppResult<Option<Book>> { /* ... */ }
/// 业务唯一性校验用
pub fn find_by_title(conn: &Connection, title: &str, exclude_id: Option<i64>) -> AppResult<Option<Book>> { /* ... */ }
/// 只查 SELECT 1，不拉整行
pub fn exists(conn: &Connection, id: i64) -> AppResult<bool> { /* ... */ }
/// INSERT 后回读，保证返回的是真实落库值
pub fn insert(conn: &Connection, input: &BookCreateInput, now: &str) -> AppResult<Book> { /* ... */ }
/// `changes == 0` → None（SQLite 不会因为 WHERE 没匹配到就报错）
pub fn update(conn: &Connection, input: &BookUpdateInput, now: &str) -> AppResult<Option<Book>> { /* ... */ }
/// 只动 updated_at
pub fn touch(conn: &Connection, id: i64, now: &str) -> AppResult<()> { /* ... */ }
pub fn delete_by_id(conn: &Connection, id: i64) -> AppResult<bool> { /* changes > 0 */ }
pub fn count_all(conn: &Connection) -> AppResult<i64> { /* ... */ }
/// 多表 COUNT/SUM 聚合
pub fn stats(conn: &Connection) -> AppResult<BookStats> { /* ... */ }
```

几条反复出现的手法：

| 手法 | 为什么 |
|---|---|
| `insert` 后立刻 `find_by_id(last_insert_rowid)` 回读 | 返回给前端的是**数据库真实值**（含 DEFAULT 填充的列），不是入参的回声 |
| `update` 用 `changes() == 0` 判「没改到」 | SQLite 不会因为 WHERE 没匹配到就报错 |
| `exists()` 用 `SELECT 1` | 校验存在性不需要拉回整行，尤其章节那种带几十万字正文的表 |
| `touch()` 单独一个方法 | 章节保存后必须碰一下书，否则书架按 `updated_at` 排序时，用户写了三万字但书还停在创建那一刻的位置 |
| 仓储**收 `&Connection` 而不是自己开连接** | 事务边界由服务层决定；仓储一旦自己 `open`，服务层就没法把它包进同一个事务 |
| 列名与绑定值**挨着写** | 见下 |

`insert` 的实际写法：

```rust
conn.execute(
    "INSERT INTO books (title, pen_name, genre, status, summary, target_words, chapter_words,
                        accent_color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    rusqlite::params![
        title, pen_name, genre, status, summary,
        target_words, chapter_words, accent_color, now, now
    ],
)?;
let id = conn.last_insert_rowid();
find_by_id(conn, id)?.ok_or_else(|| AppError::internal("新增书籍后无法回读记录"))
```

> **这一版用的是位置参数（`?` + `rusqlite::params![]`），不是具名参数。**
> 代价是「加一个字段要同时改列清单、占位符个数、绑定值顺序」三处，错一处就整行错位、
> 而且类型常常对得上（都是 TEXT / INTEGER），编译器不会拦。
> 所以这里的纪律是：**列名与绑定值挨着写**，别把 `params![]` 挪到别处去。

### 5.3 Service —— 业务规则与事务

**Service 刻意不依赖 Tauri 类型**：签名里只有 `&Connection` 与模型类型，没有 `AppHandle`、
没有 `serde_json::Value`、不知道有窗口这回事。因此可以直接用真实数据库做集成测试，
将来挂到别的传输层（HTTP、CLI）也不用改业务代码。

> 唯一的例外是 `exporter` 与 `backup`：它们要弹系统对话框（`tauri-plugin-dialog`）。
> 所以这两个模块被单独隔离出来，让 `chapters` 那套核心服务保持
> 「可脱离 WebView 单测」的性质。

Service 的三件事：

**① 事务边界**。多步写入必须包在 `in_transaction` 里：

```rust
// src-tauri/src/modules/books/service.rs
pub fn create(conn: &Connection, input: &BookCreateInput) -> AppResult<Book> {
    in_transaction(conn, |conn| {
        if repository::find_by_title(conn, &input.title, None)?.is_some() {
            return Err(AppError::conflict(format!(
                "已存在同名书籍「{}」，请换一个书名", input.title
            )));
        }
        let created = repository::insert(conn, input, &now_iso())?;
        logger::info("书籍已创建", logger::fields(vec![("id", json!(created.id))]));
        Ok(created)
    })
}
```

> **事务用 `SAVEPOINT` 而不是 `BEGIN`/`COMMIT`**（见 `db/mod.rs` 的注释）：SQLite 的规矩是
> 「最外层 SAVEPOINT 的 `RELEASE` 即是提交」，所以一个不在任何事务里的 SAVEPOINT
> 与一次 `BEGIN ... COMMIT` 语义相同；嵌套调用时会退化成内层 SAVEPOINT，
> 而不是报「已在事务中」。
>
> 用 SQL 层实现还有个附带好处：**签名只需要 `&Connection`，不需要 `&mut`** ——
> 于是仓储与服务可以统一都收 `&Connection`，不必为了「谁持有可变引用」打仗。
> （对比：rusqlite 自带的 `Transaction` 类型要求 `&mut Connection`，一旦用它，
> 所有下游函数的签名都得跟着变成 `&mut`。）

**② 业务规则**。以 `chapters::service::save_content` 为例，注释写得比代码长，这是本项目的风格：

```rust
pub fn save_content(conn: &Connection, input: &ChapterSaveContentInput) -> AppResult<ChapterSaveResult> {
    in_transaction(conn, |conn| {
        let existing = repository::find_by_id(conn, input.id)?
            .ok_or_else(|| AppError::not_found(format!("章节不存在（ID: {}）", input.id)))?;

        // 只转一次文本：汉字数与字符数两个口径都从这一份纯文本算出来
        let content_text = html_to_text(&input.content_html);
        let metrics = measure_text(&content_text);
        let now = now_iso();

        // 留快照必须在覆盖之前 —— 此时 existing 里还是旧正文
        let snapshot_kept = /* 见 8.5：按门槛决定要不要留一版 */;

        let saved = repository::save_content(conn, input, &content_text, metrics, &now)?
            .ok_or_else(|| AppError::internal(format!("章节正文保存失败（ID: {}）", input.id)))?;

        book_repository::touch(conn, existing.book_id, &now)?;   // 让书架按「最近写作」排序
        Ok(saved)
    })
}
```

**③ 复用其它模块的服务，而不是各写一套**。这是保持口径唯一的关键：

```rust
// src-tauri/src/modules/outline/service.rs
use crate::modules::chapters::service as chapter_service;

/// 「落地成章节」调用章节模块的服务，而不是自己往 chapters 表插一行。
/// 章节创建的规则（标题处理、字数初始化、分卷归属校验、书籍 touch）
/// 都在那里，另写一份迟早会与它漂移。
```

Rust 侧没有依赖注入容器这一层：服务是**自由函数**，需要谁就 `use` 谁 ——
连「把仓储传给构造函数」这一步都省了。代价是模块间的依赖关系不在一处显式列出，
得靠 `use` 语句与目录结构去看（这也正是 [5.5](#55-组合根librs-的命令注册) 那一节存在的理由）。

### 5.4 Controller —— 只解析与调用

见 [4.2](#42-每一跳的代码)。三条铁律：

- 不写业务逻辑（「书本不存在」交给 Service 判，因为只有 Service 知道哪种语境该抛 `NotFound`）。
- 不吞异常（异常交给 `dispatch` 统一翻译成信封）。
- 每个命令都带 `label`（人类可读名称，写进日志，出问题时能定位到具体功能）。

### 5.5 组合根：`lib.rs` 的命令注册

所有命令**在 `src-tauri/src/lib.rs` 里注册**：

```rust
// src-tauri/src/lib.rs
.invoke_handler(tauri::generate_handler![
    modules::health::commands::health_ping,
    modules::health::commands::health_ready,
    modules::books::commands::books_list,
    modules::books::commands::books_get,
    // ...共 64 个
])
```

两个与重写前的实质差别：

- **装配从「new 一堆对象」变成「列一串函数名」。** 仓储与服务都是自由函数，
  全局状态只有一个数据库连接（`AppState`），所以没有构造顺序问题，
  也就不需要一个显式的装配块。
- **重名在编译期就报错。** `generate_handler!` 是宏展开，两个模块注册同名命令的代码
  根本编不过；原来那套运行时判重（`registeredChannels`）在这里只剩「拒绝计数」这半边，
  它服务的是可观测性，不是路由。

**仓储是共享复用的**：统计模块刻意不自己写 SQL，而是复用书籍、章节、会话三个仓储 ——
所以**统计口径只有一份实现**：

```rust
// src-tauri/src/modules/stats/service.rs
//! 这个模块**没有自己的表**，也不直接写 SQL —— 所有数字都复用已有的仓储。
//! 一旦「今日字数怎么算」需要调整，只改会话仓储一处即可，
//! 不会出现「首页和统计页对不上」。

use crate::modules::books::repository as book_repository;
use crate::modules::chapters::repository as chapter_repository;
use crate::modules::sessions::repository as session_repository;
```

---

## 6 数据层

### 6.1 迁移

**位置**：`src-tauri/src/db/migrations.rs`，目前 10 条（`001` – `010`）。

一条迁移就是一个结构体：

```rust
pub struct Migration {
    /// 唯一名称，落库后用于判断是否已执行。一旦发布不可修改
    pub name: &'static str,
    pub sql: &'static str,
    /// 纯 SQL 表达不了的一次性数据加工（只有 008 用到）
    pub post: Option<fn(&Transaction<'_>) -> AppResult<()>>,
}
```

**执行器**：`src-tauri/src/db/migrator.rs`。逻辑很短，三条要点：

```rust
pub fn run(conn: &Connection) -> AppResult<MigrationReport> {
    // ① 迁移记录表独立于业务表，因此可以在业务 DDL 之前安全创建
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           applied_at TEXT NOT NULL
         );")?;

    let applied: HashSet<String> = /* SELECT name FROM schema_migrations */;

    for migration in MIGRATIONS {
        if applied.contains(migration.name) { continue }
        // ② 每条迁移与它的记录写入放在同一个事务里 —— 要么都成功，要么都不发生
        let done = in_transaction(conn, |conn| {
            conn.execute_batch(migration.sql)?;
            if let Some(post) = migration.post { post(tx)?; }   // 见「规矩三」
            conn.execute("INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)",
                         params![migration.name, now_iso()])?;
            Ok(())
        });
        match done {
            // ③ 失败即整条回滚，不会留下半成品 schema
            Err(error) => return Err(AppError::internal(
                format!("数据库迁移失败：{}", migration.name)).with_detail(error.to_string())),
            Ok(()) => logger::info("迁移已应用", logger::fields(vec![("name", json!(migration.name))])),
        }
    }
    Ok(/* 已应用清单 + 当前 schema 版本 */)
}
```

**三条写迁移的规矩**（写在 `migrations.rs` 文件头上，务必遵守）：

**规矩一：只允许在末尾追加，已发布的条目禁止修改。**

已发布的迁移改动后，老用户的库**不会重新执行**。只有新增迁移才能保证「新装」与「升级」
两条路径得到同一个 schema。看第 3 条迁移的实际做法：

```rust
Migration {
    name: "003_drop_contacts",
    // contacts 是脚手架阶段的示例模块，小说助手不需要它。
    // 单独一条迁移而不是回改 001：已发布的迁移改动后，老用户的库不会重新执行，
    // 只有新增迁移才能保证「新装」与「升级」两条路径得到同一个 schema。
    sql: "DROP TABLE IF EXISTS contacts;",
    post: None,
},
```

**规矩二：只对结构性不变式加 CHECK，不对枚举值域加。**

```sql
-- ✅ 结构性不变式：非空、非负、取值范围
CHECK (length(trim(title)) > 0)
CHECK (target_words >= 0)

-- ❌ 不要写：枚举值域
-- CHECK (status IN ('idea','serializing','paused','completed'))
```

原因：**SQLite 无法 `ALTER` 一个已有的 CHECK**，改枚举值域必须走重建表流程。
而枚举（书本状态、卡片类型、大纲节点类型）恰恰是最容易随需求扩张的部分。
枚举值域由前端 Zod schema 与后端 `Validator` **各拦一道** ——
注意这在重写后是**两份手写实现**，不再是一份共享定义（见 [5.3](#53-service--业务规则与事务) 与 [10.1](#101-十八条硬约定) 约定 1）。

**规矩三：迁移可以带数据搬迁，不只是建表。**

第 8 条迁移就是例子：人物卡旧的「与主角关系」是一行纯文本（`extra.relationship`），
改成关系表之后，`normalize_extra` 只保留登记过的键 —— **不动它的话，
作者写过的那段关系会在下一次保存这张卡时无声消失**。所以这条迁移挂了一个 `post`
把这段文本搬到正文末尾：

```rust
Migration {
    name: "008_card_relations",
    sql: "CREATE TABLE card_relations ( /* ... */ CHECK (card_id < related_id) );",
    // 一次性搬迁：文本里没有指向哪张卡，没法自动转成关联，所以搬到正文末尾，
    // 让作者在下一次打开这张卡时看见自己记过什么，再手动建成结构化关系。
    post: Some(|tx| {
        let mut stmt = tx.prepare(
            "SELECT id, content, json_extract(extra, '$.relationship') AS text
               FROM cards
              WHERE card_type = 'character' AND json_valid(extra)
                AND COALESCE(json_extract(extra, '$.relationship'), '') <> ''")?;
        // ...逐行 UPDATE
        Ok(())
    }),
},
```

> **写迁移时的自问**：这次改动会不会让用户已有的数据**变成看不见的东西**？
> JSON 列里删键、枚举值域收窄、必填字段新增 —— 这三类都会。

### 6.2 连接与 pragma

`src-tauri/src/db/mod.rs`。四个 pragma **不是可选项**：

```rust
// ★ 四个 pragma 刻意**不合并成一条 execute_batch**。原因见下方注释。
conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get::<_, String>(0))?;
conn.execute_batch("PRAGMA synchronous = NORMAL;")?;
conn.execute_batch("PRAGMA foreign_keys = ON;")?;
conn.query_row("PRAGMA busy_timeout = 5000", [], |row| row.get::<_, i64>(0))?;
```

四个 pragma 各自的作用：

| pragma | 作用 |
|---|---|
| `journal_mode = WAL` | 读写并发不互相阻塞，桌面场景多窗口时很关键 |
| `synchronous = NORMAL` | WAL 下的安全档位，兼顾性能与掉电安全 |
| `foreign_keys = ON` | ★ **SQLite 默认关闭外键约束，必须显式打开** |
| `busy_timeout = 5000` | 遇到写锁时等待而不是立刻抛 `SQLITE_BUSY` |

**`foreign_keys = ON` 尤其重要**：本项目大量依赖 `ON DELETE CASCADE` 做级联删除
（删书 → 连带删分卷、章节、大纲节点、卡片、历史版本）。**这一条不打开，级联全部失效，
删书会留下一堆孤儿行。**

**为什么前两条用 `query_row` 而中间两条用 `execute_batch`** —— 这是一条踩出来的坑，
值得背下来：

> rusqlite 的 `execute_batch` 只要遇到一条**会返回结果集的语句**就报
> `ExecuteReturnedResults` 失败。而 `PRAGMA journal_mode = WAL` 与
> `PRAGMA busy_timeout = 5000` 恰恰都会返回一行（分别是生效后的模式与超时值）。
>
> 症状极有迷惑性：**数据库文件被建出来了，但它是空的（0 张表）**，日志里也只有启动那一行
> —— 看上去像「迁移没跑」，实际是打开连接这一步中途就失败了。
> 所以会返回行的用 `query_row` 吞掉结果，不返回行的才走 `execute_batch`。

数据库文件位置由 `config.rs` 决定：`%APPDATA%\winbook\<WINBOOK_DB_FILENAME>`，
与重写前**刻意保持一致** —— 重写不该让用户的稿子「消失」。

事务封装成一个函数，业务代码只写 `in_transaction(conn, |conn| { ... })`：

```rust
/// 用 SAVEPOINT 而不是 BEGIN/COMMIT，理由见 5.3。
pub fn in_transaction<T, F>(conn: &Connection, run: F) -> AppResult<T>
where F: FnOnce(&Connection) -> AppResult<T> { /* SAVEPOINT → 执行 → RELEASE / ROLLBACK */ }
```

连接的生命周期由 `AppState` 持有（`state.rs`），随进程结束而结束；
WAL 的内容会在连接关闭时由 SQLite 自行处理。

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
CREATE INDEX idx_cards_type_title       ON cards(card_type, title COLLATE NOCASE);  -- 大小写不敏感搜索
CREATE INDEX idx_sessions_started_at    ON writing_sessions(started_at DESC);       -- 时间倒序列表
```

**几个反复出现的 SQL 手法**：

**① LIKE 的转义必须统一走 `sql_utils.rs`**：

```rust
// src-tauri/src/db/sql_utils.rs
/// 转义 LIKE 的元字符。不转义的话，用户搜 `100%` 会变成「以 100 开头的任意内容」，
/// 搜 `_` 会变成「任意一个字符」—— 而结果看起来「能搜到东西」，所以这种 bug 很久才被发现。
pub fn escape_like_pattern(value: &str) -> String { /* 在 \ % _ 前加反斜杠 */ }
pub fn contains_pattern(value: &str) -> String { format!("%{}%", escape_like_pattern(value)) }
```

**② JSON 列的安全解析**：内容坏掉时退回默认值，不让一行脏数据把整个列表打挂。

```rust
/// extra 是 TEXT 列。一行坏 JSON 会让整条查询抛「malformed JSON」，
/// 而不是只跳过那一行 —— 所以查询里配 json_valid() 护栏，映射时再兜一次底。
pub fn parse_json_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}
```

**③ `COALESCE(SUM(...), 0)` 仍可能取到 NULL，用 `to_number` 收口**：

```rust
/// SQLite 的聚合在无行时返回 NULL，而 NULL 不是 0。
pub fn to_number(value: Option<i64>) -> i64 { value.unwrap_or(0) }
```

**④ 窗口函数算派生列表值**（历史版本的「相对上一版增减」）：

```sql
-- src-tauri/src/modules/chapters/revision_repository.rs
-- 注意别名是 earlier_hanzi 与 seq，delta 在映射时相减得到（见下）
LEAD(hanzi_count) OVER (ORDER BY created_at DESC, id DESC) AS earlier_hanzi,
ROW_NUMBER()      OVER (ORDER BY created_at DESC, id DESC) AS seq,
COUNT(*)          OVER ()                                  AS total
```

```rust
// 行 → 领域对象的映射里把 delta 算出来：None 表示这是最早的一版，前面没有可比对象
delta_hanzi: earlier_hanzi.map(|earlier| hanzi_count - earlier),
earlier_count: seq - 1,
```

> 这里的设计选择：**delta 不落库**。如果落库，剪枝删掉一版之后剩下的那些 delta 就全错了，
> 得重算一遍。用窗口函数现算，剪枝天然正确 —— 仓储自己的注释就是这么说的：
> 「存起来反而会引入『剪枝删掉中间某版后，存下来的 delta 全部失真』这类问题；用窗口函数现算，
> 剪枝之后自动就是对的。」

**⑤ 剪枝不能用「删掉第 N 个之后的行」**，因为同一秒可能落两版：

```sql
-- 用 id NOT IN（最新的 keep 个），因为同秒可能落两版：时间分不出先后，id 是单调的
DELETE FROM chapter_revisions
 WHERE chapter_id = :chapter_id
   AND id NOT IN (SELECT id FROM chapter_revisions
                   WHERE chapter_id = :chapter_id
                ORDER BY created_at DESC, id DESC LIMIT :keep)
```

### 6.5 备份

`src-tauri/src/modules/backup/service.rs` —— **全项目唯一需要它自己解释「为什么不能复制文件」的地方**：

```rust
/// 用 rusqlite 的在线备份 API（`Connection::backup`）而不是直接复制 .db 文件：
/// 连接开的是 WAL 模式，最新写入可能还没 checkpoint 到 .db 文件中，还在 -wal 边档里。
/// 直接复制主文件会漏掉这部分，备份回来的书少了最后几行；
/// 在线备份会自己处理这个问题，且在备份期间不阻塞其他读写。
///
/// 实测过这件事：一个刚写完的库，主文件只有 4096 B，而 -wal 有 412 KB ——
/// 也就是说「复制主文件」这条路上，**几乎全部内容都丢了**。
///
/// 需要 Cargo.toml 里打开 rusqlite 的 `backup` 特性（默认不开）。
```

---

## 7 前端架构

### 7.1 启动链

```
src/renderer/index.html
  ├── <script>（内联、同步）           ← 首次绘制之前：定 data-theme，并挂 error 兜底
  ├── <div id="boot">                 ← 纯 CSS 启动占位（刻意放在 #root 外面）
  └── <script type="module" src="/src/main.tsx">
        └── main.tsx:
              installTauriBridge()                     ← ★ 必须在任何组件挂载之前
              createRoot(#root).render(<StrictMode><App /></StrictMode>)
              └── App.tsx
                    useEffect(dismissBootSplash)       ← ★ 首帧提交后撤掉启动占位
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

**`installTauriBridge()` 必须排在最前面**：React Query 的首次请求在 render 之后立刻发出，
晚一步就会撞上「桥接未就绪」——那时 `window.winbook` 还是 `undefined`。

（重写前这一步不需要：那时宿主在页面脚本执行之前就把 `window.winbook` 装好了。
现在这个对象得由前端自己造，于是「装桥接」成了启动链上的第一个显式动作。）

**`ThemeModeProvider` 必须在最外层**（在 `HashRouter` 之外、`QueryClientProvider` 之内）：
它内部除了 `ConfigProvider` 还挂了 antd 的 `<App>` 组件，而 `useToast` 依赖
`App.useApp()` 提供的上下文。放在内层会让提示信息脱离主题与语言包。

**启动占位写在 `index.html` 里，不在 React 里。** 它要盖住的那段时间正是
「bundle 还没执行」—— 3.3 MB 的 JS（gzip 约 1 MB）从下载到解析完，窗口边框早已画出来，
里面却是空的。所以占位只能是纯 CSS + 内联脚本：任何 `import` 都来不及。

三个容易做错的地方：

1. **`data-theme` 必须在首次绘制之前定下来。** 深色偏好存在 `localStorage` 里，
   而设 `html[data-theme]` 的 `ThemeProvider` 要到 React 挂载后才跑。中间那一段
   `<html>` 上没有任何 `data-theme`，`styles.css` 的 `:root` 是浅色 ——
   于是深色模式启动时会先闪一帧白底。内联脚本把这件事提前到 `<head>`。
   （`localStorage` 在隐私模式下会抛错，必须包 `try`。）
2. **占位放在 `#root` 外面，就得自己撤场。** 放在里面 React 挂载会顺手清掉它，
   看着省事；但那样一来「React 抛错、什么都没渲染」时它也不存在了，
   而兜底恰恰是它存在的理由之一。撤场由 App 的 `useEffect` 触发，
   **不用 `requestAnimationFrame` 猜一帧**：`createRoot().render()` 只是把工作排队，
   返回时 DOM 还没提交 —— 猜帧在快机器上碰巧对、在慢机器上会猜早，
   出现「占位淡出了、底下还是空白」，比不加占位更糟。
3. **启动阶段抛错也要让占位退场。** 内联脚本里挂了一个**非捕获**的 `error` 监听
   （非捕获 = 只接脚本错误，不接资源加载失败，所以不会因一张图挂了就提前撤场）。
   否则错误提示会被占位盖住 —— 那是白屏里最难查的一种：窗口不白，
   是一个很正常的启动画面，永远停在原地。

占位用的 CSS 变量是从 `styles.css` **抄**的一份最小副本（内联样式比 bundle 先生效，
引用不到它那份）。这层「两处必须一致」没有类型系统在管，所以交给
`lib/boot-splash.test.ts` 读 `index.html` 做断言：主题键与 `THEME_STORAGE_KEY`
是否逐字一致、每个 `var()` 用到的变量是否都在同一段里定义了（漏定义不是「样式差一点」，
而是一块透明或纯黑）、深色块是否重定义了底色与文字色。

### 7.2 路由

**用 `HashRouter` 而不是 `BrowserRouter`**：

> 打包后前端是由宿主按目录服务加载的（Tauri 用的是自定义协议，重写前是 `file://`），
> history API 在这种场景下无法正确工作 —— 刷新即 404，因为不存在一个会返回 `index.html`
> 的服务端。hash 路由把路径放在 `#` 后面，对这类协议完全透明。

**导航的唯一来源是 `components/nav.tsx` 的 `MODULE_ITEMS`**：

```ts
export const MODULE_ITEMS: readonly ModuleItem[] = [
  { key: 'books',   path: '/books',   label: '书籍管理',  icon: <BookOutlined />,     hint: '书籍、分卷与章节正文' },
  { key: 'outline', path: '/outline', label: '大纲管理',  icon: <PartitionOutlined />, hint: '自由多层情节树，节点可落地成章节' },
  { key: 'cards',   path: '/cards',   label: '卡片库',    icon: <IdcardOutlined />,   hint: '人物、物品、灵感三类卡片，可归属到某本书' },
  { key: 'stats',   path: '/stats',   label: '时间与字数', icon: <BarChartOutlined />, hint: '字数趋势、写作时长与热力日历' },
  { key: 'trash',   path: '/trash',   label: '回收站',    icon: <DeleteOutlined />,   hint: '删除的卡片与章节，可恢复或清除' }
] as const
```

信息架构是「**首页即启动台**」：应用启动落在首页，首页顶部五张模块卡片就是导航；点卡片进模块页，模块页顶栏左侧有「返回首页」图标回来。**顶部不常驻导航条**——它在 1280 宽的窗口里占掉整整一行，而模块一共只有五个。

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

**所有对后端的调用都必须经过 `invoke`**，避免各处重复写拆信封逻辑。

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

> 当初那份冒烟测试里，模块清单 / 菜单项清单都是**独立写一遍**，不从前端 import。
> 测试与被测对象共用同一份清单时，「清单本身被改错」就永远测不出来——两边一起错，断言照样全绿。
> 将来若重建端到端测试，这条仍然适用。

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
    // ③ 用服务端回传的字数而不是前端自己算的：后端是唯一的口径来源
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

**文件**：`features/chapters/use-writing-session.ts`（前端采集）、
`src-tauri/src/modules/sessions/`、`src-tauri/src/modules/stats/`（后端结算与聚合）

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

> 编辑器里实时显示的字数、后端落库的 `hanzi_count`、统计页聚合出的总数，必须来自同一个函数。若两侧各写一份实现，界面上显示的字数会和统计页对不上，而且这种偏差很难被发现——用户只会觉得「这个软件的数字不准」。

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

**文件**：`src-tauri/src/modules/outline/`（service + repository）、`src/shared/modules/outline.ts`

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

**文件**：`src-tauri/src/modules/search/`、`src/shared/modules/search.ts`

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

**方案**：新表 `chapter_revisions` 存快照 + 顶栏那枚「历史版本」圆钮打开的**弹窗**列出全部版本 + 差异对比 + 回到某一版。

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
| `src-tauri/src/db/migrations.rs` | 追加 `009_chapter_revisions`（建快照表） |
| `src-tauri/src/modules/chapters/revision_repository.rs` | 新文件：`list_by_chapter` / `find_by_id` / `insert_snapshot` / `prune` |
| `src-tauri/src/modules/chapters/service.rs` | 新增 `keep_snapshot` + 3 个公开自由函数；基准缓存挂在 `AppState::revision_baselines()` |
| `src-tauri/src/modules/chapters/commands.rs` | 3 个新命令（`#[tauri::command]`） |
| `src-tauri/src/lib.rs` | `generate_handler![]` 里登记这 3 个命令 |
| `src/shared/ipc-channels.ts` | 3 个新通道常量 |
| `src/shared/api.ts` | `WinbookApi.chapters` 加 3 个方法签名 |
| `src/renderer/src/lib/tauri-bridge.ts` | 3 处 `call(IpcChannel.…)` + `BRIDGE_VERSION` 递增 |
| `lib/query-keys.ts` | 新增 `chapters.revisions(chapterId)` |
| `use-chapters.ts` | 3 个新 hook + `revisionHtmlCache` |
| `ChapterHistoryModal.tsx` | 新文件：约 330 行（原为正文区上方的横条面板，2026-09-22 改成弹窗） |
| `revision-diff.ts` + `.test.ts` | 新文件：纯函数差异算法 + 12 个单测 |
| `ChapterEditorPage.tsx` | `historyOpen` / `restoreToken` state、`handleRestored`、顶栏圆钮、条件渲染弹窗 |
| `RichTextEditor.tsx` | `chapterKey: number` → `string \| number` |
| `styles.css` | 追加 `.history__*`（弹窗内固定高度 + 两栏各自滚动）与 `.diff` 两段样式 |
| `README.md` | 功能节、规划表、目录结构 |

**上面那一组「接线」的几行是重写后变化最大的一处**：原来接线分散在「控制器 / 通道注册表
/ 注入脚本」三个文件里，现在集中在 `commands.rs` / `lib.rs` / `tauri-bridge.ts`。
**要动的处数没变，位置全变了。**

**为什么是弹窗而不是正文上方的横条**（2026-09-22 改的，第四轮）：

> 横条挂在正文区上方，最多只能给它 40% 左右的高度（再多就把编辑器挤没了）。而对比内容的天然形状是**两栏长文本**——两栏都长，横条逼出来的就是两条窄缝，两栏各自带一个滚动条，作者要来回滚着看。改成弹窗后宽度可以给到 920px，正文区则完全不受影响。
>
> 代价是弹窗有 **rc-dialog 的焦点陷阱**（`useLockFocus` 监听 `focusin`，焦点一离开弹窗就被拽回去）。它不影响正常使用，但**写自动化测试时要注意**：弹窗开着的时候往编辑器里插字是插不进去的，必须先把弹窗关掉。当时那份冒烟测试里「打字两次」那一步就因此被挪到了关弹窗之后。
>
> 另一个配置是 `destroyOnHidden`：关掉后内容真的从 DOM 移除。若不开，弹窗只是 `display: none`，那个「等锚点消失」的断言会永远等不到——它分不清「关掉了」和「只是看不见」。

**弹窗里的两枚按钮也是圆形图标钮**（关闭 / 回到这一版），和全项目一致：只有图标、`label` 同时充当 `aria-label` 与悬浮提示文案。这里有个**具体的坑**：回档那枚外面裹着 `Popconfirm`，于是**同一枚按钮上叠了两个浮层触发器**（Tooltip + Popconfirm）。两者不冲突，但屏幕上谁先弹取决于触发方式，所以断言不能只看「有浮层」，要验**提示文案等于 `aria-label`**（见 README「界面与主题」的「第四轮」小节）。

**两枚圆钮必须落在同一条「内容轴」上**（2026-09-22 同一天的第二处修正）：

> 改完按钮之后用户又说了一句：「这两个图标对齐，现在的状态太丑了」。
> 两枚按钮分别生在**标题行**与**右栏表头**，各自贴着自己那一行的最右 ——
> 单看每一枚都合格（正圆、有 `aria-label`、提示弹得出来），右边缘却差了 **10px**：
> 右栏容器 `.history__preview` 自带 `padding-right: 10px`，而标题行没有。
> 左栏的版本条目同样差 **4px**（`.history__list` 的 `padding: 4px`）。
>
> **修法不是给按钮补 `margin`，而是让「同一根轴」成为结构事实**：内边距统一由
> antd 的 `.ant-modal-container` 给（24px），标题行与 body 都不再自带横向内边距，
> 横向留白只由列与列之间的单侧 padding 表达。当初冒烟里钉了两条几何断言：
> 两枚圆钮的右边缘分别与内容轴对齐、且互相对齐；左栏列表的左边缘同样对齐。
> **只验「互相对齐」不够** —— 两枚一起被推进去时它们仍然彼此对齐，但整体已经不在轴上。
>
> 教训：**用户说「丑」的时候，先把几何量出来再动手。** 这 10px 与 4px 都是从
> 截图里逐像素扫出来的（截图是 1.5× 缩放：48px 的圆对应 32px 的按钮），
> 量完才知道根因在「哪个容器自带内边距」，而不是「按钮该加多少 margin」。

**差异算法的坑**（`revision-diff.ts`）——这是本功能里唯一需要算法的部分：

> LCS 在「删一段留一段」时并不唯一。实测 `甲/乙/丙 → 甲/丙` 时，dp 表分不出「删乙」和「删丙」哪个更优，会把 `乙` 判成 `丙`。
>
> **修法：配对成 `changed` 之前先比内容。** 只有成对且内容不同的才算改写，多出来的老实当纯删/纯增。

```ts
export type DiffKind = 'same' | 'changed' | 'removed' | 'added'
export interface DiffRow { old: string | null; new: string | null; kind: DiffKind }
```

**不变式：两侧行数必须相等**，缺的一侧标 `diff__line--absent`。超过 `MAX_CELLS = 4_000_000` 时退化成整块替换（避免超大正文把界面卡死）。

### 8.6 回收站：一次横切改造（软删除）

**文件**：`src-tauri/src/modules/trash/`（service + commands）、`src/shared/modules/trash.ts`、
`src/renderer/src/features/trash/`

上一节是「加一个功能」，这一节是**改一个已经存在的事实**：从「删除就是 `DELETE`」
改成「删除是打一个标记」。两者要动的地方完全不同 —— 前者主要在新增文件，后者主要在
**已有文件里补条件**。这一节的价值就在这里。

**方案**：`cards` / `chapters` 各加一列 `deleted_at`（迁移 `010_soft_delete`）。
`NULL` = 活着，非空 = 在回收站里。查询默认排除它。

**为什么是加列，而不是加一张「已删除」表**：所有跨表 JOIN 都自动少一次关联。
代价是每一处查询都得记得带条件，而**漏掉的症状不是报错，是「已删除的数据在某个
角落里继续出现」**。所以这一件的真正工作量不在回收站页，而在下面这张排查表。

**排查方法**：不要靠记忆，直接搜所有碰过这两张表的 SQL：

```bash
grep -rn "FROM chapters\|INTO chapters\|UPDATE chapters\|JOIN chapters" src-tauri/src/
grep -rn "FROM cards\|INTO cards\|UPDATE cards\|JOIN cards"       src-tauri/src/
```

搜出来的每一处都要过一遍。实测要补过滤的一共九处：

| 位置 | 漏掉会怎样 |
|---|---|
| `card.repository` / `chapter.repository` 自己的列表与详情 | 删除后它还在列表里 —— 整个功能失效 |
| `book.repository` 的列表聚合 | 书架上那本书的字数不跟着减，点进去却少一章 |
| `book.service` 删书前的计数 | 确认框报「将删除 128 章」，实际 130 章 |
| `volume.repository` 的卷聚合与 `countChapters` | 已删章节仍占着卷的章节数；删卷提示夸大 |
| `outline.repository` 关联章节的 `LEFT JOIN` | 大纲节点上仍挂着已删章节的标题与状态 |
| `card-link.repository` 的 5 处 JOIN | 卡片上仍列着指向已删章节的关联行，点进去是空页 |
| `search.repository` 按来源的范围条件 | 检索能搜出已删除的正文，回收站形同虚设 |
| `chapter.repository` 的统计类查询 | 首页「继续写作」跳到一章已经删掉的内容上 |

**架构：`TrashService` 是一台纯编排器，自己一行 SQL 也没有。**

它不拿两个仓储去查，而是调用 `cardService.listDeleted()` / `chapterService.listDeleted()`。
理由：「哪些卡片在回收站里」只有卡片服务知道答案（它有「认不出的类型退回灵感」这套
口径），「恢复一章要落到哪个位置」只有章节服务知道（它有容器与顺序的概念）。让它自己查
等于把这两套口径复制到第三个地方 —— 从此「同一张卡在卡片库与回收站里显示成不同类型」
这类问题就有了生长的土壤。

依赖方向是单向的 `trash → cards / chapters`。两个模块完全不认识「回收站」这个概念，
它们只知道「有一列 `deleted_at`」。将来再加一种可回收实体（比如大纲节点），只需要它
自己长出 `listDeleted` / `restoreFromTrash`，然后在 TrashService 里多一行 ——
不需要改任何现有模块。**这是「编排器」与「上帝对象」的区别。**

它负责的只有三种**跨实体**的判断，这三种恰好谁都不该管：

1. 把两张表的条目按删除时间混排成一个列表（时间轴是唯一的视角）；
2. 按 `kind` 分派恢复 / 彻底删除（同一个动作作用在两种东西上）；
3. 清空时分别统计两边的条数，合成一个回执。

**四个容易写反的地方：**

- **恢复的章节落在容器末尾，而不是插回原来的位置。** 它躺在回收站期间，原位很可能
  已经被别的章节占了，插回去就得把别人往后挤 ——「我恢复了个东西，结果别人的顺序
  全变了」比「它在最后面」更让人意外。落点用 `nextOrderIndex`。
- **恢复时容器取自这一行自己当前的值。** 章节在回收站期间它所属的分卷完全可能被删掉，
  于是 `volume_id` 被 `ON DELETE SET NULL` 改成了 `NULL`。按「它进回收站时的那个卷」
  去恢复，会让这一章指向一个不存在的分卷，界面上表现为「恢复了，但目录里找不到它」。
- **恢复不动书的 `updated_at`，删除动。** 恢复没有改变这本书的内容，只是把之前拿走的
  东西还回去；碰它的话，从回收站捞一章回来就会把整本书顶到书架最前面。
- **页签上的计数不受类型筛选影响。** 切到「只看卡片」时章节那格若变成 0，读起来像
  「那些被删光了」。所以两种都数、都取 —— 与卡片库 `countByType` 一致。

**两处刻意的取舍：**

- **混排的二级排序键用 `(kind, id)`。** 两张表的 id 是各自独立的自增序列，而删除时间
  只精确到毫秒。同一个毫秒里删掉一张卡与一章时，仅按时间排的顺序取决于 SQLite 的返回
  顺序，那个顺序没有保证。这个二级键没有任何业务含义，但**确定**。
- **清空回收站的两条 `DELETE` 不在同一个事务里。** 两个模块各自的方法内部已经各起了
  一个事务（`in_transaction` 用的是 SAVEPOINT），而 SAVEPOINT 是可嵌套的 ——
  外面再套一层只会退化成内层 SAVEPOINT，并不会让它们变成原子的。
  真要原子得把事务提上来、让每个模块多暴露一个「无事务」的变体。这个取舍划算：
  失败时最坏是「卡片删掉了、章节还在」，刷新后还剩几条，再点一次即完成。它不是账务
  操作，不存在「扣了钱没到账」那种必须原子性的语义。

**前端侧三处**：卡片与章节的删除确认文案都改成了「可在回收站找回」（原来的「删除后
无法撤销」现在是假的）；回收站的失效范围要带上卡片与章节（恢复一张卡之后卡片库得
跟着更新）；三枚动作按钮（清空回收站 / 恢复 / 彻底删除）在 2026-09-22 统一改成了
**圆形图标钮 + 悬浮提示**，与全项目一致 —— 只有图标，文字进 `Tooltip`，而
`label` 同时充当 `aria-label` 与提示文案。行内那两枚要特别加一条样式
`.trash__actions .app-icon-button { flex: 0 0 auto; }`，否则在 flex 行里会被压成椭圆。

**这一节最该带走的一条**：横切改造的验收标准不是「新功能能用」，而是
**「旧功能在新语义下仍然正确」**。当初为回收站写的那 12 条断言里有一半在测别的东西 ——
书的字数、章节的排序、检索的结果、大纲的显示。它们的写法与新增功能的那一类不同：
不是「做了 A 应该得到 B」，而是「事实变了之后，别处的读数必须跟着变」。

### 8.7 校对与格式整理：纯函数放在哪

**文件**：`src/shared/proofread.ts`（582 行）、`features/chapters/doc-tidy.ts`

这两个都是**纯函数模块**，放在 `shared` 或页面侧而不是 Rust 后端，理由值得记：

```ts
/**
 * 这是纯函数模块：输入一段文本，输出「在哪儿、什么问题」。它刻意不依赖
 * 任何 DOM 或富文本库，原因有三：
 *   1. 后端可以在单测里直接校验规则，不需要起 WebView；
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

### 8.8 自动化验证（冒烟测试没有移植过来）

> **先说清现状**：那份 10,140 行的端到端冒烟测试在重写时被丢下了（见 README
> 「验证与测试」）。它的 128 项断言**从未在这个 Rust 壳里跑通过**，需要时只能从
> git 历史里取回。
>
> **代价是：现在没有任何自动化手段验证界面行为。** 这是整个重写最大的一处退步。
> 本节保留原冒烟测试的**设计立场与三条纪律**——它们与实现壳无关，照做仍然正确——
> 并说明这些纪律应该落到哪里。

**当初为什么需要它**：桌面应用没有 HTTP 端点可以 curl。所以用一条等价路径替代——
**用临时目录跑真实的后端**，把「数据库 → 迁移 → 服务业务规则 → 命令注册 → WebView 真的
渲染出来」整条链路串起来验证一遍。

**核心立场**（写在文件头）：

> 不是「调用了没报错就算通过」，而是构造**已知输入**并校验**精确输出**。例如正文里的
> 汉字个数是数得出来的，统计口径是不是真的对，只有比对精确数字才能验证——
> 「返回了一个正数」这种断言挡不住口径算错。

**三条最有价值的断言纪律**

**① 清单独立写一遍，不从被测对象 import。** 两边一起改错就永远测不出来。
（当时的例子：模块清单在测试里手写一份，不从 `nav.tsx` 取。）

**② 断言必须「等待目标状态」，不能等文案。** 底栏的「已保存」是**状态**不是**事件**——
它可能在你开始等之前就已经是这个值，等待瞬间返回。下面这段是当时那份测试里的写法，
**仓库里已经没有这些符号了**，看的是思路：

```ts
// ❌ 错：底栏状态在进入本函数时**已经是「已保存」**，这个等待瞬间返回，
//       自动保存还有两秒防抖没走完，就已经断言「打完字应该有历史版本」了
await waitForSaveState(window, 'saved', 10_000)

// ✅ 对：轮询后端真实的版本数。它只会在真的写库之后才变化
const after = await waitForRevisionCount(ctx, ctx.chapterId, before + 1, 15_000)
```

**③ 一个块抛异常必须就地接住。** 否则它会穿过播种函数、以**别人的名字**报错，并且
**后面几十条断言一条都不执行**——断言总数会静默少掉几十项（当时是从 116 掉到 92，
那 24 项里包含全部渲染检查）。

**为什么临时数据必须清理干净**（这条踩得很痛）：

> 不删的话它会成为书籍列表里最新的一本，而大纲页与卡片页在没有 `?bookId` 时都回落到
> 「列表里的第一本书」——于是这一次新增的临时书会把那些页面的默认落点整体挪走，
> **后面的渲染断言全部跑到一本空书上**，表现为「情节树未渲染」这种与本次改动毫无关系的红。

**现在该把这几条纪律落到哪里**：下移到 Rust 侧的单测。仓储与服务都是收 `&Connection` 的
自由函数，可以在内存库里构造已知输入、校验精确输出——快、稳、不依赖界面。
README「待办」把这件事列成了第一优先级；写法见 [9.8](#98-加一条单测)。

---

## 9 自定义编码手册

前面都是「读懂」，这一章是「动手」。八个常见改法，每个从易到难给出完整步骤。

### 9.0 共同前提

**改任何东西之前，先记住这条链路**：

```
src/shared/modules/X.ts        ← 契约（类型 + Zod schema）★ 永远从这里开始
      ↓
src-tauri/src/db/migrations.rs ← 需要落库的话加迁移
      ↓
src-tauri/src/modules/X/       ← repository → service → commands
      ↓
src-tauri/src/lib.rs           ← generate_handler![] 注册命令
src/shared/ipc-channels.ts     ← 通道常量
src/shared/api.ts              ← WinbookApi 方法签名
src/renderer/src/lib/tauri-bridge.ts ← call(IpcChannel.X) 转发
      ↓
src/renderer/src/features/X/   ← 页面 + hooks
src/renderer/src/lib/query-keys.ts ← 缓存键
      ↓
（测试：前端 vitest；后端 cargo test / cargo check --release）
```

**改完必跑**：

```bash
npm run typecheck && npm test          # 前端：类型检查 + 单测
cd src-tauri && cargo test             # 后端：编译 + 单测
```

TypeScript 会替你抓出**前端那一侧的**遗漏——改了 `shared` 的类型而没改桥接，前端立刻
编译失败。**但这条保证跨不过 Rust 那道边界**：Rust 侧的入参校验是手写的
（`core/input.rs` 的 `Validator`），改契约时两侧都要动，见
[5.3](#53-service--业务规则与事务)。

### 9.1 给已有实体加一个字段（端到端）

目标：给书籍加一个「标签颜色」。假设叫 `accentColor` 已经存在，我们加 `subtitle`（副标题）。

**① 迁移**（`src-tauri/src/db/migrations.rs` 的 `MIGRATIONS` 末尾追加）：

```rust
Migration {
    name: "011_book_subtitle",
    // ALTER TABLE ADD COLUMN 带非空默认值是 SQLite 支持的常量默认场景，
    // 老数据自动填空串，不需要回填脚本。
    sql: "ALTER TABLE books ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';",
    post: None,
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

**③ 仓储**（`src-tauri/src/modules/books/repository.rs`）：
`insert` / `update` 的参数表与 SQL 各加一处，映射函数 `read_book` 里加一行。

```rust
pub fn insert(
    conn: &Connection,
    title: &str,
    // ...其余参数
    subtitle: &str,          // ← 新增
    now: &str,
) -> AppResult<Book> {
    conn.execute(
        "INSERT INTO books (title, ..., subtitle, created_at, updated_at)
         VALUES (?, ..., ?, ?, ?)",
        rusqlite::params![title, /* ... */ subtitle, now, now],
    )?;
    let id = conn.last_insert_rowid();
    find_by_id(conn, id)?.ok_or_else(|| AppError::internal("新增书籍后无法回读记录"))
}

// 行 → 领域对象的映射：这里是最容易漏的一处
fn read_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    Ok(Book {
        // ...
        subtitle: row.get("subtitle")?,
    })
}
```

> 注意仓储**不接收 input 结构体，而是一串位置参数**——列名与绑定值在同一段代码里挨着写，
> 漏改一眼可见。这也是「不用 ORM」换来的一点好处。

**④ 前端表单**（`features/books/BookFormModal.tsx`）：加一个 `<Form.Item name="subtitle">`。**校验规则不用重写**——直接复用 `bookCreateSchema` 的形状（本项目表单的常见做法是让 antd Form 的 rules 与 shared schema 对齐）。

**⑤ 测试**（后端单测，见 [9.8](#98-加一条单测)）：加一条覆盖「新建时带上 subtitle →
回库对账 → 更新后读回新值」。**别忘了也验一下边界**（超长应被拦）。

**⑥ 验证**：

```bash
npm run typecheck && npm test          # 前端
cd src-tauri && cargo test             # 后端
cd src-tauri && cargo check --release  # ★ 别漏 release
```

**易错点**：
- 忘了改 `read_book` → 数据库里有值，但接口返回里没有。**Rust 侧是手写映射，
  编译器不会替你报错**（这一点比重写前更危险——那时 TS 的 `strict` 会拦下来）。
- `update` 用了 `.default('')` → 前端不传时会被静默填成空串，把用户已填的值擦掉。**`update` 不给 default 是有意的**。
- 迁移名重复或改了已发布的迁移。

### 9.2 加一个完整功能模块（六步）

这是 README「加新功能模块」一节的展开版。以「**时间线**」（把卡片与大纲节点按故事内时间排成一条线）为例。

#### 第 1 步：契约 `src/shared/modules/timeline.ts`

定义一个模块文件该有的全部要素（照 [5.1](#51-srcshared--前端的契约来源) 的解剖结构）：

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

**这一份 schema 只被前端消费**（表单校验 + 类型推导）。
Rust 侧的边界校验是**另写一套**（`core/input.rs` 的 `Validator`），只有人肉对齐——
**规则会漂移**，这是重写后最大的一处退步，见 [5.3](#53-service--业务规则与事务)。

#### 第 2 步：迁移（只在需要新表时）

```ts
{
  name: '011_timeline_entries',
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

#### 第 3 步：三个文件 `src-tauri/src/modules/timeline/`

```
repository.rs   ← 唯一写 SQL：list / find_by_id / insert / update / delete_by_id
service.rs      ← 业务规则 + 事务
commands.rs     ← 只解析 + 调用（#[tauri::command]）
```

每个模块还各有一个 `mod.rs`（声明子模块）与 `models.rs`（行结构体与领域对象）。
参考实现直接抄同构的 `card_links` 模块——它的 `repository.rs` 结构最干净。

#### 第 4 步：接线（四处，一处都不能少）

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

// ③ src/renderer/src/lib/tauri-bridge.ts —— 转发（通道名 → 命令名自动映射）
timeline: {
  list: (query) => call(IpcChannel.TimelineList, query),
  create: (input) => call(IpcChannel.TimelineCreate, input),
  update: (input) => call(IpcChannel.TimelineUpdate, input),
  remove: (input) => call(IpcChannel.TimelineRemove, input)
}
// 然后递增 BRIDGE_VERSION
```

```rust
// ④ src-tauri/src/lib.rs —— generate_handler![] 里登记 4 个命令
tauri::generate_handler![
    // ...
    modules::timeline::commands::timeline_list,
    modules::timeline::commands::timeline_create,
    modules::timeline::commands::timeline_update,
    modules::timeline::commands::timeline_remove,
]
```

**漏了会怎样，两侧不一样**：前端漏改 `api.ts` / 桥接 → **编译失败**，立刻发现；
Rust 侧漏登记命令 → **编译通过**，运行到那一步才报「命令不存在」。
**这是重写后新增的一类坑**——也是为什么 `generate_handler![]` 与 `ipc-channels.ts`
应该摆在一起人工核对（`lib.rs` 目前 64 条，`IpcChannel` 也 64 条）。

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

#### 第 6 步：测试

**① 后端**（`src-tauri/src/modules/timeline/` 下加 `#[cfg(test)] mod tests`，
测试函数名用中文，写法照 `core/text.rs`）：

```rust
#[test]
fn 删除卡片后条目保留但关联置空() {
    let mut conn = Connection::open_in_memory().unwrap();
    db::migrator::run_migrations(&mut conn).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    // ...构造已知输入 → 校验精确输出（覆盖 SET NULL 那条外键语义）
}
```

**② 前端**：如果这个模块有纯函数（排序、分组、格式化），在
`src/renderer/src/.../*.test.ts` 补一个 vitest 用例。

> 原冒烟测试里那份**独立手写的**模块清单已经不在了。将来若重建端到端测试，
> 记得仍然要独立写一遍清单——不要从 `nav.tsx` import。

#### 验证

```bash
npm run typecheck && npm test
cd src-tauri && cargo test && cargo check --release
```

`cargo check --release` 常被漏掉：`open_devtools` 这类函数只在 `debug_assertions` /
`devtools` 特性下存在，debug 编得过不等于 release 编得过。

### 9.3 只加一个命令（在已有模块上加功能）

已有模块上加一个操作，比加模块省事得多。以「通过 ID 批量取章节」为例：

```rust
// ① src-tauri/src/modules/chapters/commands.rs —— 一个命令 + 一段校验
#[tauri::command]
pub fn chapters_list_by_ids(
    state: State<'_, AppState>,
    input: Option<Value>,
) -> IpcResponse<Vec<ChapterListItem>> {
    dispatch("按 ID 批量取章节", "chapters:list-by-ids", || {
        let mut validator = Validator::new(&payload(input));
        let ids = validator.id_array("ids", 500, "一次最多 500 章");
        validator.finish()?;
        let conn = state.connection()?;
        service::list_by_ids(&conn, &ids)
    })
}
```

```ts
// ② src/shared/ipc-channels.ts —— 加通道常量
ChaptersListByIds: 'chapters:list-by-ids',

// ③ src/shared/modules/chapters.ts —— 前端侧的 schema（类型 + 表单校验）
export const chapterListByIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).max(500, '一次最多 500 章')
})
export type ChapterListByIdsInput = z.infer<typeof chapterListByIdsSchema>

// ④ src/shared/api.ts + src/renderer/src/lib/tauri-bridge.ts —— 各加一行
```

```rust
// ⑤ src-tauri/src/lib.rs —— 登记命令
tauri::generate_handler![ /* ... */ chapters_list_by_ids, ]
```

**注意三件事**：

- `IN (?)` 的占位符个数是动态的，用
  `ids.iter().map(|_| "?").collect::<Vec<_>>().join(",")` 拼占位符——
  **但绝不要把 id 的值拼进 SQL**，只拼占位符。
- 通道名 → 命令名的映射是**确定性**的（`:` 与 `-` 变 `_`、驼峰转下划线），
  所以 `chapters:list-by-ids` 自动对应 `chapters_list_by_ids`。
  **命令名不要随手起**，否则映射对不上，而症状是运行时「命令不存在」。
- **校验写两份**：TS 侧 schema 管表单，Rust 侧 `Validator` 管边界。
  这不是重复劳动，是跨壳必然的成本——见 [5.3](#53-service--业务规则与事务)。

### 9.4 加一条迁移

迁移写在 `src-tauri/src/db/migrations.rs` 的 `MIGRATIONS` 数组末尾。三条规矩
（见 [6.1](#61-迁移)），再加五条实操细节：

1. **命名格式**：`0XX_描述`，序号连续。取当前最大序号 +1（现在是 `010`）。
2. **一条迁移只做一件事**，便于失败时定位。多条相关的 DDL 可以放一条（如建表 + 建索引），
   但「加字段」与「搬迁数据」最好分开。
3. **`sql` 里只写 SQL，不写业务逻辑。** 纯 SQL 表达不了的一次性加工（只有 `008` 用到）
   用 `post: Some(|tx| ...)` 挂一个函数，里面直接写 SQL，
   **不要在里面调服务层的函数**——迁移一旦发布就不能改，而服务层会变。
4. **失败即整条回滚**，所以不用自己写清理逻辑。
5. **改完必须验「新装」与「升级」两条路径**：删掉临时库跑一次新装；
   再拿一份旧版建出来的库跑一次升级。
   （重写前这两条靠 `npm run smoke` 一次覆盖，现在得手动各跑一次。）

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

### 9.8 加一条单测

**后端**——照 `core/text.rs` 的写法，`#[cfg(test)] mod tests`，测试函数名用中文：

```rust
#[test]
fn 书籍副标题往返() {
    // 目前还没有仓储/服务的测试脚手架，先自己建一个内存库：
    let mut conn = Connection::open_in_memory().unwrap();
    db::migrator::run_migrations(&mut conn).unwrap();      // 注意要 &mut
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

    let created = service::create(&conn, &已知输入()).unwrap();
    let read = service::get_by_id(&conn, created.id).unwrap();
    assert_eq!(read.subtitle, "已知的副标题");             // ★ 精确值，不是「非空」
}
```

**前端**——vitest，纯函数，已知输入 → 精确输出：

```ts
expect(countHanzi('甲乙')).toBe(2)
```

**三条纪律**（与实现壳无关，照做仍然正确）：

1. **等目标状态，不等文案**。要等「保存完成」，就去轮询数据库里的确定性状态，
   不要等底栏文本。
2. **块内抛异常必须就地接住**。`#[test]` 里这条由框架保证，但自己写的「批量断言」
   循环里仍需显式接住，否则后面几十条会静默消失。
3. **临时数据必须清理干净**。用 `Connection::open_in_memory()` 时天然不会污染真实库；
   一旦落到临时文件目录，记得在最后删掉。

**要验「拦截」类行为，必须走真实的命令边界**：校验统一收口在 `Validator` + `dispatch`，
服务层不重复做——**直接调服务层测不到「非法数据被拒」**。

---

## 10 约定速查

### 10.1 十八条硬约定

**契约与分层**

1. **`src/shared` 是前端契约的唯一来源。** 类型、Zod schema、常量、纯函数都在这里。
   但要注意：**Rust 侧的边界校验要照着它再写一遍**（`core/input.rs` 的 `Validator`）——
   两侧的一致性靠人肉对齐，见 [5.3](#53-service--业务规则与事务)。
2. **命令层不写业务逻辑，不吞异常。** 每个 `#[tauri::command]` 只做
   「`dispatch` → 解析/校验 → 调 service → 返回信封」，并带一个中文 `label`。
3. **Service 不依赖 Tauri 与框架类型。** 例外只有 `exporter` / `backup`
   （需要 `dialog` 与 `AppHandle`），它们被单独隔离。
4. **Repository 是唯一写 SQL 的地方**，且只做「执行 SQL + 行 → 对象映射」，不含业务判断。
5. **校验统一收口在命令边界（`Validator` + `dispatch`）**，服务层不重复校验。推论：
   **直接调服务层测不到校验**，凡「拦截」类用例都要走真实边界。
6. **枚举用 `as const` 数组 + `typeof[number]` + 类型守卫**（TS 侧），Zod 侧用
   `z.string().refine()` 而不是 `z.enum()`（要中文报错文案）。

**数据库**

7. **迁移只允许末尾追加，已发布的禁止修改。** 老用户的库不会重跑已应用的迁移。
8. **CHECK 只覆盖结构性不变式**（非空 / 非负 / 取值范围），**不覆盖枚举值域**
   （SQLite 无法 ALTER CHECK）。枚举由 shared 的 Zod 与 Rust 的 `Validator` 各自强制。
9. **派生字段必须与来源在同一条 UPDATE 内写入。** `content_html` 一变，
   `content_text` / `hanzi_count` / `char_count` 必须在同一条语句里跟着变。
10. **派生值只由后端算。** 前端算的字数不落库——后端回传的字数才是权威口径。
11. **`PRAGMA foreign_keys = ON` 必须开着。** 本项目大量依赖 `ON DELETE CASCADE`，
    关掉会留下一堆孤儿行。
12. **外键的删除行为逐个想清楚**：`CASCADE`（从属数据）/ `SET NULL`（保留记录、失去归属）
    / `RESTRICT`（禁止删除）。

**通道与前端**

13. **`null` 不是 `undefined`。** Zod 的 `.default()` 只对 `undefined` 生效，拦不住 `null`；
    Rust 侧同理——`Validator::tri_state_id` 就是为了区分「不传 / null / 数字」三态。
14. **`update` schema 不给 `.default()`。** 整体替换语义下，default 会把用户已填的值静默擦掉。
15. **通道名只用 `IpcChannel` 常量**，禁止裸字符串；命令名必须能由通道名**确定性映射**得到，
    且已在 `generate_handler![]` 里登记。改 `WinbookApi` 形状要递增 `BRIDGE_VERSION`。
16. **自动保存不整体失效查询，走就地写回。** 失效必然带来重取，重取正文就会顶掉光标。

**测试**

17. **清单独立写一遍，不从被测对象 import。** 两边一起改错永远测不出来。
18. **断言等目标状态，不等文案。** 文案是呈现，状态才是事实。

> 上面 18 条里有几条是「同一枚硬币的两面」，README 的「架构约定」一节按主题展开，
> 并逐条给了踩坑现场。

### 10.2 五个最容易踩的坑

**① `null` 与 `undefined` 混用导致整页查询被拒。**
`books:list` 的 `status` 一开始只写了 `z.string()`，而前端传 `null` 表示不筛选。结果每次
查询都被边界校验拒掉，前端把失败降级成空下拉、页面照常渲染——**缺陷只留在后端日志里**。
修法是 `.nullable()`（Rust 侧是 `Validator::tri_state_id`）。

**② 忘记在「行 → 对象」的映射函数里加新字段。**
数据库里有值，接口返回里没有。重写前 TS 的 `strict` 会把它拦下来；
**Rust 侧是手写映射，编译器不会替你报错**——这是重写后新出现的一类静默失败。
改表结构时，务必回头看一眼 `read_book` 这类函数。

**③ 用 `setContent()` 换章节内容。**
会先渲染上一章再替换（闪一下），而且容易把「用户刚敲的字」和「新章节的正文」搞混。
**用 `chapterKey` 触发重建。**

**④ Rust 侧漏登记命令：前端不报错，运行期才炸。**
`generate_handler![]` 里少一个命令名，编译照样通过，只有真正调到那个通道时才报
「命令不存在」。**加命令时把 `lib.rs` 与 `ipc-channels.ts` 对着数一遍**（现在都是 64 条）。

**⑤ 临时测试数据没清理干净。**
它会成为「列表里的第一本书」，而多个页面在没有 `?bookId` 时都回落到第一本——于是后续
断言全部跑到空数据上，报出与本次改动毫无关系的红。
用 `Connection::open_in_memory()` 可以从根上避免这件事。

---

## 11 质量门与打包发布

### 三道质量门

```
① npm run typecheck                    前端全量类型检查（tsc -p tsconfig.web.json），0 错误
② npm test                             前端单测（vitest，7 个文件 / 114 条）
③ cd src-tauri && cargo test           后端单测（目前只有 core/text.rs 的 5 条）
   cd src-tauri && cargo check --release   两个 profile 都要编得过
```

> `cargo test` 会**连 doctest 一起跑**，而 rustdoc 把文档注释里「空行 + 缩进 4 空格」
> 的段落当成 Rust 代码去编译。一句中文示意图放在这种位置就会让 `cargo test` 直接失败，
> 而 `cargo check` 一声不吭 —— `src/modules/search/repository.rs` 里就埋伏过一处。
> 这类块要么标成 ` ```text `，要么别用空行把它独立成段。

**什么时候用哪个**：

| 场景 | 用哪个 |
|---|---|
| 改了纯函数（`text.ts` / `proofread.ts` / `revision-diff.ts` / `datetime.ts`） | `npm test` —— 快，毫秒级 |
| 改了仓储的 SQL / 服务规则 | `cargo test`（**目前还没有仓储与服务的测试脚手架**，见 README「待办」） |
| 改了跨壳契约（`src/shared` / 命令签名 / 通道名） | 三道全跑。前端 typecheck 只能抓到一半，Rust 侧靠 `cargo check` 加人工核对 |
| 改了界面 | **没有自动化手段**——只能手动点一遍（原冒烟测试没有移植过来，见 [8.8](#88-自动化验证冒烟测试没有移植过来)） |
| 准备提交 / 发版 | 三道全跑 |

**为什么 `cargo check --release` 不能省**：`open_devtools` 这类函数只在
`debug_assertions` / `devtools` 特性下存在，debug 编得过不等于 release 编得过。

### 打包

```bash
npm run tauri:build     # 前端构建 + Rust release 编译 → NSIS 安装包
```

产物在 `src-tauri/target/release/bundle/nsis/`。实测大小：主程序 **7.1 MB**
（7,068,160 字节）、安装包 **3.1 MB**（3,139,648 字节；重写前是安装包 127 MB、
解包后约 390 MB）。给出字节数是为了以后不再为「MB 还是 MiB」扯皮。

**`tauri-cli` 必须与 `tauri` crate 对齐到同一个 minor。** 打包时 CLI 要去二进制里
找字符串占位 `__TAURI_BUNDLE_TYPE_VAR_UNK`（来自 tauri-utils `platform.rs` 的
`#[used] static mut __TAURI_BUNDLE_TYPE`）并把它替换成真正的 bundle 类型；版本不匹配、
找不到占位时报：

```
Binary parse error: ... __TAURI_BUNDLE_TYPE variable not found in binary.
Make sure tauri crate and tauri-cli are up to date.
```

本例实测：CLI 停在 `2.9.0` 而 crate 已经到 `2.12.0` 时会踩到；把
`@tauri-apps/cli` 升到 `^2.12.0` 之后，打包日志里恢复成正常的一行
`Info Patching ... with bundle type information: nsis`。**升 CLI 之后要重跑一次
`tauri build` 才算验证过** —— 这个补丁失败只发生在打包阶段，`cargo check` 与
`tauri dev` 都不会暴露。

**四件必须记住的事**（都在 `src-tauri/tauri.conf.json` 里）：

```jsonc
{
  "build": {
    "beforeBuildCommand": "npm run typecheck && npm run build:web",
    "frontendDist": "../dist"
  },
  "bundle": {
    "targets": ["nsis"],
    "icon": ["icons/32.png", "icons/128.png", "icons/256.png", "icons/icon.ico"]
  },
  "app": {
    "security": { "csp": null }     // ★ 一处已知欠账：CSP 还没启用
  }
}
```

**卸载不会碰用户数据**：`winbook.db` 在用户数据目录下，不在安装目录里，NSIS 卸载
碰不到它。这一点必须保证——多年创作不该一键蒸发。

---

## 附录 A 文件地图

按「你想改什么」索引：

| 我想改… | 去哪个文件 |
|---|---|
| 某个字段的校验规则 / 上限 | `src/shared/modules/<模块>.ts`（前端）+ `src-tauri/src/modules/<模块>/commands.rs` 里的 `Validator` |
| 数据库表结构 | `src-tauri/src/db/migrations.rs`（末尾追加） |
| 数据库连接参数 / pragma | `src-tauri/src/db/mod.rs` |
| 某个查询的 SQL | `src-tauri/src/modules/<模块>/repository.rs` |
| 业务规则 / 事务边界 | `src-tauri/src/modules/<模块>/service.rs` |
| 某个通道的行为 | `src-tauri/src/modules/<模块>/commands.rs` |
| 命令清单 / 注册 | `src-tauri/src/lib.rs` 的 `generate_handler![]` |
| 入参校验 / 错误信封 / 日志 | `src-tauri/src/core/input.rs`、`core/response.rs`、`core/dispatch.rs` |
| 通道名常量 | `src/shared/ipc-channels.ts` |
| 桥接暴露的 API 形状 | `src/shared/api.ts` + `src/renderer/src/lib/tauri-bridge.ts` |
| 平台权限（能用哪些系统能力） | `src-tauri/capabilities/default.json` |
| 窗口行为 | `src-tauri/tauri.conf.json` 的 `app.windows` |
| 启动流程 / 优雅停机 | `src-tauri/src/lib.rs` + `src-tauri/src/db/mod.rs` 的 `close` |
| 环境变量 | `src-tauri/src/config.rs` + `.env.example` |
| 日志格式 / 脱敏规则 | `src-tauri/src/core/logger.rs` |
| 错误码 | `src/shared/result.ts` + `src-tauri/src/core/errors.rs` |
| 汉字计数 / HTML 转文本 | `src/shared/text.ts`（前端）+ `src-tauri/src/core/text.rs`（后端，两份手写实现） |
| 路由 | `src/renderer/src/App.tsx` |
| 模块导航 | `src/renderer/src/components/nav.tsx` |
| 应用外壳 / 滚动区 | `src/renderer/src/components/AppShell.tsx` |
| 缓存键 / 失效策略 | `src/renderer/src/lib/query-keys.ts` |
| React Query 全局默认 | `src/renderer/src/lib/query-client.ts` |
| 桥接与错误类型 | `src/renderer/src/lib/tauri-bridge.ts` + `lib/api-client.ts` |
| 主题 / 设计令牌 | `src/renderer/src/theme/tokens.ts` |
| 全局样式 | `src/renderer/src/styles.css` |
| 正文编辑器 | `features/chapters/RichTextEditor.tsx` |
| 自动保存 / 编辑器页面 | `features/chapters/ChapterEditorPage.tsx` |
| 写作会话采集 | `features/chapters/use-writing-session.ts` |
| 校对规则 | `src/shared/proofread.ts` |
| 「删除」是软的还是硬的 / 回收站能收哪些实体 | `src-tauri/src/modules/trash/service.rs` |
| 已删除的行为什么还在某处出现 | 搜 `deleted_at`：`cards/repository.rs` 的过滤、`chapters/repository.rs` 的容器条件，以及 `books` / `volumes` / `outline` / `card_links` / `search` 各自的聚合与 JOIN |
| 一键格式整理 | `features/chapters/doc-tidy.ts` |
| 前端单测 | `src/renderer/src/**/*.test.ts` |
| 后端单测 | 各模块内的 `#[cfg(test)]`，目前只有 `core/text.rs` |
| 前端构建配置 | `vite.config.ts` |
| 编译器开关 | `tsconfig.base.json` |
| 打包配置 | `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` |

## 附录 B 命令速查

```bash
# 开发
npm run tauri:dev             # 起 WebView + 编译 Rust；前端有 HMR
npm run dev:web               # 只起前端（浏览器里看 UI，但桥接不可用）

# 检查
npm run typecheck             # 前端全量类型检查（tsc -p tsconfig.web.json）
npm test                      # 前端单测
npm test -- text              # 只跑文件名匹配 text 的单测
cd src-tauri && cargo test    # 后端单测
cd src-tauri && cargo check --release   # ★ 两个 profile 都编一遍

# 构建与打包
npm run build:web             # 只构建前端到 dist/
npm run tauri:build           # 前端 + Rust 全量打包 → NSIS 安装包
npm run clean                 # 删前端产物 dist/
npm run clean:tauri           # 删 Rust 产物 target/
```

**带环境变量跑**（在 `.env` 里写，或临时前缀）：

```bash
# 关闭硬件加速（无 GPU 环境）
WINBOOK_DISABLE_GPU=true npm run tauri:dev

# 指定用户数据目录（换库、或跑一份干净的实例）
WINBOOK_USER_DATA_DIR=D:/tmp/winbook npm run tauri:dev
```

> **图标不再有生成脚本。** `src-tauri/icons/` 下的多尺寸 png / ico 是手工维护的，
> 需要改图标时直接替换那几个文件。
>
> 重写前的 `npm run smoke`（128 项端到端断言）与 `npm run icons` 没有带过来。

## 附录 C 术语表

| 术语 | 含义 |
|---|---|
| **契约（contract）** | `src/shared/modules/*.ts` 里的类型 + Zod schema。**只对前端有效**，Rust 侧另有一套手写校验 |
| **信封（envelope）** | `IpcResponse<T>`，即 `{ ok: true, data }` 或 `{ ok: false, error }` |
| **命令（command）** | `#[tauri::command]` 标注的 Rust 函数，在 `lib.rs` 里注册后前端才能按名字调 |
| **通道（channel）** | `IpcChannel` 里的常量字符串，如 `'books:list'`；由 `tauri-bridge.ts` 确定性映射成命令名 |
| **控制器 / 服务 / 仓储** | 三层：解析与校验 / 业务规则与事务 / SQL 与行映射 |
| **组合根（composition root）** | `src-tauri/src/lib.rs` 的 `generate_handler![]`，全局唯一的接线处 |
| **派生字段** | 可以从其它字段算出来的列，如 `content_text` / `hanzi_count` |
| **不变式（invariant）** | 必须始终成立的约束，如「改正文必须同步改三个派生字段」 |
| **锚点（anchor）** | `data-testid` 属性，供测试与自动化定位元素 |
| **锚定字段（anchor field）** | 检索结果里命中了关键词的那些字段，决定展示标题与片段 |
| **流失路由（flush route）** | 占满内容区、自己管滚动的路由，见 `AppShell.tsx` |
| **基准（baseline）** | 历史版本去重时用来比较的那份正文，见 [8.5](#85-章节历史版本一个完整功能的样板) |
| **乐观更新** | 先改本地缓存再发请求，失败回滚 |
| **冒烟测试（已移除）** | 重写前的端到端自检（临时目录跑真后端 + 真渲染），没有移植过来，见 [8.8](#88-自动化验证冒烟测试没有移植过来) |

## 附录 D 按难度的源码阅读顺序

**第一遍（半天）—— 理解骨架，不用管细节**

1. `README.md` 的「架构约定」一节
2. `src/shared/result.ts` —— 错误码与信封（TS 侧）
3. `src-tauri/src/core/response.rs`（92 行）—— 信封与错误码（Rust 侧）
4. `src-tauri/src/core/dispatch.rs`（134 行）—— 每个命令都要过的闸门
5. `src/shared/ipc-channels.ts` —— 64 个通道，一眼看清应用有哪些能力
6. `src-tauri/src/lib.rs`（269 行）—— 组合根，`generate_handler![]` 注册了 64 个命令
7. `src/renderer/src/lib/tauri-bridge.ts` —— 通道名 → 命令名的映射与 `call`
8. `src/renderer/src/App.tsx` —— 路由与 Provider 层

**第二遍（一天）—— 走通一条完整链路**

9. `src/shared/modules/books.ts` —— 契约的完整解剖
10. `src-tauri/src/modules/books/commands.rs`（282 行）—— 命令层有多薄
11. `src-tauri/src/modules/books/service.rs`（152 行）—— 服务层
12. `src-tauri/src/modules/books/repository.rs`（416 行）—— 仓储的全部手法
13. `src-tauri/src/core/input.rs`（462 行）—— 边验证边记账的 `Validator`
14. `src/renderer/src/lib/api-client.ts` + `query-client.ts` —— 拆信封与重试策略
15. `src/renderer/src/lib/query-keys.ts` —— ★ 前端设计的核心
16. `src/renderer/src/features/books/use-books.ts` —— hooks 的固定写法
17. `src/renderer/src/features/books/BooksPage.tsx` —— 一个完整页面

**第三遍（两天）—— 深入核心子系统**

18. `src-tauri/src/core/text.rs`（228 行）—— 汉字口径（Rust 侧），文件内已有 5 条单测
19. `src/shared/text.ts` —— 同一口径的前端实现（两份手写，见 README「待办」）
20. `src-tauri/src/db/migrator.rs`（113 行）+ `db/migrations.rs`（467 行）—— ★ 逐条注释都值得读
21. `src-tauri/src/modules/chapters/service.rs`（676 行）—— 最核心的业务逻辑
22. `src-tauri/src/modules/chapters/revision_repository.rs`（134 行）—— 窗口函数与剪枝
23. `src/renderer/src/features/chapters/RichTextEditor.tsx` —— 编辑器
24. `src/renderer/src/features/chapters/ChapterEditorPage.tsx` —— 最大组件，先读「自动保存」那一段
25. `src-tauri/src/modules/outline/service.rs`（597 行）—— 树的算法
26. `src/renderer/src/features/chapters/revision-diff.ts` + `.test.ts` —— 一个纯函数模块的完整样本

**第四遍（可选）—— 构建与打包**

27. `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` —— 壳与依赖
28. `vite.config.ts` —— 前端构建（注意 `base: './'` 这一条）
29. `README.md` 全读 —— 这时候每个「为什么」你都能对上一段真实代码

---

**最后一句**：这个项目里注释比代码值钱。`chapters/service.rs` 的 `keep_snapshot` 有 60 行注释、20 行代码——那 60 行记录的是**三次试错**，读完能省下你自己踩那三次的时间。改代码前先读注释。
