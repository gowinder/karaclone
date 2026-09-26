# Karakeep 纯 Cloudflare 免费层移植可行性审计

审计日期：2026-09-02  
Karakeep 审计版本：`5a2f009e2f6d266087f2f3f527e6e384cefd6de4`（2026-08-31）

## 0. 需求收缩后的复审结论（2026-09-02）

用户进一步确认目标不是迁移完整 Karakeep，而是：

- 单用户、每天约几个 URL；
- 只保存 URL、标题、简介、预览图和标签；
- AI 根据 URL 内容自动打标签，并可按标题、URL、简介和标签搜索；
- 官方移动客户端和浏览器扩展尽量不修改；
- Web 端保留 Karakeep 的主要书签界面，但允许删除阅读器、归档、OCR、PDF、视频、RSS、Webhook、规则等功能；
- 所有关键路径必须在 Cloudflare 免费层内有不依赖 Browser Run 的退路。

在这个边界下，结论从完整移植的 **No-Go** 改为：

> **版本锁定的 Karakeep 协议兼容轻量服务：Go，工程可行性约 8.5/10。**  
> **对未来任意版本官方客户端“永久完全兼容”：无法承诺。**

这两句话必须同时成立。官方客户端使用的是仓库内部 tRPC `AppRouter` 类型和 procedure 名称，不是有长期兼容承诺的稳定公共协议；因此可对审计版本及选定客户端版本做兼容测试，但客户端升级后若新增 procedure 或修改 schema，兼容层也必须同步。

### 0.1 原决定性阻断在新目标中的状态

| 原阻断 | 新目标处理 | 是否仍阻断 |
|---|---|---|
| `yt-dlp`、视频下载 | 整体删除 | 否 |
| PDF 截图、OCR、Ghostscript | 整体删除 | 否 |
| `better-sqlite3` | 不移植，按 D1 重新建模 | 否 |
| Playwright/Browser Run | 不进入关键路径 | 否 |
| Meilisearch | 用 D1 FTS5 重写基础全文搜索 | 否 |
| bcrypt 密码登录 | 客户端直接使用 API Key；不实现密码换 Key | 否 |
| 原 Next.js 服务端 | 不能原样复用；需做 UI 级 fork | 是工程量，不是平台阻断 |

### 0.2 Browser Run 在原项目里做什么

Karakeep 的浏览器抓取用于执行 JavaScript、绕过部分普通抓取限制、提取最终 DOM、正文、截图和 PDF。它服务的是“离线保存页面/阅读器/截图”，并不是保存 URL 或创建标签的协议前置条件。

新方案不调用 Browser Run：

1. 先用 Worker `fetch()` 获取页面；
2. 用 Workers 原生流式 `HTMLRewriter` 提取 `<title>`、description、Open Graph 标题/简介/图片和 favicon；
3. 需要正文时调用 Jina Reader；
4. Jina 失败时仅用 URL、域名、客户端传来的标题和直接抓到的元数据生成标签；
5. 上述步骤全部失败时，仍保存 URL，只把抓取状态设为 failure，不能回滚书签。

因此 Browser Run 免费层每天 10 分钟的额度不再影响系统可用性。它最多可以作为以后“手动生成截图”的可选增强，默认不开启。

Cloudflare 的 `HTMLRewriter` 是 Worker 内置流式 HTML 解析 API，不需要 jsdom、Chromium 或容器：

- [HTMLRewriter 官方文档](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
- [Browser Run 定价与免费额度](https://developers.cloudflare.com/browser-run/pricing/)

### 0.3 Jina Reader 的正确定位

Jina Reader 适合作为“正文增强器”，但不应成为保存书签的硬依赖：

- `https://r.jina.ai/<URL>` 可返回 URL、标题和清洗后的正文；
- 当前无 Key 基础用量为 20 RPM，远高于个人每天几个 URL 的需求；
- 支持 `X-Token-Budget` 限制输出，避免把整篇长文送入 LLM；
- 默认抓取可能使用浏览器引擎，平均延迟约 7.9 秒，所以应放在 Queue 消费者而不是保存请求内；
- 第三方服务的免费策略、可用性和站点覆盖可能变化，不能构成唯一抓取路径。

官方依据：[Jina Reader API](https://jina.ai/reader/)

推荐把 Jina 返回正文截断为约 4,000 输入 token。即使 Jina 超时、限流或以后取消免费层，系统仍能保存 URL，并可根据标题、域名和 description 做较粗的 AI 标签。

### 0.4 AI 自动标签在免费层可行

原 Karakeep 的标签链路本质上也是：读取 URL、标题、description 和正文，要求 LLM 返回 `{ "tags": string[] }`，规范化标签后以 `attachedBy: "ai"` 关联到书签。这个行为可在 Worker 中等价重写，不依赖原 inference worker。

推荐链路：

`createBookmark -> D1 写入 pending -> Queue(bookmarkId) -> 元数据/Jina -> Workers AI -> D1 写 tags -> taggingStatus=success`

Workers AI 当前免费额度为每天 10,000 Neurons。以 `@cf/meta/llama-3.2-3b-instruct` 的公开费率估算，单次 4,000 输入 token + 100 输出 token 约消耗 21.5 Neurons；每天 5 个 URL 约 108 Neurons，和免费额度相差近两个数量级。实际消耗依模型和输入长度变化，所以仍应设置输入截断、`max_tokens`，并把 AI 失败设计成可重试而不是保存失败。

- [Workers AI 定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Queues 免费层与计费](https://developers.cloudflare.com/queues/platform/pricing/)

若更看重中文标签质量，可支持用户自带 OpenAI-compatible API Key；这不改变 Karakeep 客户端协议，只改变后台推理提供商。

### 0.5 官方客户端与 Web 前端不是同一个兼容难度

官方浏览器扩展和移动端是真正的远程 API 客户端，均连接 `{server}/api/trpc`，使用 tRPC batch、SuperJSON 和 Bearer API Key。两者登录页都允许直接粘贴 API Key，因此可完全绕开 bcrypt、注册和 NextAuth。

但官方 Web 应用不是一个可配置远端地址的 SPA：

- 浏览器端写死使用同源 `/api/trpc`；
- React Server Components 直接导入服务端 `AppRouter`；
- NextAuth adapter 直接导入 `@karakeep/db`；
- 当前数据库包依赖 `better-sqlite3`。

所以“写一个兼容 API，然后原 Web 包不改直接部署”仍然不可行。可行做法是 fork Web UI：保留书签卡片、标签、搜索和布局组件，把数据层改为 API Key + 远端 tRPC，并移除服务端会话、阅读器、资产上传等不需要的路由。Cloudflare 当前支持 Next.js 16 经 vinext/Workers 部署，但框架可部署不代表 Karakeep 的 Node 数据层自动兼容。

- [Karakeep Web tRPC provider](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/web/lib/providers.tsx)
- [Karakeep Web 服务端 tRPC](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/web/server/api/trpc.ts)
- [Karakeep NextAuth 数据库耦合](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/web/server/auth.ts)
- [Cloudflare Next.js 指南](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)

### 0.6 版本锁定后的最小兼容面

浏览器扩展只做“保存 URL + 查看/编辑标签”时，至少实现：

- `apiKeys.validate`、`apiKeys.revoke`；
- `users.whoami`；
- `config.clientConfig`；
- `bookmarks.createBookmark`、`bookmarks.checkUrl`、`bookmarks.getBookmark`、`bookmarks.getBookmarks`、`bookmarks.searchBookmarks`、`bookmarks.updateBookmark`、`bookmarks.deleteBookmark`、`bookmarks.updateTags`；
- `tags.list`、`tags.get`、`tags.create`、`tags.update`、`tags.delete`；
- 对扩展会探测但本项目不启用的 lists procedure 返回兼容的空结果。

移动端会额外进入列表、统计、高亮、阅读进度和用户设置页面。要让整个移动端导航不报错，还需要为这些 procedure 提供真实实现或 schema 兼容的空/默认返回。不能只实现 `createBookmark` 就宣称“移动客户端兼容”。

验收标准应固定为某个移动端和扩展版本，记录客户端实际发出的 procedure 清单，并用协议契约测试逐一验证 tRPC batch envelope、SuperJSON 日期、错误码、游标和返回字段。

### 0.7 新目标的推荐 Cloudflare 架构

| 组件 | 用途 | 是否关键 |
|---|---|---|
| Workers + Static Assets | tRPC API 和精简 Web UI | 是 |
| D1 | 用户、API Key、书签、标签、关联、FTS5 | 是 |
| Queues | 抓取和 AI 标签异步任务，只传 bookmarkId | 是 |
| Workers AI | 默认标签生成 | 是，但可用 BYOK 替代 |
| R2 | 可选 favicon/OG 图片代理缓存；首版可不用 | 否 |
| KV | 配置、短 TTL 抓取缓存、幂等辅助；不可作书签真源 | 否 |
| Browser Run | 默认不部署 | 否 |
| Pages | 仅在 Web 做纯静态 SPA 时可选；否则直接 Workers | 否 |

最低风险的首版甚至只需要 Workers、D1、Queues、Workers AI。OG 图片可以直接保存远端 URL，R2 和 KV 都不是开工前置条件。

### 0.8 仍需接受的限制

1. 动态站、登录墙、反爬站可能只得到标题或什么也得不到，但 URL 一定保存。
2. 没有 Browser Run 就不保证截图；卡片可显示 OG 图片，没有则显示默认背景。
3. Jina 是可替换的第三方增强，不提供永久免费或全站可抓的保证。
4. 官方客户端升级可能破坏 tRPC 兼容，必须锁定版本并维护兼容层。
5. 原 Web 应用必须 fork 数据层；不能把现成 `apps/web` 原封不动部署。
6. “功能入口仍显示但后端返回空结果”只能作为过渡。最终应在 fork Web UI 中隐藏未实现功能，移动端则接受部分页面无数据，或继续补齐对应轻量 procedure。

在接受以上限制后，当前没有发现会导致项目做到一半必然停止的免费层硬阻断。

## 1. 最终结论

### 1.1 完整移植：No-Go

如果“完全可行”指以下条件同时成立：

- 保留当前 Karakeep Web 界面和服务端；
- 保留网页抓取、动态页面渲染、正文提取、截图、PDF、SingleFile、图片 OCR、PDF 处理、视频下载、全文检索、AI、备份、导入、RSS、Webhook、规则等现有功能；
- 官方移动客户端和浏览器插件无需修改；
- 全部部署在 Cloudflare；
- 永远只使用免费层，不使用 VPS、Cloudflare Containers 或外部付费服务；

则结论是 **不可行，而且不是“优化后也许可行”，而是存在确定性平台缺口**。

决定性阻断有四个：

1. Karakeep 的视频下载调用 `yt-dlp` 外部进程，PDF 截图依赖 Ghostscript/GraphicsMagick，现有数据库依赖原生 `better-sqlite3`。Workers 没有可供这些程序运行的通用 OS 进程/原生二进制环境；能承载它们的 Cloudflare Containers 免费层为 `N/A`。
2. Workers Free 的普通 HTTP、Cron CPU 上限为每次 10 ms。Karakeep 的 SSR、bcrypt 密码登录、HTML DOM 解析、Readability、metascraper、OCR、PDF 解析、压缩备份均不能可靠地满足这个上限。
3. Browser Run Free 只有每天 10 分钟，超过后直接返回 429，无法保证每个链接都完成浏览器抓取。免费计划也不能购买超额量，只有升级 Workers Paid 才能扩容。
4. 当前 Karakeep 不是可直接部署的 Worker：数据库、队列、资源存储、搜索和全部后台 worker 都是 Node/VPS 模型。即使 Next.js 16 可经 vinext 部署，Karakeep 的这些应用依赖仍必须重写。

因此，**不建议启动“完整 Karakeep 纯免费迁移”项目**。它会在视频/PDF/OCR/浏览器配额中至少一个位置必然失去功能对等。

### 1.2 原审计中的精简核心：有条件 Go

本小节保留第一次审计时的边界作为对照；最新结论和实施边界以第 0 节为准。

如果目标改为：

- 官方移动客户端和浏览器插件可以连接；
- 保留 Karakeep 的 tRPC + SuperJSON + Bearer API Key 通讯协议及核心返回结构；
- 保留链接、文本、图片/PDF上传、标签、列表、高亮、收藏、归档、阅读进度和基础全文搜索；
- 浏览器插件优先在客户端用 SingleFile 抓取页面；
- 普通 URL 仅保证“保存链接”，服务端浏览器抓取是有额度的增强功能；
- 明确取消或降级视频下载、服务器 OCR、PDF 首屏转图、AI、Meilisearch 语义检索、完整备份 worker、原 Web SSR 和密码换 Key；

则可以在 Cloudflare 免费层制作一个 **Karakeep 协议兼容的精简后端**。这不是“迁移原项目”，而是依据 Karakeep 协议和数据模型重新实现一套小型服务。

对个人低频使用，其工程可行性约为 **7/10**；对“所有功能完全一致”的可行性为 **0/10**。

## 2. 源码事实

### 2.1 系统不是单体网页应用

当前仓库由以下部分组成：

- Next.js 16 Web 应用；
- Hono `/api` 服务；
- tRPC `/api/trpc`；
- REST `/api/v1` 和资源 `/api/assets`；
- 独立移动客户端、浏览器扩展和 CLI；
- 独立后台 Workers 进程；
- SQLite + Drizzle；
- S3/文件系统资源存储；
- Liteque/Restate 队列；
- Meilisearch 搜索和向量插件。

服务端路由聚合了 18 个 tRPC 子路由；源码中有约 28 张 SQLite 表、1,337 行 schema、26 处显式事务调用。官方移动端和扩展经共享 hooks 直接引用约 50 个 tRPC procedure，并非只有“保存书签”一个接口。

证据：

- [tRPC 路由总入口](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/trpc/routers/_app.ts)
- [数据库 schema](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/db/schema.ts)
- [Hono API 总入口](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/api/index.ts)
- [后台 worker 依赖](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/package.json)

### 2.2 客户端通讯协议可以复刻

浏览器扩展使用：

- 地址：`{server}/api/trpc`；
- tRPC `httpBatchLink`；
- SuperJSON transformer；
- `Authorization: Bearer <api-key>`；
- 资源上传：`POST {server}/api/assets`，multipart/form-data；
- 资源读取：`GET {server}/api/assets/:assetId`。

这部分没有依赖私有二进制协议。只要 procedure 名称、批处理格式、SuperJSON 日期序列化、错误 envelope、输入输出 schema 和 HTTP 路径保持兼容，官方客户端可以连接到重写后的 Worker。

证据：

- [扩展 tRPC 客户端](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/browser-extension/src/utils/trpc.ts)
- [SingleFile 上传](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/browser-extension/src/utils/singlefile.ts)
- [移动端资源上传](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/mobile/lib/upload.ts)

但“协议兼容”不等于只实现几个 REST 接口。最低兼容面包含：API Key、config、users、bookmarks、assets、tags、lists、highlights；移动端 UI 还会调用 rules、统计、搜索、阅读进度等 procedure。

### 2.3 保存链接与抓取是异步的

`bookmarks.createBookmark` 先在事务内写入书签，再强制把链接加入 crawler 队列；对文本加入 AI/embedding 队列，对图片/PDF 加入预处理队列。因此原实现与 Cloudflare Queues 的模型相似，但代码不能原封不动复用。

值得利用的是：最新浏览器扩展可选择在客户端使用 SingleFile 抓取当前页面，先把 HTML 上传为 `precrawledArchiveId`；抓取失败时会回退为普通链接并继续保存。这意味着精简方案可以把大部分浏览器抓取计算转移到用户浏览器，而不依赖 Browser Run。

证据：

- [书签创建和入队](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/trpc/routers/bookmarks.ts#L241)
- [扩展客户端抓取及失败回退](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/browser-extension/src/SavePage.tsx#L124)

### 2.4 原后台任务包含不可移植工作

| Karakeep 工作 | 当前实现 | 免费 Cloudflare 判断 |
|---|---|---|
| 动态网页抓取 | Playwright/Chrome、stealth、adblock、autoconsent | Browser Run 可重写，但每天仅 10 分钟，不能保证 |
| HTML 正文和元数据 | jsdom、Readability、DOMPurify、metascraper，另启解析子进程 | 不能原样运行；纯 JS 重写后仍有 10 ms/128 MB 风险 |
| 截图/PDF | Playwright | Browser Run 能生成，但共用 10 分钟/日额度 |
| SingleFile/monolith | 外部程序/浏览器路径 | 插件端 SingleFile 可替代一部分；服务端完整归档不能保证 |
| 图片 OCR | Tesseract.js 或外部 LLM | Tesseract 明显超出普通免费 Worker CPU；AI 也有独立额度 |
| PDF 文本 | pdf2json/pdfjs | 小 PDF 可尝试队列纯 JS，不能作免费可靠承诺 |
| PDF 首屏图 | pdf2pic + Ghostscript/GraphicsMagick | 无免费 Cloudflare 执行环境，确定性 No-Go |
| 视频保存 | `execa("yt-dlp")` | 无免费 Cloudflare 执行环境，确定性 No-Go |
| 备份 | archiver + 临时文件 | 可重新设计为流式导出，但不是原 worker，CPU/内存有风险 |
| 搜索 | Meilisearch 插件 | Cloudflare 无托管 Meilisearch；需改 D1 FTS5 |
| 语义搜索 | embedding + Meilisearch vector | 需改 Workers AI/Vectorize，模型行为及额度不同 |

证据：

- [crawler worker](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/workers/crawlerWorker.ts)
- [HTML 抓取与解析流程](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/workers/crawler/crawlAndParse.ts)
- [图片/PDF 预处理](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/workers/assetPreprocessingWorker.ts)
- [yt-dlp 视频 worker](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/workers/videoWorker.ts)

## 3. Cloudflare 免费层逐项审计

以下额度按 2026-09-02 Cloudflare 官方文档核对。免费层额度超限通常不是自动收费，而是请求失败；所以“低频大概够”与“功能保证可用”是两回事。

### 3.1 Workers / Pages

Workers Free：

- 100,000 请求/日；
- 普通 HTTP 每次 10 ms CPU；
- Cron 每次 10 ms CPU；
- 128 MB 内存；
- 3 MB Worker 压缩后大小；
- 每请求 50 个子请求；
- 最多 100 个 Worker；
- 免费账户请求体最大 100 MB。

Cloudflare 特别指出，认证、SSR、解析大 payload 通常使用 10–20 ms CPU。这正好覆盖 Karakeep 的关键路径，意味着“偶尔成功”不能视为可靠部署。

Pages 只适合静态前端。静态资源请求免费且不限量；Pages Functions 仍计入 Workers Free。Cloudflare 对完整 Next.js 推荐 Workers + vinext，而 vinext 目前仍为 beta。Karakeep 即使通过 Next.js 适配检查，也无法自动解决数据库和后台依赖。

官方依据：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)

结论：

- 原 Next.js Web + API 原样部署：**No-Go**；
- 静态 SPA/精简 Web：**Go**；
- 小型 Hono/tRPC API：**有条件 Go**，必须控制 bundle 和每次 CPU；
- 把所有路由、SSR、解析库塞进一个 Worker：**No-Go**。

### 3.2 D1

D1 Free：

- 每日 500 万 rows read；
- 每日 10 万 rows written；
- 每个数据库最多 500 MB；
- 账户共 5 GB、最多 10 个数据库；
- 免费层每次 Worker invocation 最多 50 条 D1 查询；
- 单个字符串、BLOB 或整行最多 2 MB；
- 单条 SQL 最长运行 30 秒；
- 一个数据库本质上单线程；
- 2026-09-01 起，免费层达到读写日限额后查询会直接失败到 UTC 次日重置。

Karakeep 适配要求：

- 所有大 HTML、可读正文、PDF、图片、截图、备份都放 R2，D1 只存 ID、URL、标题、状态和小文本；
- 不能照搬 `better-sqlite3` 和同步事务回调；要改成 D1 prepared statements 与 `batch()`；
- 需要重新验证所有 26 处事务的原子性；
- 搜索需建立 D1 FTS5 表和同步触发器/队列；
- 所有列表、标签、搜索过滤必须有索引，避免每日 row-read 被全表扫描消耗。

官方依据：

- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 免费层强制限额公告](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)

结论：单用户核心元数据 **Go**；完整内容全塞 D1 **No-Go**；大型多年数据集是否始终免费 **无法保证**。

### 3.3 R2

R2 Standard 免费额度：

- 10 GB-month/月；
- Class A 100 万次/月；
- Class B 1,000 万次/月；
- Internet egress 免费；
- 对象最多约 5 TiB，但经免费账户 Worker 接收的单次请求体仍受 100 MB 限制。

R2 是 HTML、图片、PDF、截图和导出文件的正确位置。Karakeep 默认上传上限 50 MB，本身低于 Worker 免费账户的 100 MB 请求体限制。

但“永久免费”仍有容量硬上限：10 GB 约等于 200 个 50 MB 文件，或大量带内嵌图片的 SingleFile 页面。超过 10 GB 后若账户未启用付费，不能继续按免费承诺运行。

官方依据：

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)

结论：个人核心资源存储 **Go**；无限归档、视频保存 **No-Go**。

### 3.4 KV

KV Free：

- 100,000 reads/日；
- 1,000 writes/日、1,000 deletes/日、1,000 list/日；
- 1 GB 总存储；
- 单值最大 25 MiB；
- 同一个 key 每秒最多写一次；
- 最低缓存 TTL 30 秒；
- KV 是最终一致，不适合作为关系数据真相源。

KV 只能存：公开配置、短期 URL 检查结果、签名资源元数据、限流近似状态等可丢缓存。用户、API Key、书签状态、标签关系、阅读进度不能放 KV。

官方依据：

- [KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)

结论：KV **可选，不是必需组件**。初版不使用 KV 反而更安全；缓存可使用 Workers Cache API。

### 3.5 Queues

Queues Free：

- 10,000 operations/日；
- 一条小消息成功投递通常消耗 3 次 operation（write/read/delete），约 3,333 条/日；
- 消息最大 128 KB；
- 免费层保留 24 小时；
- 重试会继续消耗 read operation。

Cloudflare Queues 限额页称免费和付费除保留期外共用 consumer wall time/CPU 能力，并列出 consumer CPU 可配至 5 分钟；但 Workers 总定价页仍把 Free 描述为“每 invocation 10 ms CPU”。这两份官方文档在“免费 Queue consumer 是否真能配置 5 分钟 CPU”上存在表述冲突。

因此不能在立项前把“免费 Queue 有 5 分钟 CPU”当作已保证事实。即使实测可配置，Queue 也不会提供外部二进制、持久磁盘或超过 128 MB 内存，仍不能解决 yt-dlp、Ghostscript、GraphicsMagick 和大 OCR。

官方依据：

- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Queues 免费层公告](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)

结论：轻量抓取调度、D1/R2 状态更新 **Go**；把它当免费计算容器 **No-Go**。

### 3.6 Browser Run

Browser Run Free：

- 所有方式共用每天 10 分钟浏览器时间；
- 最多 3 个并发 session；
- 每 20 秒最多新建 1 个浏览器实例；
- 浏览器默认 60 秒空闲超时；
- Quick Actions 每 10 秒 1 次；
- `/crawl` 每日 5 个任务，每个最多 100 页；
- 达到日额度后返回 429，免费层不能按量购买更多时间。

与 Karakeep 的匹配：

- Cloudflare 支持 Playwright/CDP，技术上能替换 Karakeep 的远程 Chrome；
- 但 Cloudflare 明确指出 Browser Run 发出的请求会被识别为 bot，Karakeep 的 stealth/adblock/autoconsent 行为不能保证等价；
- 假设每页平均占用 15 秒，一天理论上约 40 页；平均 30 秒则约 20 页。登录墙、挑战页、视频页、超时和错误会进一步消耗预算；
- 浏览器时间是账户共享额度，截图、PDF、正文提取也共同消耗它。

官方依据：

- [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
- [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)
- [Playwright 支持](https://developers.cloudflare.com/browser-run/playwright/)

结论：把 Browser Run 当“低频、尽力而为”的增强功能 **Go**；把它当每个链接的可靠 crawler **No-Go**。

### 3.7 Containers

Containers 正是承载 yt-dlp、Ghostscript、GraphicsMagick、完整 Chromium 辅助程序和长任务的合理 Cloudflare 产品，但官方定价页中免费层 CPU、内存、磁盘均为 `N/A`，需要至少 Workers Paid。

官方依据：[Workers pricing — Containers](https://developers.cloudflare.com/workers/platform/pricing/#containers)

结论：严格免费条件下不可用。这一个条件本身已经足以否决“完整功能对等”。

## 4. 推荐的免费精简架构

```text
官方移动端 / 浏览器扩展
        │ tRPC batch + SuperJSON + Bearer ak2
        ▼
小型 API Worker（Hono/tRPC 兼容层）
        ├── D1：用户、API Key、书签、标签、列表、高亮、阅读进度、FTS5
        ├── R2：SingleFile HTML、正文、图片、PDF、附件、导出文件
        ├── Queues：轻量 URL 抓取、索引同步、Webhook（可选）
        ├── Browser Run：额度内动态页面抓取（可选、失败可降级）
        └── Cache API：公开配置和短期可丢缓存

Pages 静态 SPA（可选管理界面；不部署 Karakeep 原 SSR）
```

### 4.1 必须保留

- `/api/trpc` 的 tRPC batch 请求与 SuperJSON；
- `/api/assets` 上传/下载；
- `Authorization: Bearer ak2_<keyId>_<secret>`；
- 客户端使用到的 procedure 名称、输入默认值、分页 cursor、日期类型、错误格式；
- 核心 `ZBookmark` 联合类型及资源类型；
- CORS、自定义 headers 和 API Key scopes 的行为。

### 4.2 必须重写

- `better-sqlite3` → D1；
- 同步 callback transactions → D1 batch/显式状态机；
- Liteque/Restate → Cloudflare Queues；
- 文件系统/S3 helper → 首版删除；以后需要资产时再改 R2 流式 API；
- Meilisearch → D1 FTS5；
- NextAuth/SSR 管理页面 → 简化静态管理页或只用预生成 API Key；
- crawler → Worker `fetch + HTMLRewriter` 优先、Jina Reader 次之，Browser Run 删除；
- 内容超过 D1 2 MB 的字段 → R2 对象引用。

### 4.3 必须明确删除或降级

- 视频下载；
- PDF 首屏转图；
- 服务端 Tesseract OCR；
- 完整的 Ghostery/stealth/autoconsent 对等；
- 每个页面必有截图/PDF/完整归档；
- Meilisearch 排名和语义搜索对等；
- 原 Next.js SSR 管理站；
- 邮箱+密码直接交换 API Key 的可靠性；
- 无容量上限的长期归档。

## 5. 兼容性和免费额度风险矩阵

| 功能 | 官方客户端可兼容 | 免费实现 | 是否阻断精简版 | 是否阻断完整版 |
|---|---:|---:|---:|---:|
| API Key 日常鉴权 | 是 | 是，ak2 为 SHA-256 | 否 | 否 |
| 密码换 API Key | 协议可复刻 | bcrypt 可能超过 10 ms | 否，可预生成 Key | 是 |
| 链接/文本 CRUD | 是 | 是 | 否 | 否 |
| 标签/列表/高亮/进度 | 是 | 是 | 否 | 否 |
| 图片/PDF 原文件上传 | 是 | 是，R2 | 否 | 否 |
| 插件 SingleFile | 是 | 是，客户端计算 + R2 | 否 | 否 |
| 普通静态页 metadata fetch | 是 | 是，轻量队列 | 否 | 否 |
| 动态网页抓取 | 是 | 仅 10 分钟/日、尽力而为 | 否，允许失败时 | 是 |
| 服务端正文解析 | 返回结构可兼容 | 小页面可做，不能保证 CPU | 否，允许缺失时 | 是 |
| 截图/PDF | 返回结构可兼容 | Browser Run 额度内 | 否，允许缺失时 | 是 |
| OCR | 返回结构可兼容 | 不可靠 | 否，关闭时 | 是 |
| PDF 转图 | 返回结构可兼容 | 无免费执行环境 | 否，关闭时 | 是 |
| 视频下载 | 返回结构可兼容 | 无免费执行环境 | 否，关闭时 | 是 |
| 全文搜索 | 是 | D1 FTS5 可重写 | 否 | 排名不对等 |
| AI 自动标签 | 是，返回普通 tags | Workers AI 或 BYOK | 否 | 模型行为不完全对等 |
| 语义搜索 | 可返回“未启用” | 本目标删除 | 否 | 是 |
| 原 Web SSR | 与移动/扩展无关 | 10 ms 不可靠 | 否 | 是 |
| 无限数据增长 | 无关 | D1 500 MB/库、R2 10 GB | 是，达到额度后 | 是 |

## 6. 开工前必须通过的零浪费闸门

不要先 fork 完整 Web UI，也不要迁移全部 schema。先做一个一次性协议验证分支，按以下顺序；前三项任一失败即暂停主开发并重新评估：

1. **协议闸门**：最小 Worker 实现 `config.clientConfig`、`apiKeys.validate`、`users.whoami`、`bookmarks.createBookmark/getBookmarks/getBookmark/checkUrl`，让锁定版本的官方扩展和移动端用 API Key 完成保存、列表、详情和打开原链接。
2. **协议清单闸门**：记录扩展和移动端目标页面实际发出的全部 procedure；为未实现但会自动请求的方法返回 schema 兼容的默认值，确认不会因 tRPC batch 中单项失败破坏页面。
3. **CPU 闸门**：对 tRPC batch + API Key SHA-256 鉴权 + D1 查询做实际 CPU 观测。普通请求 P95 目标低于 8 ms；抓取和 AI 必须全部在 Queue 消费者中。
4. **降级抓取闸门**：分别模拟目标页超时、403、非 HTML、Jina 429、Jina 超时；五种情况都必须已保存 URL，且列表、搜索和打开原地址正常。
5. **AI 闸门**：用真实中文、英文、混合语言 URL 各 20 条，验证 Workers AI 结构化输出、标签去重、`attachedBy: "ai"` 和失败重试；限制输入约 4,000 token、输出约 100 token。
6. **搜索闸门**：用至少 10,000 条模拟书签验证 D1 FTS5 对标题、URL、description 和标签的中英文搜索、分页及排序；用 `EXPLAIN QUERY PLAN` 和 D1 `rows_read` 确认没有意外全表扫描。
7. **Web 闸门**：只 fork 一个书签列表页，删除 NextAuth 和服务端 DB import，经 Workers/vinext 构建并连接同源 `/api/trpc`。确认这条路径可行后才继续搬 UI 组件。

这组验证只需要最小 D1 schema、约 6–8 个 procedure、一条 Queue 和一个 Web 列表页。R2、KV、Browser Run、PDF、SingleFile 和完整移动端辅助功能均不应在验证阶段实现。

## 7. 决策建议

### 方案 A：完整 Karakeep，继续 VPS

这是唯一能保留现有全部能力且工作量最低的方案。可以让 Cloudflare 只承担 DNS、CDN、Access/Tunnel，不迁移计算。

### 方案 B：Cloudflare 免费精简兼容版

这是当前推荐方案。定义是“能连接锁定版本 Karakeep 客户端的 URL 书签和 AI 标签服务”，不是完整 Karakeep。直接抓取和 Jina 都允许失败，URL 保存不能失败；视频、OCR、PDF 转图和离线页面归档不在范围内；Web UI 只做组件与视觉层 fork。

### 方案 C：完整 Cloudflare 版

技术上可做，但至少需要 Workers Paid + Containers/Browser Run 按量，并进行较大规模重写。它不符合本报告的“完全免费”约束。

## 8. 最终判定

- **完整功能 + 原 Web + 官方客户端 + 纯 Cloudflare + 永久免费：No-Go。**
- **锁定客户端版本 + URL 保存 + AI 标签 + 基础搜索 + 个人低频：Go，约 8.5/10。**
- **原仓库改几个配置直接部署到 Workers/Pages：No-Go。**
- **D1 + Queues 能否替代 SQLite/本地队列：目标核心能力可以，但必须重写。**
- **R2 是否必要：首版不必要；只有代理缓存 OG 图片或以后保存资产时才需要。**
- **KV 是否必要：不必要，只应作可丢缓存。**
- **Browser Run 是否必要：不必要，不应进入关键路径。**
- **Jina 是否必要：不必要，是正文解析增强；失败后退化为标题、域名和 description 标签。**
- **原 Web 是否可直接复用：不可直接复用；fork UI 并替换数据层可行。**
- **当前缩减目标是否存在已知的确定性平台阻断：未发现。剩余风险是版本锁定协议维护和 Web fork 工程量。**
