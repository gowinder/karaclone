# Karakeep 迁移至 Cloudflare 的可行性研究报告

> 研究日期：2026-09-02  
> Karakeep 基线：`main` 分支提交 `5a2f009e2f6d266087f2f3f527e6e384cefd6de4`（2026-08-31）  
> 目标：在 Cloudflare Workers/Pages 上提供与 Karakeep 官方客户端、移动端和浏览器插件兼容的服务；D1 为主数据库，KV 只承担缓存职责。

## 一、结论

可以做到，但不能把 Karakeep 当前代码“改一下配置”后直接部署到 Workers/Pages。可行的工程路径是：保留 Karakeep 的 HTTP/tRPC/REST 接口和数据语义，重构服务端运行时与存储适配层，形成一个 Cloudflare 原生、协议兼容的实现。

综合判断：

| 方案 | 可行性 | 结论 |
|---|---:|---|
| 原 Docker/Next.js 项目原样部署到 Pages | 1/10 | 不可行。Pages 只适合静态输出；当前应用依赖 Node.js、SQLite 本地文件、常驻 Worker、Chrome 和 Meilisearch。 |
| 原项目整体塞入一个 Cloudflare Worker | 2/10 | 不可行。`better-sqlite3`、常驻进程、浏览器、原生/重型依赖、文件持久化和包体均不匹配。 |
| 保持 Karakeep 协议，重写 Cloudflare 后端核心 | 8/10 | 可行。书签、标签、列表、高亮、API Key、资产上传和客户端同步都能实现。 |
| 纯 Workers 产品实现 100% 功能对等 | 5/10 | 困难。视频、OCR、复杂 PDF、完整浏览器抓取和部分备份任务不适合纯 Worker。 |
| Workers + D1 + R2 + KV + Queues + Browser Run，必要时加 Containers | 8/10 | 推荐。可覆盖核心功能，并为重型任务提供合理落点。 |

最关键的判断是：客户端兼容并不要求内部仍使用 SQLite 文件、Meilisearch 或本地 Chrome；它要求服务器在相同 URL 上实现相同的 tRPC procedure、SuperJSON 编码、REST 路径、认证方式、返回结构和错误语义。因此，内部完全可以换成 D1、R2、KV、Queues、FTS5/Vectorize 和 Browser Run。

## 二、Karakeep 当前服务端结构

官方 Docker Compose 同时运行三个服务：Karakeep Web、Chrome 和 Meilisearch；Web 容器还挂载 `/data` 持久卷。[源码：docker-compose.yml](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/docker/docker-compose.yml)

### 2.1 Web/API

- Next.js 16 App Router，服务端强制使用 `runtime = "nodejs"`。
- Hono 将 API 挂载在 `/api`，包含 `/api/trpc`、`/api/v1`、`/api/assets`、`/api/health`、`/api/version` 等。
- NextAuth v4 处理浏览器会话；API Key 使用 `Authorization: Bearer ...`。
- 依赖 `better-sqlite3`、Drizzle、`sharp`、NextAuth 和 Node.js API。

来源：[Web 依赖](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/web/package.json)、[API Route Handler](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/web/app/api/%5B%5B...route%5D%5D/route.ts)、[Hono API 入口](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/api/index.ts)

### 2.2 数据库

- 当前数据库是本地 SQLite 文件，通过同步的 `better-sqlite3` 驱动访问，并启用 WAL、foreign keys、内存临时表等 PRAGMA。
- Drizzle schema 约 1,337 行；当前仓库有 94 个增量迁移。
- 代码存在多处回调式 `db.transaction(...)`，其中一些事务包含“先读、根据结果计算、再写”的逻辑。
- Schema 使用外键级联、JSON、生成列、复合索引等 SQLite 能力。

来源：[数据库入口](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/db/drizzle.ts)、[Schema](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/db/schema.ts)

### 2.3 后台任务

Karakeep 不是只有一个 Web 进程。它有常驻队列消费者，负责抓取、低优先级抓取、搜索索引、Embedding、AI 推理、Feed、导入、备份、Webhook、规则引擎、资产预处理、视频等任务，并有定时调度和长期轮询。[源码：Workers 入口](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/index.ts)

抓取端使用 Playwright、CDP、Stealth、广告拦截、Cookie、代理、SSRF 防护；其他任务还依赖 PDF、OCR、压缩和视频处理库。[源码：Workers 依赖](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/apps/workers/package.json)

### 2.4 资产和搜索

- 图片、网页归档、截图、PDF、上传文件和备份通过资产插件写到本地文件系统或 S3。
- 搜索和向量检索由 Meilisearch 插件承担。
- 因此 D1 只能替代关系数据库，不能同时替代文件对象存储和完整搜索服务。

## 三、所谓“Karakeep 通讯协议”到底是什么

它不是独立的二进制同步协议，而是几套 HTTP 接口的组合：

1. **tRPC：`/api/trpc`**  
   官方移动端和浏览器插件使用 tRPC HTTP Batch Link，并使用 SuperJSON 序列化。认证头为 `Authorization: Bearer <API Key>`。procedure 名称来自 `AppRouter`，覆盖 bookmarks、apiKeys、users、lists、tags、feeds、highlights、rules、assets 等。[AppRouter](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/trpc/routers/_app.ts)、[客户端 tRPC Provider](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/shared-react/providers/trpc-provider.tsx)

2. **REST/OpenAPI：`/api/v1`**  
   CLI、第三方集成和部分功能使用 REST，包括书签、标签、列表、高亮、资产、Feed、备份等。[OpenAPI 定义](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/open-api/karakeep-openapi-spec.json)

3. **资产接口：`/api/assets`**  
   移动端、插件及 SingleFile 上传直接使用资产 URL。协议兼容层必须保留上传方式、鉴权、Content-Type、Range/缓存头及资产 ID 行为。

4. **探活和版本：`/api/health`、`/api/version`**  
   移动端会主动探测这些地址。

5. **Web 页面路径**  
   浏览器插件会跳转到 `/dashboard/...`。只实现 API 可以让保存、同步等核心动作工作，但插件里的“打开后台/预览”仍要求有兼容 Web UI 或至少有对应重定向页面。

因此，兼容目标必须锁定具体客户端版本。tRPC 类型只在源码编译期是强类型的，线上 wire contract 没有独立版本号；上游新增/修改 procedure 后，新的官方客户端可能要求服务器同步升级。

## 四、Cloudflare 产品映射

| Karakeep 能力 | Cloudflare 落点 | 评价 |
|---|---|---|
| Next.js Web UI | Workers 上的 vinext；或将 UI 改为静态 SPA 后放 Pages | 当前 Cloudflare 对完整 Next.js 推荐 Workers + vinext；Pages 只推荐静态 export。 |
| Hono/tRPC/REST API | 独立 Worker | Hono 和 Web 标准 API 很匹配，可复用大量路由和 Zod 校验。 |
| SQLite 元数据 | D1 | SQL 层大体兼容，但驱动和事务必须重写。 |
| 本地资产/S3 | R2 | 高度匹配；直接 Worker binding，资产 ID 可保持不变。 |
| 本地队列/Restate | Cloudflare Queues | 高度匹配；按任务类型拆队列，并配置 DLQ、重试和幂等键。 |
| 定时 Feed/备份 | Cron Triggers + Queues/Workflows | 可行，Cron 只负责投递任务，不承担大批处理。 |
| Meilisearch 关键词搜索 | D1 FTS5，或保留外部 Meilisearch | 核心搜索可用 FTS5 重做；排序、容错和高级过滤不会自动等价。 |
| Meilisearch 向量搜索 | Vectorize | 可行，但需重写向量插件和过滤逻辑。 |
| Chrome/Playwright 抓取 | Browser Run + Queue Worker | 可行，但必须重新实现并验证广告拦截、Cookie、代理、SSRF 和超时策略。 |
| PDF/OCR/视频/原生工具 | Cloudflare Containers 或外部任务服务 | 不建议塞进普通 Worker。 |
| 配置和读缓存 | KV | 合适，但不能作为书签主数据源。 |
| 强一致单实体协调 | Durable Objects | 仅在事务/锁/限流确有需要时引入。 |

Cloudflare 当前明确建议完整 Next.js 应用使用 Workers + vinext，静态 Next.js 才使用 Pages。[官方 Next.js 指南](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)

## 五、D1 的适配难点

### 5.1 SQL 兼容度较高，但驱动模型不同

D1 使用 SQLite 引擎，并支持 JSON、FTS5 和生成列，因此现有表结构不是主要障碍。[D1 SQL 支持](https://developers.cloudflare.com/d1/sql-api/sql-statements/)

真正的障碍是当前代码使用同步 `better-sqlite3` 和 `drizzle-orm/better-sqlite3`，而 D1 是异步 binding。需要：

- 将 DB 初始化替换为 `drizzle-orm/d1` 或直接 `D1Database`；
- 将所有依赖同步返回值、`RunResult.changes`、同步 transaction callback 的代码逐处适配；
- 把可预先确定的多语句事务改为 D1 `batch()`；
- 对“事务中读出结果后再决定后续写入”的逻辑，改成单条 SQL、乐观并发控制，或放到 Durable Object 中串行执行；
- 不直接重放全部 94 个历史迁移，而是生成一份经过 D1 验证的全新基线 schema，再为 Cloudflare 分支持续维护迁移。

D1 `batch()` 可以原子执行一组预先准备好的语句，但 D1 的 API 不是 `better-sqlite3` 那种任意交互式事务回调。[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

### 5.2 容量和行大小

Workers Paid 下单个 D1 数据库最大 10 GB，单个字符串/BLOB/行最大 2 MB，单条查询最长 30 秒；一个数据库本质上单线程处理查询。[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)

这对个人或小团队的关系元数据通常足够，但需特别处理：

- `bookmarkTexts.text`、旧数据中的 `bookmarkLinks.htmlContent`、长笔记或导入暂存内容可能触及 2 MB 行限制；
- 完整网页 HTML、SingleFile、PDF、截图和备份必须放 R2，D1 只存对象 ID、类型、大小和索引字段；
- 单库接近 10 GB 时不能扩容，只能按用户/租户分库；因此应尽早设计 tenant-to-D1 路由，但首版单库足以验证产品。

### 5.3 数据一致性

D1 是书签、标签、列表、高亮、用户、API Key 的唯一真源。任何写请求必须先提交 D1，再异步投递索引和抓取任务。Queue 消费者必须以 `bookmarkId + operation` 为幂等键，允许至少一次投递和重复执行。

## 六、KV 应该怎样用

KV 是最终一致的全球读缓存；其他节点可能在 60 秒或更久后才看到更新，也不支持跨键原子事务。[KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

适合放入 KV 的内容：

- `/api/version`、公开 client config；
- 公共列表元数据和可接受短暂陈旧的公共页面；
- 经过权限校验后的短 TTL 聚合统计；
- 抓取域名规则、特性开关、非敏感配置；
- 可重新生成的搜索结果或预览缓存；
- API Key 查询的短 TTL 正缓存，但必须有版本号或主动失效机制。

不应放入 KV 的内容：

- 书签、标签、列表、高亮的权威记录；
- 刚写入后客户端必须立即读到的结果；
- API Key 吊销状态的长 TTL 缓存；
- 配额扣减、唯一性约束、协作列表成员关系；
- 需要原子读改写的计数器或锁。

KV 每个值最大 25 MiB，同一个 key 每秒只能写一次；它不适合拿来假装 Redis 或关系数据库。[KV 限制](https://developers.cloudflare.com/kv/platform/limits/)

推荐缓存策略：Cache Aside。读取时先查 KV，未命中查 D1 并写入带版本的 KV key；写入 D1 后删除相关 key，或通过 `userId:resource:version` 换版本，避免批量列举删除。第一阶段可以完全不启用业务 KV 缓存，先保证协议正确，再用实际指标挑热点。

## 七、API 与官方客户端兼容方案

### 7.1 必须原样保留的内容

- `/api/trpc` 的 HTTP Batch 请求格式；
- SuperJSON 的日期、undefined 等编码行为；
- AppRouter 的 procedure 名、输入 schema、输出 JSON 形状；
- REST 路径、状态码、分页 cursor 和错误格式；
- `ak1_...`/`ak2_...` API Key 格式及 SHA-256/bcrypt 校验；
- `/api/assets` 的上传和下载语义；
- `/api/health`、`/api/version`；
- CORS 对浏览器插件来源及自定义 header 的支持。

### 7.2 不需要保持的内容

- 数据库驱动和物理表文件；
- 队列实现；
- 搜索引擎；
- 资产存储供应商；
- 抓取浏览器供应商；
- Worker 内部模块组织。

### 7.3 最大兼容风险

官方客户端直接依赖同仓库 `AppRouter` 类型，服务端与客户端版本耦合较强。建议建立协议快照：针对每个受支持的官方客户端版本，记录实际 tRPC 请求、SuperJSON body、响应结构和错误响应，并在 CI 中对 Cloudflare 实现运行 contract tests。每次跟随上游升级时先比较 `packages/trpc/routers`、`packages/shared-react` 和 OpenAPI spec，再决定是否发布兼容更新。

## 八、推荐目标架构

```text
官方移动端 / 浏览器插件 / CLI / Web
                 |
          api.example.com
                 |
      Cloudflare API Gateway Worker
        |          |          |
       D1         R2         KV
   权威元数据   所有大对象   可丢缓存
        |
   Cloudflare Queues
    |      |       |       |
  抓取   搜索索引  AI/Feed  Webhook
    |      |       |
Browser  D1 FTS5  Vectorize / 外部 AI
  Run
    |
复杂 PDF/OCR/视频（可选 Containers）
```

部署建议：

- `karakeep-api` Worker：Hono、tRPC、REST、API Key、D1/R2/KV bindings；
- `karakeep-crawler` Queue Consumer：普通 fetch 优先，必要时 Browser Run；
- `karakeep-indexer` Queue Consumer：D1 FTS5 和 Vectorize；
- `karakeep-jobs` Queue Consumer：Feed、Webhook、规则、AI；
- `karakeep-heavy` Container：仅处理普通 Worker 不适合的 PDF/OCR/视频；
- Web UI：优先独立迁移到 Workers + vinext；若目标只是先兼容客户端，Web UI 可后置，仅提供最小账户/API Key 管理页面。

普通 Worker 内存为 128 MB，Paid HTTP/Queue CPU 可配置到 5 分钟，但 Queue Consumer 墙钟上限为 15 分钟；大型文件应流式传输，重型任务应拆分或交给 Container。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Queues 限制](https://developers.cloudflare.com/queues/platform/limits/)

## 九、功能分级

### 第一阶段：应当完整实现

- API Key 登录和验证；
- 书签 CRUD、分页、归档、收藏；
- 标签、列表、高亮；
- 文本书签和 URL 书签；
- 插件 SingleFile/资产上传；
- R2 资产读取；
- `/api/trpc`、`/api/v1`、health/version；
- 基础全文搜索；
- 基础异步网页抓取。

这组功能足以验证官方移动端和浏览器插件的核心兼容性。

### 第二阶段：可行但需重构

- RSS Feed；
- 规则引擎；
- Webhooks；
- 导入导出；
- AI 摘要、自动标签、Embedding；
- 公共/协作列表；
- Web UI 和账号注册/找回密码。

### 第三阶段：高风险或应降级

- 与当前 Stealth/广告拦截/代理行为完全等价的浏览器抓取；
- 视频下载和转码；
- OCR、复杂 PDF 转图片；
- 完整数据库备份文件与原 SQLite 备份格式等价；
- Meilisearch 排序、拼写容错和语义搜索结果逐条等价。

这些功能可以做到“产品功能等价”，但不应承诺内部行为或搜索排序完全一致。

## 十、迁移现有 VPS 数据

推荐采用一次全量迁移加短暂停写切换：

1. 在 VPS 上记录 Karakeep 版本、SQLite schema、数据量、资产目录大小和 Meilisearch 索引量。
2. 建立 D1 全新基线 schema；不要直接假设全部历史迁移可在 D1 原样执行。
3. 将 SQLite 表按外键顺序导出和转换，按批导入 D1；迁移脚本检查每表行数、主键集合、孤儿外键和关键字段 hash。
4. 将 `/data/assets` 上传至 R2，保留原 asset ID 和元数据映射；大文本一并外置到 R2。
5. 保留用户 ID、API Key 的 `keyId/keyHash` 和 scope，使现有移动端/插件无需重新配置 API Key。
6. 从 D1/R2 重建 FTS5/Vectorize，不迁移 Meilisearch 内部索引。
7. 切换前短暂停写，执行最后增量，跑兼容性验收；保持 VPS 只读一段时间作为回滚源。
8. 如果沿用原域名，只改 Cloudflare 路由即可让客户端无感切换；如果更换域名，则客户端必须更新 server address。

D1 Paid 单库 10 GB、单行 2 MB 是迁移前的硬门槛。R2 适合资产，其单对象上限远大于 Workers 的入站请求上限；客户端上传仍受 Cloudflare 账户计划的 HTTP 请求体限制。生产资产应经 Worker 鉴权或 R2 自定义域名服务。[R2 限制](https://developers.cloudflare.com/r2/platform/limits/)

## 十一、实施工作量估计

以下是单名熟悉 TypeScript、tRPC、Drizzle 和 Cloudflare 的高级工程师的粗略区间，不是固定排期：

| 阶段 | 预计工作量 | 验收标准 |
|---|---:|---|
| 协议 PoC | 2–3 周 | 官方移动端/插件可连接，完成 API Key、保存、列表、读取、删除和资产上传。 |
| 核心 MVP | 6–10 周 | D1/R2/Queues、核心 CRUD、FTS、抓取、迁移工具和基本可观测性可生产运行。 |
| Web UI 与高级功能 | 6–10 周 | 账号、Feed、规则、Webhook、导入导出、AI、公共/协作列表。 |
| 重型功能和生产加固 | 3–6 周 | Browser Run/Containers、容量测试、回滚、备份、限流、安全审计。 |

完整功能接近对等通常是 4–7 人月；只做个人使用且接受视频/OCR/高级备份降级，核心可用版本约 1.5–2.5 人月。

## 十二、风险清单

| 风险 | 严重度 | 缓解措施 |
|---|---:|---|
| tRPC 上游无独立 wire 版本，客户端升级导致不兼容 | 高 | 固定支持版本、协议快照、自动 contract tests、跟踪上游路由差异。 |
| D1 回调式事务无法直接平移 | 高 | 列出全部 transaction 调用，改写为 batch/单 SQL/乐观锁/DO。 |
| 大文本超过 D1 2 MB 行限制 | 高 | HTML、SingleFile、长正文外置 R2，D1 只存索引摘要和对象 ID。 |
| KV 陈旧数据造成刚写入后读不到 | 高 | KV 不缓存核心写后读路径；使用版本 key 和短 TTL。 |
| Browser Run 与原 Chrome 抓取结果不同 | 中高 | 建立真实网址抓取语料库，比对正文、元数据、截图和失败类型。 |
| 搜索排序不等价 | 中高 | 先定义功能兼容而非排名一致；保留外部 Meili 作为可选后端。 |
| Worker 包体、内存、CPU 被重依赖撑爆 | 高 | API、抓取、索引、重型任务拆成不同 Worker；流式处理；Container 隔离。 |
| NextAuth/Next.js Worker 兼容问题 | 中高 | 客户端 MVP 先走 API Key；Web UI 独立迁移并用 vinext compatibility check。 |
| 单 D1 10 GB 上限 | 中 | 资产全部 R2；提前保留按用户/租户分库的路由抽象。 |
| 备份和灾备语义改变 | 中 | 使用 D1 Time Travel + 业务级 JSON/对象清单备份至 R2，定期恢复演练。 |

## 十三、建议的决策与 PoC

建议立项，但明确项目定义为“Karakeep-compatible Cloudflare backend”，不要定义为“把 Karakeep 部署到 Pages”。第一阶段不要迁移全部 Web UI，也不要追求 100% 高级功能。

PoC 的唯一正确验收方式是直接使用未经修改的官方客户端：

1. 官方浏览器插件配置 Cloudflare URL 和 API Key；
2. 保存普通 URL、SingleFile、文本和图片/PDF；
3. 官方移动端登录同一服务，看到相同书签、标签、列表和高亮；
4. 两端完成新增、编辑、删除、归档、收藏和分页；
5. 写后立即读没有 KV 陈旧问题；
6. 断开/重试 Queue 不产生重复资产或重复标签；
7. 用一份真实 VPS 数据样本完成 SQLite → D1、assets → R2 迁移并校验。

PoC 通过后再决定是否迁移 Web UI、AI、Browser Run 和 Containers。若 PoC 不能让官方客户端稳定通过，继续投入高级功能没有意义。

## 最终判断

**能做，且 D1 + R2 + Queues 的总体方向正确；KV 只能是可丢失、可陈旧的读缓存。** 核心客户端兼容的技术风险可控，主要成本在数据库异步化、事务改写和完整重现 tRPC contract。真正困难的不是书签数据，而是 Karakeep 附带的浏览器抓取、搜索、PDF/OCR/视频和备份流水线。

推荐采用“协议兼容 API Worker + D1 真源 + R2 资产 + Queues 异步 + FTS5/Vectorize 搜索 + Browser Run/Containers 重任务”的架构。不要尝试把现有 Docker 镜像或整个 Next.js/Workers monorepo 直接塞进一个 Worker，也不要用 KV 代替 D1。
