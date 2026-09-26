# KaraClone 产品与技术规格

文档状态：已审核修订，可用于生成分阶段实施 Plan；完整实现以 Phase 0 Go 为前置条件  
规格版本：1.1  
日期：2026-09-02  
项目名称：KaraClone  
上游基线：Karakeep `5a2f009e2f6d266087f2f3f527e6e384cefd6de4`（2026-08-31）  
目标移动端：Karakeep Mobile 1.11.0  
目标浏览器扩展：Karakeep Browser Extension 1.2.11

## 1. 文档目的

本文定义 KaraClone 第一版的产品范围、协议契约、数据语义、Cloudflare 架构、失败降级、安全边界、免费层预算及验收标准。

后续实施 Plan 必须逐条映射本文的需求编号，不得在未修改本规格的情况下扩大功能范围。

本文中的“必须”“不得”是发布阻断要求；“应当”是默认设计，偏离时必须在 Plan 中写明理由。

## 2. 产品定义

KaraClone 是一个部署在 Cloudflare 免费层、与锁定版本 Karakeep 客户端协议兼容的单用户 URL 书签服务。

它解决以下问题：

1. 用户通过官方 Karakeep 移动端或浏览器扩展保存 URL。
2. 服务立即持久化 URL，不等待网页抓取或 AI。
3. 后台异步提取标题、简介、OG 图片和可选正文。
4. AI 自动生成标签和缺失的简短简介。
5. 用户可通过官方客户端或精简 Web UI 按标题、URL、简介和标签查找书签。
6. 点击书签时打开原始 URL，不提供离线网页阅读能力。

KaraClone 不是 Karakeep 完整服务端的移植，也不承诺兼容未来任意版本的官方客户端。

## 3. 成功定义

第一版发布必须同时满足：

- S-01：浏览器扩展 1.2.11 无需修改源码，可使用服务器地址和 API Key 登录。
- S-02：浏览器扩展可以保存普通 HTTP/HTTPS URL，保存成功不依赖抓取、Jina 或 AI。
- S-03：移动端 1.11.0 无需修改源码，可使用服务器地址和 API Key 登录。
- S-04：移动端可以查看列表、打开详情、搜索、按标签浏览、收藏、归档、编辑和删除 URL 书签。
- S-05：精简 Web UI 可以完成与 S-04 相同的核心操作。
- S-06：成功抓取的书签能显示标题、简介、OG 图片或默认占位图。
- S-07：AI 能异步生成 1 至 8 个标签；AI 失败不影响保存、查看、搜索和打开原链接。
- S-08：Jina、目标网站和 Workers AI 分别不可用时，系统均能按本文规定降级。
- S-09：核心数据仅以 D1 为权威真源，KV 不得存储权威书签数据。
- S-10：在个人低频使用和验收负载下，系统不超过 Cloudflare 免费层额度。
- S-11：所有客户端兼容结论均由真实客户端端到端测试和 wire contract 测试证明。
- S-12：Phase 0 Go/No-Go 闸门必须在完整实现开始前通过并保留实测证据。

## 4. 范围

### 4.1 第一版包含

- 单用户部署。
- 预生成 API Key 登录。
- URL 书签创建、读取、更新、删除。
- 重复 URL 检测和重新保存语义。
- 收藏、归档、标题、简介、备注和简短摘要。
- AI 标签及人工标签。
- 标签创建、重命名、合并、删除和按标签筛选。
- 基础关键词搜索和分页。
- 网页标题、description、Open Graph 图片、favicon 提取。
- 可选 Jina Reader 正文提取。
- Workers AI 自动标签和缺失简介生成。
- 抓取和 AI 异步重试。
- 精简 Karakeep 风格 Web UI。
- `/api/trpc`、`/api/health`、`/api/version`。
- Cloudflare Workers、Static Assets、D1、Queues、Workers AI。

### 4.2 第一版明确不包含

- 多用户注册、邀请、找回密码、邮箱验证和 OAuth。
- 邮箱密码换取 API Key。
- REST `/api/v1` 和完整 OpenAPI 兼容。
- 图片、PDF、音视频或任意文件书签。
- `/api/assets` 资源上传和下载。
- SingleFile 服务端存储和离线网页归档。
- Browser Run、Playwright、Chromium 和网页截图。
- PDF 解析、PDF 转图和 OCR。
- YouTube 或其他视频下载。
- 阅读器模式、全文离线阅读和高亮编辑。
- RSS、Webhook、规则引擎、导入、备份 Worker、公共列表和协作列表。
- Meilisearch、Vectorize、Embedding 和语义搜索。
- 原 Karakeep NextAuth、服务端渲染和原数据库包。
- KV 业务缓存和 R2 对象存储。
- 与 Karakeep 搜索排序、抓取结果或 AI 模型行为逐项一致。
- 对未来客户端版本的自动兼容。

## 5. 关键架构决策

### 5.1 协议兼容，不迁移服务端实现

KaraClone 必须复刻锁定版本客户端使用的 tRPC wire contract，但内部不得依赖 `better-sqlite3`、NextAuth、Meilisearch、原 Karakeep worker 或 Node 原生二进制。

### 5.2 URL 保存与后台处理解耦

创建书签请求只负责校验、去重、写入 D1 和投递 Queue。抓取、Jina 和 AI 均不得阻塞创建响应。

### 5.3 Browser Run 不进入系统

第一版不得创建 Browser Run binding，也不得设计依赖无头浏览器才能成功的流程。卡片预览优先使用远端 OG 图片；没有图片时使用本地占位图。

### 5.4 Jina 是可替换增强，不是依赖

Jina Reader 仅用于提高正文质量。Jina 失败时，系统必须使用 URL、域名、客户端标题和直接提取的 metadata 完成尽力而为的 AI 标签。

### 5.5 Web 使用客户端渲染 SPA

Web UI 必须从 Karakeep 的视觉和组件层 fork 为客户端渲染 SPA，并通过同源 `/api/trpc` 访问 Worker。不得迁移 NextAuth、React Server Components 数据访问或 `@karakeep/db`。

Web UI 与 API 由同一 Worker 域名提供：静态路径由 Workers Static Assets 响应，`/api/*` 由 Worker 响应。

### 5.6 版本锁定

第一版只对本文顶部指定的移动端、扩展和上游 commit 建立兼容承诺。任何业务实现前必须生成、人工审阅并提交 `config/phase0/client-lock.json`，且 `lockStatus` 必须为 `RESOLVED`。Android 信任根固定为官方 `karakeep-app/mobile-releases` 的 1.11.0 APK（release asset ID 536907626、package `app.hoarder.hoardermobile`、versionCode 45、固定 SHA-256 与官方签名证书）；immutable asset URL、asset ID 与 signer allow-list 仅适用于 Android。扩展信任条件仅为固定 Google `clients2.google.com/service/update2/crx` 请求模板（`response=redirect`、`acceptformat=crx3`、锁定 ID、记录 `prodversion`）、Google 官方 TLS redirect-host allow-list、离线 CRX3 cryptographic proof、公钥派生 ID 等于独立 Store ID，以及 Chrome Web Store 的 ID `kgcjekpmcjjogibpjebkhaanilehneje`、version 1.2.11、publisher `karakeep.app` evidence。扩展 signer/public-key hash 与 package hash 仅作观测和本次内容绑定，不是 trust input。全新 Chrome profile 必须从官方 Store 安装同一 ID/version；实际安装目录与已验签 CRX3 解包目录按同一明确排除规则生成逐文件 SHA-256 manifest，二者 canonical hash 必须相等。unpacked extension 不得替代 Store 安装；unsigned ZIP、无法取得官方 signed CRX3、无法定位或比对实际安装内容、仅自报签名布尔均不构成证据。

### 5.7 开工前 Phase 0 Go/No-Go 闸门

正式功能实施前必须先完成一个可丢弃的最小纵向原型，目标运行栈严格为 Workers + D1 + Queues + Workers AI，只包含 tRPC/SuperJSON、API Key SHA-256 验证、Queue 重试测试消费者、一次 Workers AI schema 探针和锁定版本客户端所需的最小 procedure。KV、R2、Browser Rendering 和 Containers 不创建、不绑定、不调用，因为精简 URL 保存与 AI 标签目标不需要它们；Phase 0 只证明兼容服务不依赖这些可选组件，其额度或可用性不是本阶段阻断。Phase 0 必须证明：

1. 在任何业务实现前，生成、人工审阅并提交 `lockStatus=RESOLVED` 的客户端锁；Task 1 的 `android-client-manifest.json` 与 `extension-client-manifest.json` 必须在同一个唯一前置提交中首次加入，之后永久只读。最终决策必须直接查询 Git 历史：定位两文件共同的首次加入提交，验证该提交是当前 `HEAD` 的祖先、两文件自首次加入后均无第二次内容修改，并重算和记录该 commit SHA、tree SHA、两个首次提交 blob SHA，要求当前 blob SHA 与对应首次提交 blob SHA 相等；历史缺失、歧义、改写或任一 SHA 不一致均 No-Go，不得信任可自行改写的 JSON 声明。独立 `extension-store-evidence.json` 必须绑定同次提交的实体 `extension-store-evidence.png` 及其 SHA-256，最终决策从 PNG 字节重算，文件缺失、替换或 hash 不符均 No-Go。按固定 Google 请求模板下载并离线复验扩展 1.2.11 CRX3，并证明全新 profile 的 Store 实装内容与该 CRX3 解包内容逐文件一致；该次内容关系只写入独立 `extension-store-content-binding.json`，绑定原 extension manifest canonical hash、Store installed/signed content hashes、`extension-store-install.png` hash、profile/session 与完整 clients DeploymentProvenance，不得回写原 manifest。Task 15 必须直接读取并重算该 Store-install PNG。最终 Store 重放只能由 `replay-final-store.mjs` 完成并引用该 content binding；最终决策只校验并重算直接内容及全部绑定，任一证据不一致即 No-Go。
2. 扩展 1.2.11 能登录并保存 URL；移动端 1.11.0 能登录、列出书签并打开含原链接的非空详情。
3. 已捕获扩展登录、保存、打开及移动端登录、列表、详情流程中的全部 Worker API/preview 请求，并完成 procedure、input/output/error envelope 与 route shape 快照；每份部署后证据顶层直接包含同一 `DeploymentProvenance={deploymentId,versionIds,profile,workerUrl,sourceDeploySha256}`，不得间接拼接。
4. Workers Free 必须由正向官方一方证据证明。`capture-workers-plan-entitlement.mjs` 是 `workers-plan-entitlement.json/html/png` 唯一生成器，并由它自行后台启动专用 Chrome、创建空临时 user-data-dir、随机本地 debugging port 与 session nonce；脚本记录并校验 expected user-data-dir、Chrome PID/启动参数、CDP endpoint、实际 Profile Path 和 nonce 全部属于本次会话，暂停等待用户在它启动的 profile 登录并选择目标账户后继续，拒绝日常/已有 profile、错误 PID/参数/路径/nonce、非本次 endpoint，以及同账户但非本次 profile。collector 自行导航并读取当前 canonical `dash.cloudflare.com` account Workers plan URL，以 `Runtime.evaluate` 获取 rendered DOM、selector 文本与 account ID，以 `Page.captureScreenshot` 获取 PNG，验证 TLS 官方 host/path 与 API account ID后在内存脱敏和 secret scan，并原子写三件套、删除临时数据与 profile、终止本次 Chrome。禁止手工创建、预建 final artifact，禁止 `--dom-input`/`--png-input`。JSON 直接保存无敏感 canonical Dashboard URL、规范化 selector 文本、脱敏 rendered DOM evidence、selector/extraction rule 版本及各自 hash；最终决策验证并重提取明确 `Workers Free` 文本和 account ID，且 Dashboard、token API 与实际部署三方 account hash 必须相等。collector 及其 fail-closed 测试还必须与两份 immutable client manifest 一起冻结在唯一前置提交中；最终决策从 Git 历史校验二者的提交 blob/源码 hash 自该提交后未改变。无法重算、证据含秘密、文本含糊、账户/profile/session 不匹配、截图失败、源码缺失或后续改写均 No-Go。Subscription、usage model 与 Free 原生固定 10ms enforcement 仅作交叉证据，不能替代正向 entitlement。
5. Workers Free 不支持配置 `limits.cpu_ms`；所有 probes、cpu、clients 与 cleanup 部署配置均不得出现该字段，只能依赖 Free Usage Model 原生固定的 10ms CPU 上限。免费计划远端环境中，代表性常用 HTTP procedure 的 Worker CPU P95 小于 8 ms，且没有 CPU limit 异常；Queue consumer 与两个 Cron 的官方 Telemetry Query 按 deployment/version、event type 和窗口完整分页，决策从完整事件集本地重算无 `exceededCpu` 且 max/P99 CPU 均小于 10ms。常规 CPU 流程必须先由同一确定性部署器实际部署 `cpu` profile 并生成 `deploy-cpu.json`，再允许 `measure-cpu` 发流量；部署器为本次会话分别生成高熵 `PHASE0_CPU_LIMIT_SECRET`、随机 path segment 与 handoff session nonce，通过 Wrangler secret/version binding 的 stdin 安全注入远端，不得进入命令行参数、JSON、日志或 Git。Worker 仅在 segment、secret 和 D1 one-time nonce 同时匹配时执行探针；`deploy-cpu.json` 只保存两个 binding 名、secret/path/会话 nonce 的 SHA-256、完整 deployment provenance 与可重算生产版本投影，不保存明文。该原生上限只由随后使用本次受限临时 handoff 的 authenticated one-time `free-limit` 探针同时取得 HTTP 1102 与 exact-version Telemetry `outcome="exceededCpu"` 来验证；handoff 必须在 `finally` 中立即清除。无论探针成功或失败，`finally` 都必须调用同一部署器的 `cleanup` profile 覆盖部署，设置 `PHASE0_CPU_LIMIT_PROBE=false`、删除或轮换两项临时 binding，并生成独立 `deploy-cleanup.json`；不得以删除 deployment 替代。探针失败仍保持 No-Go，最终决策还必须重算 cpu→free-limit→cleanup 的版本链、secret/path/nonce hash、cleanup 完整 source manifest/provenance、production status、binding 清除状态与 `/api/health`；CPU 部署缺失、旧凭据复用、明文泄露、cleanup 未执行、版本错配或临时 binding 未删除/轮换均 No-Go。
6. D1 写入、读取、日期序列化、批量 tRPC 和重复 URL 行为符合本文契约。
7. 默认 Workers AI 模型在实际账户中支持本文要求的 JSON Mode；Queue 的 `Message.attempts`、延迟重试、`max_retries = 3` 和 DLQ 行为通过实测。
8. Android 版本截图由 `adb exec-out screencap -p` 从测试设备取得。Task 14 不得改写 `android-client-manifest.json`，只能新建 `mobile-version-evidence.json`，直接保存脱敏 `adb shell dumpsys package app.hoarder.hoardermobile` 投影、`mobile-version.png` 的文件名与 SHA-256、完整 clients DeploymentProvenance、原 Android manifest canonical hash及自身 canonical hash；`mobile-manual.json` 只引用该 evidence 的 canonical hash，不重复保存或替代其 dumpsys/PNG hash。最终决策从 JSON 直接内容和 PNG 字节重算全部绑定，缺失、替换、hash/provenance/version 不符均 No-Go。

上述 entitlement 采集与最终 Store 重放均只使用本机专用 Chrome/CDP，不使用 Cloudflare Browser Rendering，不创建、绑定或调用该服务，因此不产生 Cloudflare 费用。

任一项失败均为 Go/No-Go 的 No-Go：停止 Web UI、完整抓取、完整搜索和迁移实现，先修订本规格或终止项目。Phase 0 通过前，不得宣称完整方案已具备实施可行性。

## 6. 系统架构

```text
Karakeep Mobile 1.11.0 ─┐
Karakeep Extension 1.2.11 ├── HTTPS ── KaraClone Worker ── D1
KaraClone Web SPA ───────┘              │   │               权威数据/FTS5
                                       │   └── Static Assets
                                       │
                                       └── Queue: bookmark-enrichment
                                                │
                           ┌────────────────────┼────────────────────┐
                           │                    │                    │
                    fetch + HTMLRewriter   Jina Reader（可选）   Workers AI
                           │                    │                    │
                           └──────────── metadata/tags ──────────────┘
                                                │
                                                └── D1 状态更新
```

数据流不得形成回路。Queue 消费者只根据 D1 当前状态处理任务，完成后写回 D1，不重新触发相同任务；人工重试必须通过显式 mutation 产生新任务。

## 7. Cloudflare 组件职责

| 组件 | 第一版职责 | 禁止用途 |
|---|---|---|
| Worker | tRPC、健康检查、版本接口、Web 会话、静态资源路由 | 重型正文解析、浏览器渲染、同步等待 AI |
| Static Assets | Web SPA、字体、图标、默认预览图 | 动态 API |
| D1 | 用户、API Key、书签、标签、任务状态、FTS5 | 大型 HTML、图片、PDF、密钥明文 |
| Queue | 网页 metadata、Jina、AI 标签、重试 | 传递正文或大 payload |
| Workers AI | 结构化标签和缺失简介生成 | 工具调用、网页访问、权威分类规则 |
| Jina Reader | 可选正文增强 | 保存书签的必要步骤 |
| KV | 第一版不绑定 | 权威数据、API Key 吊销状态 |
| R2 | 第一版不绑定 | 为尚未存在的资产功能预留代码 |
| Browser Run | 第一版不绑定 | 任意关键路径 |

Queue 消息只允许包含 `bookmarkId`、`jobId`、`urlSnapshot` 和 `requestedAt`，消息序列化后必须小于 2 KB。重试次数必须以 Cloudflare Queue `Message.attempts` 为权威来源，不得依赖消息体中的静态计数。

## 8. 客户端兼容契约

### 8.1 传输协议

- PC-01：tRPC 地址必须为 `{server}/api/trpc`。
- PC-02：必须支持 tRPC `httpBatchLink` 使用的 query 和 mutation 请求格式。
- PC-03：必须使用与上游一致的 SuperJSON transformer，尤其保持 `Date`、`undefined` 和批量响应格式。
- PC-04：客户端认证必须支持 `Authorization: Bearer <api-key>`。
- PC-05：错误必须使用 tRPC error envelope，并提供正确的 `data.code`。
- PC-06：查询游标必须保持上游 schema；书签列表使用 cursor v2，搜索使用 `{ver: 1, offset}`。
- PC-07：客户端返回的日期字段必须序列化为 SuperJSON Date，而不是普通字符串。
- PC-08：必须接受移动端和扩展发送的自定义请求头。
- PC-09：同源 Web 请求可以使用 HttpOnly 会话 Cookie；Bearer 行为不得因此改变。
- PC-10：API 响应不得返回未定义的内部 D1 字段。

### 8.2 HTTP 接口

| 方法与路径 | 要求 | 响应 |
|---|---|---|
| `GET /api/health` | 公开 | `{status:"ok", message:"Web app is working"}` |
| `GET /api/version` | 公开 | `{version:"0.1.0"}` |
| `GET/POST /api/trpc/*` | 按 procedure 决定认证 | tRPC + SuperJSON |
| `POST /api/web-session` | API Key 换取 Web Cookie | 成功 204；失败 401 |
| `DELETE /api/web-session` | 清除 Web Cookie | 204 |
| `GET /*` | SPA history fallback，`/api/*` 除外 | 静态入口或 404 |

`/api/assets` 和 `/api/v1` 不存在时必须返回 JSON 404，不得回落到 SPA HTML。

### 8.3 API Key

- AK-01：部署引导必须生成一个 `ak2_<keyId>_<secret>` 格式的高熵 API Key。
- AK-02：D1 只存储 `keyId`、SHA-256 hash、名称、scope、创建时间、最后使用时间和吊销时间。
- AK-03：API Key 比较必须使用固定时间比较。
- AK-04：默认 scope 为上游精确常量 `fullaccess`，不得写成 `full_access`。
- AK-05：`apiKeys.validate` 必须对有效 Key 返回 `{success:true}`，无效或吊销 Key 返回 `UNAUTHORIZED`。
- AK-06：`apiKeys.exchange` 必须存在，但固定返回 `FORBIDDEN` 和“Password authentication is disabled”。
- AK-07：客户端通过直接粘贴 API Key 登录，不依赖 signup 页面。
- AK-08：吊销当前唯一 API Key 属于破坏性操作；Web UI 不提供此入口。若客户端调用 revoke，服务端必须吊销并要求重新执行部署引导生成新 Key。

### 8.4 `config.clientConfig`

必须返回上游 `zClientConfigSchema` 的完整字段，并使用以下语义：

| 字段 | 值 |
|---|---|
| `publicUrl` | 当前部署公开 URL |
| `publicApiUrl` | 当前部署公开 URL |
| `auth.disableSignups` | `true` |
| `auth.disablePasswordAuth` | `true` |
| `auth.oauthAutoRedirect` | `false` |
| `turnstile` | `null` |
| `inference.isConfigured` | `true` |
| `inference.inferredTagLang` | `zh-CN` |
| `inference.enableAutoTagging` | `true` |
| `inference.enableAutoSummarization` | `false` |
| `chat.enabled` | `false` |
| `search.semanticSearchEnabled` | `false` |
| `stripe.isConfigured` | `false` |
| `legal` | 空对象 |
| `serverVersion` | `0.1.0` |
| `disableNewReleaseCheck` | `true` |

### 8.5 Procedure 支持等级

支持等级定义：

- 完整：在本文范围内实现真实读写行为。
- 兼容：返回 schema 正确的默认或空结果，保证未启用页面不会崩溃。
- 禁用：procedure 存在并返回明确的 `FORBIDDEN` 或 `BAD_REQUEST`。

#### 8.5.1 完整实现

| Router | Procedure |
|---|---|
| `apiKeys` | `validate`、`revoke` |
| `config` | `clientConfig` |
| `users` | `whoami`、`settings`、`updateSettings`、`stats` |
| `bookmarks` | `createBookmark`、`getBookmark`、`getBookmarks`、`searchBookmarks`、`checkUrl`、`updateBookmark`、`deleteBookmark`、`updateTags`、`recrawlBookmark`、`getReadingProgress`、`updateReadingProgress` |
| `tags` | `list`、`get`、`create`、`update`、`delete`、`deleteUnused`、`merge` |

`getReadingProgress` 和 `updateReadingProgress` 仅保存兼容字段，不提供离线阅读器。

#### 8.5.2 兼容空实现

| Router | Procedure | 语义 |
|---|---|---|
| `lists` | `list` | 空列表、空 cursor |
| `lists` | `stats` | 全部计数为 0 |
| `lists` | `getListsOfBookmark` | 空列表 |
| `highlights` | `getAll` | 空列表、空 cursor |
| `highlights` | `getForBookmark` | `{highlights:[]}` |
| `rules` | `list` | 空列表 |
| `assets` | `list` | 空列表 |

#### 8.5.3 明确禁用

| Router | Procedure | 错误 |
|---|---|---|
| `apiKeys` | `exchange` | `FORBIDDEN` |
| `users` | `create`、`deleteAccount`、`changePassword` | `FORBIDDEN` |
| `bookmarks` | `summarizeBookmark` | `BAD_REQUEST`，摘要功能未启用 |
| `assets` | attach/detach/replace 等 mutation | `BAD_REQUEST`，资产功能未启用 |
| `highlights` | create/update/delete | `BAD_REQUEST`，高亮功能未启用 |
| `lists` | create/edit/delete/add/remove/merge | `BAD_REQUEST`，列表功能未启用 |
| `rules` | create/update/delete | `BAD_REQUEST`，规则功能未启用 |

客户端实际发出但本文未列出的 procedure 必须在发布前归入上述三个等级之一；不得依靠未捕获的 `NOT_FOUND` 通过验收。

## 9. 书签数据契约

### 9.1 支持类型

第一版只接受 `type: "link"`。`text` 和 `asset` 输入必须返回 `BAD_REQUEST`，错误信息明确说明第一版仅支持 URL。

### 9.2 创建输入

支持上游 `zNewBookmarkRequestSchema` 的 link 分支：

- `type`：必须为 `link`。
- `url`：必须是合法 `http` 或 `https` URL。
- `title`：可空，最大 1,000 字符。
- `archived`、`favourited`、`note`、`summary`、`createdAt`、`source`：保持上游类型。
- `crawlPriority`：接受但第一版不区分队列优先级。
- `precrawledArchiveId`：接受并忽略，不建立资产关联。

### 9.3 创建响应

响应必须符合上游 `zBookmarkSchema` 并附加 `alreadyExists`。

初次保存时：

- `content.type = "link"`。
- `content.url` 为用户提交的原始规范化 URL。
- `content.title` 优先使用客户端标题。
- `content.crawlStatus = "pending"`。
- `taggingStatus = "pending"`。
- `summarizationStatus = null`。
- `embeddingStatus = null`。
- `assets = []`。
- 不支持的 link 资源 ID 和 reader 字段均为 `null`。

`getBookmark` 在 `includeContent` 为空或为 `false` 时返回 `content.htmlContent = null`。在 `includeContent = true` 时，必须动态生成一份经过 HTML 转义的最小 HTML，内容仅包含当前 title、description、host 和指向原 URL 的链接；不得返回或持久化抓取正文。该兼容页面用于保证移动端 1.11.0 在默认 Reader View 下不会白屏，不代表支持全文阅读器。

### 9.4 URL 规范化与重复保存

用于唯一性比较的 canonical URL 必须：

- 小写化 scheme 和 host。
- 移除 fragment。
- 移除默认端口 80/443。
- 非根路径移除末尾 `/`。
- 保留 query 参数及顺序，不擅自删除追踪参数。
- 将 IDN host 统一转换为 URL 标准形式。

D1 必须对 `(user_id, canonical_url)` 建立唯一约束。

重复保存时不得创建新行，必须：

- 返回原 bookmark ID。
- 设置 `alreadyExists = true`。
- 恢复 `archived = false`，除非输入明确为 true。
- 将 `createdAt` 更新为输入时间或当前时间，使其回到列表顶部。
- 仅覆盖调用者明确提供的 title、note、summary 和 favourite 字段。
- 不清空已有 metadata 和标签。
- 不自动重新抓取；只有 `recrawlBookmark` 触发重新处理。

### 9.5 更新和删除

- 更新必须按用户 ID 和 bookmark ID 双重限定。
- URL 改动必须重新规范化并检查唯一约束。
- URL 改动成功后必须将 `crawlStatus`、`taggingStatus` 设为 pending 并创建新 enrichment job。
- 删除必须级联删除 link、人工/AI 标签关联、搜索文档、阅读进度和任务记录。
- 删除不得删除仍被其他书签使用的 tag。

## 10. 元数据抓取规格

### 10.1 抓取顺序

单个 enrichment job 必须按以下顺序执行：

1. 读取 D1，确认书签仍存在且 URL 与 job 创建时一致。
2. 直接 HTTP fetch，并用 `HTMLRewriter` 提取 head metadata。
3. 调用 Jina Reader 获取可选正文。
4. 合并 metadata，保留客户端已有非空字段的优先级。
5. 调用 Workers AI 生成标签及缺失简介。
6. 原子写回 metadata、标签、状态和搜索文档。

### 10.2 直接 fetch

- 只允许 `http`、`https`。
- 禁止 URL 用户名和密码。
- 禁止 loopback、link-local、私网、保留地址和非标准内部主机名。
- 最多跟随 3 次重定向，每次重定向后重新验证 URL。
- 只解析 `text/html` 和 `application/xhtml+xml`。
- 连接与响应超时为 8 秒。
- 最多消费 512 KiB 响应内容；达到限制后取消读取。
- User-Agent 必须标识 `KaraCloneMetadataBot/0.1`。
- 不发送用户 Cookie、Authorization 或客户端自定义 header。

提取优先级：

| 目标字段 | 优先级 |
|---|---|
| 标题 | 客户端 title → `og:title` → `twitter:title` → `<title>` → host |
| 简介 | `og:description` → `twitter:description` → `meta[name=description]` |
| 图片 | `og:image:secure_url` → `og:image` → `twitter:image` |
| favicon | `link[rel~="icon"]` → `/favicon.ico` |

图片和 favicon URL 必须解析为绝对 HTTP/HTTPS URL。第一版只保存远端 URL，不下载、不代理。

### 10.3 Jina Reader

- 默认启用无 Key `r.jina.ai`；配置了 `JINA_API_KEY` 时使用该 Key。
- 请求必须要求 JSON 响应。
- `X-Token-Budget` 固定为 4,000。
- 超时为 15 秒。
- 不使用 ReaderLM-v2 或其他额外计费模式。
- 不存储完整 Jina 正文；正文只在当前 Queue invocation 内存在。
- Jina 的 title 只在客户端 title 和直接 metadata title 均为空时使用。
- 任意 4xx、5xx、429、超时、非法 JSON 或空正文均视为可降级失败。

### 10.4 抓取状态

- 直接 metadata 或 Jina 任一获得有效标题、简介或正文：`crawlStatus = "success"`。
- 两者均失败：`crawlStatus = "failure"`。
- 无论 success 或 failure，均继续尝试基于已有 URL/title/description 生成标签。
- 抓取失败不得修改用户提供的 title、note、summary 和人工标签。

## 11. AI 自动标签规格

### 11.1 默认模型和输入

- 默认 provider：Cloudflare Workers AI binding。
- 默认模型：`@cf/meta/llama-3.1-8b-instruct-fast`。该模型必须在部署时仍位于 Cloudflare Workers AI 官方 JSON Mode 支持列表中；若不再支持，Phase 0 必须失败并停止实施，不得静默改用不支持 schema 的模型。
- 可选 provider：OpenAI-compatible BYOK。
- 输入由 URL、host、title、description、现有人工标签名称及最多约 4,000 token 的 Jina 正文组成。
- 抓取正文必须被标记为不可信数据，模型不得执行正文中的指令。

### 11.2 结构化输出

模型输出必须受 JSON Schema 约束：

- `tags`：字符串数组，1 至 8 项。
- `description`：字符串或 null，最大 300 字符。

服务端必须二次验证：

- 移除 `#` 前缀和首尾空白。
- 删除空标签。
- 单标签最大 40 个 Unicode 字符。
- 标签仅允许常规文字、数字、空格、`-` 和 `_`。
- 以小写、移除空格/`-`/`_` 后的结果作为 normalized name。
- normalized name 相同的标签必须去重。
- 不允许模型创建超过 8 个有效标签。

### 11.3 标签写入语义

- AI 标签关联必须写入 `attached_by = "ai"`。
- 人工标签必须写入 `attached_by = "human"`。
- 重新推理时仅替换旧 AI 标签，不得移除人工标签。
- 同名 tag 必须复用，不能按书签重复创建。
- 同一 bookmark 和 tag 只能存在一条关联。AI 命中已有人工标签时必须保留 `human` 并跳过 AI 关联；用户人工附加已有 AI 标签时必须把 `attached_by` 提升为 `human`。
- AI 返回空数组、非法 JSON 或不符合 schema 时视为失败。
- description 仅在现有 description 为空时写入。

### 11.4 状态与重试

- 创建或重新抓取时：`taggingStatus = "pending"`。
- 成功写入合法标签：`taggingStatus = "success"`。
- Queue consumer 以 `Message.attempts` 作为当前投递次数；第一次、第二次、第三次失败分别延迟 30、300、1,800 秒重试。
- 可重试失败必须先在同一个 D1 batch 中把 job 从 `running` 改为 `retry_wait`、记录 `attempt` 和 `next_retry_at`、清除 lease，再调用 `message.retry({delaySeconds})`。
- 第四次失败必须把 job 设为 `dead`、把 `taggingStatus` 设为 `failure`，然后抛出处理错误，让 Queue 按 `max_retries = 3` 将消息写入 DLQ；不得 ack 成普通成功。
- 明确不可重试的输入或响应错误必须在同一个 D1 batch 中把 job 设为 `failure`、清除 lease 并 ack，不消耗后续重试。
- 每次重新投递必须通过条件更新从 `pending` 或 `retry_wait` 获取执行权并改为 `running`。`running` job 必须带 20 分钟 lease；只有 lease 过期的 job 才能被其他投递重新获取。
- URL 已变化、书签已删除、job 已 `success`/`failure`/`dead`/`cancelled` 或消息不再对应当前 job 时必须 ack，且不得写回 bookmark metadata、标签或状态。
- URL 更新或用户调用 `recrawlBookmark` 时，必须先把同一书签现有 active job 原子改为 `cancelled`，再创建新 job 并重置 bookmark 状态。

Queue 的 Free 24 小时保留期不可配置。创建 Queue 时不得传 retention 参数；创建后必须从官方控制面或资源详情读取并保存可重算投影，fail-closed 断言实际 retention 为 24 小时，才可认定足以覆盖上述重试窗口。

## 12. 搜索规格

### 12.1 索引字段

搜索文档必须包含：

- bookmark ID 和 user ID。
- URL 和 host。
- title。
- description。
- summary 和 note。
- 人工标签和 AI 标签通过关系表及 tag B-tree 索引参与同一搜索结果合并，不写入 trigram 文档。
- createdAt、archived、favourited。

### 12.2 搜索实现

- D1 使用 FTS5 trigram tokenizer 索引 URL、title、description、summary 和 note；仅对至少 3 个 Unicode 字符的关键词承诺中英文子串搜索。
- 标签通过 normalized name 和 `(user_id, normalized_name)` B-tree 索引进行精确或前缀匹配。
- 1 至 2 个 Unicode 字符的关键词不得进入 trigram，也不得使用 `%term%` 全表扫描；只允许匹配标签 normalized name 前缀和小写 host 前缀。UI 必须提示短关键词搜索范围受限。
- 空搜索走普通书签索引，不访问 FTS5。
- 关键词搜索必须限定 user ID。
- 第一版只支持 `searchMode = "fts"`；其他模式返回 `BAD_REQUEST`。
- 结果按相关度排序，同分时按 createdAt 倒序。
- `sortOrder = asc/desc` 时按 createdAt 排序。
- 搜索 cursor 使用 `{ver:1, offset:number}`。
- 默认每页 20，最大 100。
- 搜索索引必须与书签写入在同一逻辑操作中更新；不得依赖另一个异步索引队列。

### 12.3 基础过滤

必须支持：

- archived。
- favourited。
- tag ID。
- URL、标题、简介和标签关键词。

语义搜索、拼写纠错、同义词、Meilisearch 排名对等和复杂搜索表达式不在范围内。

## 13. Web UI 规格

### 13.1 页面

| 路径 | 功能 |
|---|---|
| `/signin` | 输入服务器预生成 API Key，换取 HttpOnly Cookie |
| `/dashboard/bookmarks` | 全部、收藏、归档筛选；分页；关键词搜索 |
| `/dashboard/bookmarks/:id` | 查看标题、URL、简介、图片、标签、状态、备注；打开原链接 |
| `/dashboard/preview/:id` | 浏览器扩展“打开”动作兼容入口；保留 ID 并重定向到 `/dashboard/bookmarks/:id` |
| `/dashboard/tags` | 标签及使用次数 |
| `/dashboard/tags/:id` | 查看指定标签下的书签 |
| `/settings` | 退出登录、自动标签开关、标签语言、时区 |

其他 Karakeep 路径必须重定向到 `/dashboard/bookmarks` 或显示明确的“此功能未启用”，不得白屏或无限加载。

### 13.2 视觉与交互

- 保留 Karakeep 的书签卡片、标签、布局密度、颜色语义和响应式风格。
- 不复制服务端数据层、NextAuth 或不在范围内的页面逻辑。
- 卡片显示 title、host、createdAt、标签和远端 OG 图片。
- 没有 OG 图片或图片加载失败时显示本地占位图。
- 抓取 pending 显示轻量状态；抓取 failure 不显示阻断性错误。
- AI pending/failure 不妨碍编辑人工标签。
- 默认点击行为为打开原 URL。
- 删除操作必须二次确认。
- 所有 metadata 必须通过 React 文本渲染，禁止直接注入未清洗 HTML。

### 13.3 Web 会话

- API Key 只在 `/signin` 提交时存在于页面内存，不写入 localStorage、sessionStorage 或普通 Cookie。
- Worker 验证后签发 HttpOnly、Secure、SameSite=Strict Cookie。
- Cookie 使用 Web Crypto HMAC-SHA-256 签名，包含 user ID、不可变 API Key row ID、该行 version 和过期时间。
- 会话有效期 30 天。
- 每次 Cookie 认证必须按 row ID 精确读取 API Key 行并校验 user ID、version 和 `revoked_at IS NULL`；该行吊销、删除或 version 变化后，旧 Cookie 必须立即失效，其他 Key 的相同 version 不得使其恢复有效。
- Web mutation 必须校验 Origin 为部署域名。

## 14. D1 数据模型

所有时间字段统一存储为 Unix epoch milliseconds，API 层转换为 JavaScript Date 并通过 SuperJSON 输出。

### 14.1 `users`

| 字段 | 约束 |
|---|---|
| `id` | TEXT PRIMARY KEY，UUID v4 |
| `name` | TEXT NOT NULL |
| `email` | TEXT NOT NULL UNIQUE |
| `role` | TEXT NOT NULL，固定 `admin` |
| `created_at` | INTEGER NOT NULL |

### 14.2 `api_keys`

| 字段 | 约束 |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `user_id` | TEXT NOT NULL FK users |
| `key_id` | TEXT NOT NULL UNIQUE |
| `key_hash` | TEXT NOT NULL |
| `name` | TEXT NOT NULL |
| `scopes_json` | TEXT NOT NULL |
| `version` | INTEGER NOT NULL DEFAULT 1 |
| `created_at` | INTEGER NOT NULL |
| `last_used_at` | INTEGER NULL |
| `revoked_at` | INTEGER NULL |

`version` 只属于该 API Key 行；若同一行重新生成 secret，必须递增 version。Web 会话不得只按 user ID 和 version 查找 Key。

### 14.3 `bookmarks`

| 字段 | 约束 |
|---|---|
| `id` | TEXT PRIMARY KEY，UUID v4 |
| `user_id` | TEXT NOT NULL FK users |
| `type` | TEXT NOT NULL，固定 `link` |
| `title` | TEXT NULL，最大 1,000 字符 |
| `archived` | INTEGER NOT NULL DEFAULT 0 |
| `favourited` | INTEGER NOT NULL DEFAULT 0 |
| `note` | TEXT NULL |
| `summary` | TEXT NULL |
| `source` | TEXT NULL |
| `tagging_status` | TEXT NULL，pending/success/failure |
| `created_at` | INTEGER NOT NULL |
| `first_created_at` | INTEGER NOT NULL |
| `modified_at` | INTEGER NULL |

索引：`(user_id, archived, created_at DESC)`、`(user_id, favourited, created_at DESC)`。

### 14.4 `bookmark_links`

| 字段 | 约束 |
|---|---|
| `bookmark_id` | TEXT PRIMARY KEY FK bookmarks ON DELETE CASCADE |
| `user_id` | TEXT NOT NULL FK users |
| `url` | TEXT NOT NULL |
| `canonical_url` | TEXT NOT NULL |
| `host` | TEXT NOT NULL |
| `description` | TEXT NULL |
| `image_url` | TEXT NULL |
| `favicon` | TEXT NULL |
| `crawl_status` | TEXT NULL，pending/success/failure |
| `crawl_status_code` | INTEGER NULL |
| `crawled_at` | INTEGER NULL |

唯一索引：通过 bookmarks user ID 不能直接建立跨表唯一约束，因此 `bookmark_links` 还必须保存 `user_id`，并建立 `UNIQUE(user_id, canonical_url)`。`host` 必须保存为小写，并建立 `(user_id, host)` 索引供短关键词前缀范围查询使用。

### 14.5 `tags`

| 字段 | 约束 |
|---|---|
| `id` | TEXT PRIMARY KEY，UUID v4 |
| `user_id` | TEXT NOT NULL FK users |
| `name` | TEXT NOT NULL |
| `normalized_name` | TEXT NOT NULL |
| `created_at` | INTEGER NOT NULL |

唯一索引：`UNIQUE(user_id, normalized_name)`。

### 14.6 `tags_on_bookmarks`

| 字段 | 约束 |
|---|---|
| `bookmark_id` | TEXT NOT NULL FK bookmarks ON DELETE CASCADE |
| `tag_id` | TEXT NOT NULL FK tags ON DELETE CASCADE |
| `attached_by` | TEXT NOT NULL，ai/human |
| `created_at` | INTEGER NOT NULL |

主键：`(bookmark_id, tag_id)`。`attached_by` 是关联来源状态，不是关联身份；人工附加已有 AI 标签时原地更新为 `human`。

### 14.7 `user_settings`

必须保存上游 `zUserSettingsSchema` 所需字段。第一版默认：

- `bookmarkClickAction = open_original_link`
- `archiveDisplayBehaviour = show`
- `timezone = Asia/Shanghai`
- `backupsEnabled = false`
- `backupsFrequency = weekly`
- `backupsRetentionDays = 7`
- reader 字段为 null
- `autoTaggingEnabled = true`
- `autoSummarizationEnabled = false`
- `tagStyle = lowercase-spaces`
- `curatedTagIds = null`
- `inferredTagLang = zh-CN`

### 14.8 `reading_progress`

以 bookmark ID 为主键，保存 `readingProgressOffset`、`readingProgressAnchor`、`readingProgressPercent` 和更新时间，仅用于客户端 schema 兼容。

### 14.9 `enrichment_jobs`

| 字段 | 约束 |
|---|---|
| `id` | TEXT PRIMARY KEY，UUID v4 |
| `bookmark_id` | TEXT NOT NULL FK bookmarks ON DELETE CASCADE |
| `user_id` | TEXT NOT NULL FK users |
| `url_snapshot` | TEXT NOT NULL |
| `status` | TEXT NOT NULL，pending/running/retry_wait/success/failure/dead/cancelled |
| `attempt` | INTEGER NOT NULL DEFAULT 0 |
| `lease_expires_at` | INTEGER NULL |
| `next_retry_at` | INTEGER NULL |
| `last_message_id` | TEXT NULL |
| `last_error_code` | TEXT NULL |
| `last_error_message` | TEXT NULL，最大 500 字符 |
| `created_at` | INTEGER NOT NULL |
| `updated_at` | INTEGER NOT NULL |

同一 bookmark 同时只允许一个 pending/running/retry_wait job，使用 `CREATE UNIQUE INDEX enrichment_jobs_one_active ON enrichment_jobs(bookmark_id) WHERE status IN ('pending','running','retry_wait')` 保证；另建 `(status, next_retry_at, created_at)` 索引供消费者和 Cron 使用。重复 Queue 投递必须通过条件更新、lease 和 job 状态做到幂等。

### 14.10 `bookmark_fts`

FTS5 虚拟表包含 bookmark ID、user ID、URL、host、title、description、summary、note，并使用 trigram tokenizer。标签匹配由关系表单独完成，不依赖将短标签写入 trigram 索引。

## 15. 一致性和并发

- DB-01：D1 是唯一权威数据源。
- DB-02：创建书签和创建 enrichment job 必须在同一个 D1 `batch()` 原子提交。
- DB-03：只有 DB 提交成功后才允许发送 Queue；发送失败时 API 仍返回书签，但必须把 job 保持 pending，并由每小时一次的轻量 Cron 每次最多补投 10 个超过 5 分钟的 pending job。
- DB-04：Queue 消费者必须通过条件更新获取执行权：`pending`、由 Queue 重新投递的 `retry_wait`、同一 message ID 且 `Message.attempts` 递增的 `running`，或 lease 已过期的 `running` 才能改为 `running`，并原子记录 attempts、message ID 和 20 分钟 lease。其他尚在 lease 内的重复投递，以及已 success/dead/failure/cancelled 的消息直接 ack，不执行外部调用；消费者不得在 Worker 内等待 `next_retry_at`。
- DB-05：URL 更新或 recrawl 必须在创建新 job 前原子取消旧 active job。消费者写回前仍须验证 `url_snapshot` 等于当前 URL；不相等时只把仍 active 的旧 job 设为 `cancelled`，不得覆盖 bookmark metadata、标签或新 job 状态。
- DB-06：AI 标签、metadata、状态、lease 清理和 FTS 更新必须在一个 D1 batch 内完成。
- DB-07：人工标签写入和 AI 重推理并发时，AI 操作只能删除 `attached_by=ai` 的关联；插入 AI 标签遇到同 bookmark/tag 的人工关联时必须跳过。
- DB-08：D1 唯一约束冲突必须转换为确定性的业务响应，不得返回 500。
- DB-09：用户人工附加已存在的 AI 标签时，必须在同一事务语义中把关联更新为 `human`，保证后续 AI 重跑不会删除它。

## 16. 失败与降级

| 故障 | 必须行为 |
|---|---|
| 目标网站超时/403/5xx | 保存成功；crawl failure；继续尝试 Jina/AI |
| 非 HTML URL | 保存成功；不解析；基于 URL/title 打标签 |
| Jina 429/超时/不可达 | 保存成功；使用直接 metadata；记录可降级错误 |
| Workers AI 429/容量不足 | 保存成功；按 Queue 策略重试 |
| Workers AI 永久失败 | tagging failure；人工标签和搜索可用 |
| Queue send 失败 | 书签已保存；pending job 由 Cron 补投 |
| Queue 重复投递 | 不重复标签、不覆盖新 URL、不创建重复 job |
| OG 图片失效 | 客户端显示本地占位图 |
| D1 临时失败 | 当前写请求失败，不返回虚假成功；客户端可重试 |
| D1 免费日限额耗尽 | API 返回明确 503；不得切换到 KV 写入 |
| 客户端调用禁用 procedure | 返回规定 tRPC 业务错误，不返回 HTML 或 500 |

## 17. 安全要求

### 17.1 URL 和 SSRF

- 只接受 HTTP/HTTPS。
- 每次重定向重新检查目标。
- 拒绝 localhost、`.local`、私网、link-local、metadata service 地址、保留地址和 URL credentials。
- 对 IP literal 必须同时检查 IPv4、IPv6 及 IPv4-mapped IPv6；域名目标依赖 Workers 公网出站隔离，第一版不得配置能访问私网的 Tunnel、Service Binding 或私有网络连接。
- 不允许用户控制抓取请求 header。

### 17.2 身份认证

- API Key 至少 256 bit 随机熵。
- Key secret 永不记录日志、永不写入 D1 明文、永不回传给普通 API。
- 所有业务 procedure 必须从认证上下文取得 user ID，忽略客户端传入的 user ID。
- Cookie 使用独立 `SESSION_SIGNING_KEY`，不得复用 API Key。

### 17.3 内容安全

- title、description、tag、note 均作为纯文本输出。
- 不渲染抓取 HTML。
- 远端图片只允许 HTTP/HTTPS URL。
- AI 输出必须经过 schema 和服务端字符限制。
- 网页内容视为 prompt injection，不得改变系统提示、模型 schema 或触发工具。

### 17.4 隐私

- 保存的 URL 会发送给目标网站、可选 Jina Reader 和配置的 AI provider。
- Web UI 设置页必须披露上述数据流。
- Jina 正文和完整网页内容不得持久化。
- 日志不得包含 API Key、Cookie、完整正文或 AI prompt。

### 17.5 CORS 与 CSRF

- Bearer API 接受无 Origin 的移动端请求。
- 浏览器扩展 Origin 允许名单按锁定版本实际 Origin 配置。
- Web Cookie mutation 必须校验同源 Origin 和 SameSite Cookie。
- 不得使用 `Access-Control-Allow-Origin: *` 同时允许凭证。

## 18. 配置、绑定和凭据

### 18.1 必需 Cloudflare 资源

- 一个 Worker 项目和公开 URL。
- 一个 D1 数据库 binding：`DB`。
- 一个 Queue producer/consumer binding：`ENRICHMENT_QUEUE`。
- 一个 DLQ：`ENRICHMENT_DLQ`。
- Queue consumer 必须配置 `max_batch_size = 1`、`max_retries = 3` 和上述 DLQ；单消息 batch 用于让第四次处理失败可以安全抛错进入 DLQ，不牵连其他消息。
- 一个 Workers AI binding：`AI`。
- 一个 Static Assets binding：`ASSETS`。
- 一个每小时运行一次的 Cron Trigger，仅补投滞留 job。

### 18.2 必需 Secret

| Secret | 用途 |
|---|---|
| `SESSION_SIGNING_KEY` | 签名 Web HttpOnly 会话；至少 32 随机字节 |

初始 `ak2` API Key 由部署引导生成，明文只显示一次，不保存为 Worker secret。

### 18.3 必需普通变量

| 变量 | 值或规则 |
|---|---|
| `PUBLIC_URL` | Worker 正式 URL，无末尾斜杠 |
| `SERVER_VERSION` | `0.1.0` |
| `ADMIN_NAME` | 单用户显示名 |
| `ADMIN_EMAIL` | 单用户邮箱标识，不用于发信 |
| `DEFAULT_TIMEZONE` | `Asia/Shanghai` |
| `DEFAULT_TAG_LANGUAGE` | `zh-CN` |
| `AI_PROVIDER` | 默认 `workers-ai` |
| `AI_MODEL` | 默认 `@cf/meta/llama-3.1-8b-instruct-fast`；部署时必须通过 JSON Mode 支持检查 |

### 18.4 可选 Secret/变量

| 名称 | 用途 |
|---|---|
| `JINA_API_KEY` | 提高 Jina Reader 限额；没有时使用无 Key 模式 |
| `OPENAI_API_KEY` | `AI_PROVIDER=openai-compatible` 时使用 |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint |
| `OPENAI_MODEL` | BYOK 模型名 |

第一版不得在实施中途再要求 R2、KV、Browser Run、OAuth、邮件或付费容器账号。

## 19. 免费层预算

设计基准：每天新增 5 个 URL、每天 100 次交互请求、总书签 10,000 条。

| 服务 | 估算 | 免费层约束 | 判断 |
|---|---:|---:|---|
| Workers 请求 | < 500/日 | 100,000/日 | 充足 |
| 普通 Worker CPU | P95 < 8 ms | 10 ms/请求 | 必须实测通过 |
| D1 rows read | < 100,000/日 | 5,000,000/日 | 充足 |
| D1 rows written | < 2,000/日 | 100,000/日 | 充足 |
| D1 存储 | 10,000 URL 预计远低于 5 GB | 5 GB/账户 | 充足 |
| Queue ops | 约 15/日，不含重试 | 10,000/日 | 充足 |
| Workers AI | 预计 < 200 Neurons/日，必须按实际 prompt 实测 | 10,000/日 | 充足 |
| Jina Reader | 约 5 请求/日 | 无 Key 20 RPM | 充足但非保证 |

任何常用 HTTP procedure 的实测 CPU P95 持续超过 8 ms，均视为免费方案发布阻断；不得以“个人访问少”忽略单次 10 ms CPU 上限。

## 20. 性能和可靠性

- NFR-01：创建书签在不计公网往返时 P95 小于 500 ms，且不等待抓取/AI。
- NFR-02：普通书签列表和详情 API P95 小于 300 ms。
- NFR-03：10,000 条书签下关键词搜索 P95 小于 500 ms。
- NFR-04：正常外部服务下，95% enrichment job 在 60 秒内进入 success 或明确 failure。
- NFR-05：常用 HTTP procedure Worker CPU P95 小于 8 ms。
- NFR-06：单个 API 调用不超过 50 条 D1 query。
- NFR-07：客户端重试相同 create 请求不得产生重复书签。
- NFR-08：Queue 至少一次投递不得产生重复 AI 标签。
- NFR-09：外部抓取和 AI 全部失败时，URL 书签可用性为 100%。
- NFR-10：静态 Web UI 在手机和桌面宽度均可用。

## 21. 可观测性

结构化日志必须包含：

- request ID、procedure、HTTP status、tRPC code。
- user ID 的不可逆短 hash，不记录邮箱。
- bookmark ID、job ID、attempt。
- crawl provider、AI provider、耗时、状态和归一化错误码。
- Worker CPU time、D1 rows read/written、Queue retry 次数。

不得记录：API Key、Cookie、完整 URL query 中可能包含的敏感值、网页正文、Jina 正文、AI prompt 和模型原始完整响应。

错误码至少区分：`URL_VALIDATION_FAILED`、`DIRECT_FETCH_TIMEOUT`、`DIRECT_FETCH_BLOCKED`、`JINA_RATE_LIMITED`、`JINA_TIMEOUT`、`AI_RATE_LIMITED`、`AI_INVALID_OUTPUT`、`AI_CAPACITY`、`D1_LIMIT_EXCEEDED`、`STALE_JOB`。

## 22. 验收测试

### 22.0 Phase 0 闸门验收

- AT-000-1：业务实现前生成、人工审阅并提交 `lockStatus=RESOLVED` 的客户端锁，离线复验锁定的官方已签名 Android 1.11.0 APK 和 Google 官方 signed Chromium CRX3；最终 Store 五件套必须由 `replay-final-store.mjs` 在脚本创建的空随机临时 Chrome profile/随机本地 CDP port 中从官方 Store 安装后原子生成，禁止手工预建。最终决策只校验并从两份 final manifest 直接重算同版本排除规则下的 canonical hash，要求相等，并由 binding 绑定完整 clients DeploymentProvenance、package、ID/version、profile session nonce 与最终 Store 截图。
- AT-000-1a：Task 1 的 Android/extension client manifests 必须在同一个唯一前置提交中首次加入并永久只读；Task 15 直接检查该提交是当前 `HEAD` 的祖先、两文件自首次加入后无第二次内容修改，记录并重算 commit/tree/两个 blob SHA，且当前 blob 必须等于首次提交 blob。collector 与其 fail-closed 测试也必须在该提交冻结，Task 15 校验其 blob/源码 hash 自此未变。`extension-store-evidence.json` 必须绑定并同批提交实体 `extension-store-evidence.png`。Task 13 只能新建 `extension-store-content-binding.json`，并绑定 `extension-store-install.png`；Task 14 只能新建 `mobile-version-evidence.json` 保存脱敏 dumpsys、版本 PNG/hash与完整 clients provenance，mobile manual 只引用其 canonical hash。Task 15 必须读取实体 PNG/JSON 并从字节或直接内容重算；历史约束、源码冻结、文件缺失/替换/hash 或 manifest 回写任一不符均 No-Go。
- AT-000-2：Workers entitlement 三件套必须由唯一 collector 自行后台启动空临时 Chrome profile 与随机 CDP port，校验本次 expected user-data-dir、Chrome PID/args、实际 Profile Path、endpoint 与 session nonce，暂停等待用户登录目标账户后采集；错误 PID/args/profile/nonce、非本次 endpoint 或同账户但非本次 profile 均不得产出。collector 实际导航官方页面，经 `Runtime.evaluate`/`Page.captureScreenshot`、内存脱敏与 secret scan 后原子生成并清理；禁止手工预建及 DOM/PNG 输入。decision 重提取并校验 Dashboard、token API 与部署三方账户绑定，任一异常均 No-Go。
- AT-000-3：保存上述流程的完整 wire contract 与 route 快照，每份 wire 顶层绑定 deployment/version，并证明没有目标客户端自动调用但尚未分类的 procedure 或路由。
- AT-000-4：所有 Free 部署配置均不得包含仅 Standard Usage Model 可配置的 `limits.cpu_ms`，并依赖 Free 原生固定 10ms；代表性常用 HTTP procedure 的 Worker CPU P95 小于 8 ms且无 CPU limit 异常，Queue/Cron Telemetry 完整分页并由本地统计证明无 `exceededCpu` 且 max/P99 小于 10ms。`measure-cpu` 前必须由 `deploy.mjs --profile cpu` 实际生成并验证 `deploy-cpu.json`；本次高熵 secret、随机 path segment 和 handoff nonce 只能经 stdin secret binding 与权限受限临时文件在本地进程间传递，artifact 仅存 binding 名及 SHA-256。原生上限只由该次 cpu deployment 的 authenticated one-time free-limit 取得 1102/`exceededCpu` 闭环验证；无论探针成败都在 `finally` 调用同一 `deploy.mjs --profile cleanup` 覆盖部署、关闭 probe、删除或轮换临时 binding并生成 `deploy-cleanup.json`，随后校验 cpu/free-limit/cleanup 版本链、完整 source manifest/provenance/status/health 与 binding 清除状态；探针失败、旧凭据复用、明文泄露或 cleanup 不闭合均 No-Go。Queue 创建不得配置 retention，必须从官方控制面/资源详情证明实际 Free retention 为 24 小时，缺失或不符即 No-Go。
- AT-000-5：默认 Workers AI 模型通过 JSON Mode schema 请求；Queue 第 1 至第 4 次投递的 `Message.attempts`、延迟、状态迁移和 DLQ 结果符合本文。
- AT-000-6：`local-tests.json` 是 G1 唯一机器可读输入，必须直接记录 test、typecheck、deploy dry-run 的命令结果，以及 bindings、Cron、禁用资源和 `limits.cpu_ms` 缺失检查；最终决策显式读取并重算该文件，缺失、篡改、任一失败结果或配置出现该字段均 No-Go。以上任一测试失败时，完整实现不得开始。

### 22.1 协议验收

- AT-001：扩展 1.2.11 使用 API Key 登录，`apiKeys.validate` 成功。
- AT-002：移动端 1.11.0 使用 API Key 登录，`config.clientConfig`、`users.whoami` 和 settings schema 全部通过客户端解析。
- AT-003：捕获两个客户端所有 tRPC 请求，逐项与 procedure 支持等级核对。
- AT-004：batch query、batch mutation、单项错误和整批成功均符合 tRPC/SuperJSON envelope。
- AT-005：所有 Date 字段通过客户端 Zod schema。
- AT-006：健康检查和版本接口响应与本文一致。
- AT-007：扩展的“打开”动作访问 `/dashboard/preview/:id` 后保留正确书签 ID，并到达可用详情页。

### 22.2 核心功能验收

- AT-101：扩展保存普通文章 URL 后立即显示成功。
- AT-102：扩展保存动态站、403 站和超时站时仍保存成功。
- AT-103：移动端能看到扩展保存的书签。
- AT-104：移动端完成收藏、取消收藏、归档、取消归档、改标题、改备注和删除。
- AT-105：相同 URL 含不同 fragment 只产生一个书签。
- AT-106：重复保存恢复归档并移动到列表顶部，不清空标签。
- AT-107：更新 URL 重新触发 enrichment，旧 job 不覆盖新 URL。
- AT-108：人工标签在 AI 重跑后仍保留。
- AT-109：Web UI 完成列表、详情、搜索、标签筛选和打开原 URL。
- AT-110：新保存且没有抓取正文的书签，在移动端默认 Reader View 中显示经过转义的非空最小详情，原 URL 链接可打开。

### 22.3 抓取和 AI 验收

- AT-201：普通 HTML 页提取 title、description、OG image 和 favicon。
- AT-202：相对 OG image/favicon 正确解析为绝对 URL。
- AT-203：Jina 正常时使用正文生成 1 至 8 个标签。
- AT-204：Jina 429、超时、5xx、非法 JSON 时回退直接 metadata。
- AT-205：直接抓取和 Jina 同时失败时，仍基于 URL/title 尝试标签。
- AT-206：Workers AI 非法 JSON 时按策略重试并最终标记 failure。
- AT-207：Workers AI 429/容量不足时书签核心操作不受影响。
- AT-208：中文、英文、混合语言各 20 个 URL 的标签通过 schema，且没有重复 normalized tag。
- AT-209：网页正文中的 prompt injection 不能改变输出 schema、标签上限或触发外部行为。
- AT-210：默认 Workers AI 模型接受本文的 JSON Mode 请求并返回可通过服务端 schema 的结构；模型不支持时 Phase 0 直接 No-Go。

### 22.4 搜索验收

- AT-301：使用至少 3 个 Unicode 字符的关键词，按 URL、host、英文标题、中文标题、description、人工标签和 AI 标签均可找到书签。
- AT-302：归档、收藏和 tag filter 正确。
- AT-303：10,000 条数据分页不重复、不遗漏。
- AT-304：`EXPLAIN QUERY PLAN` 证明常用过滤使用预期索引。
- AT-305：记录真实 `rows_read`，单次普通搜索不得扫描全部 10,000 条关系数据。
- AT-306：`searchMode != fts` 返回明确 `BAD_REQUEST`。
- AT-307：1 至 2 字符查询只匹配标签前缀和 host 前缀；`EXPLAIN QUERY PLAN` 与实测 rows read 证明没有 `%term%` 全表扫描。

### 22.5 安全验收

- AT-401：无效、吊销和截断 API Key 均返回 `UNAUTHORIZED`。
- AT-402：日志中不出现 API Key、Cookie 和正文。
- AT-403：localhost、私网 IP、link-local、metadata service、URL credentials 和重定向到私网均被拒绝。
- AT-404：远端 title/description/tag 中的 HTML 在 Web UI 只显示为文本。
- AT-405：跨站 Cookie mutation 被拒绝。
- AT-406：API Key 不出现在 localStorage、sessionStorage、普通 Cookie 和浏览器 URL。
- AT-407：吊销签发当前 Cookie 的精确 API Key 行后，该 Cookie 立即失效；创建另一个 version 相同的 Key 不能使旧 Cookie 恢复有效。

### 22.6 可靠性和免费层验收

- AT-501：Queue 同一消息重复 5 次只产生一组 AI 标签。
- AT-502：Queue send 失败后，Cron 在下次运行补投 pending job。
- AT-503：模拟 D1 失败时 API 不返回虚假保存成功。
- AT-504：常用 API 的 Worker CPU P95 小于 8 ms。
- AT-505：10,000 条数据下满足第 20 节性能指标。
- AT-506：不创建或调用 KV、R2、Browser Run 和 Container。
- AT-507：同一 job 经三次可重试失败后依次进入 `retry_wait`，第四次失败进入 `dead` 和 DLQ；每次只有一个持有有效 lease 的消费者能执行外部调用。

## 23. 发布阻断条件

出现任一情况不得发布第一版：

1. 锁定版本扩展或移动端不能完成 API Key 登录和保存 URL。
2. createBookmark 依赖抓取、Jina 或 AI 才能返回成功。
3. 常用 HTTP procedure CPU P95 达到或超过 8 ms。
4. 任一失败路径会丢失已成功写入的 URL。
5. AI 重跑会删除人工标签。
6. Queue 重复投递会创建重复书签或重复标签。
7. Web UI 需要在浏览器持久化 API Key。
8. 存在未分类且由目标客户端自动调用的 tRPC procedure。
9. 核心搜索发生未受控全表扫描。
10. 第一版需要付费 Cloudflare 产品才能运行。
11. 使用 Karakeep 代码但没有满足 AGPL-3.0 合规要求。
12. Phase 0 任一 Go/No-Go 验收未通过或没有保留实测证据。
13. 默认 AI 模型不支持本文要求的 JSON Mode，且未先修订规格并重新通过 Phase 0。
14. 移动端默认 Reader View 对无抓取正文的书签显示空白或无法打开原 URL。
15. 扩展“打开”动作不能通过 `/dashboard/preview/:id` 到达正确书签详情。

## 24. 许可证与来源合规

Karakeep 上游采用 AGPL-3.0。KaraClone 若复制、修改或链接上游受保护代码并通过网络提供服务，必须：

- 保留上游版权和许可证声明。
- 对网络用户提供运行中对应版本的完整源代码获取入口。
- 保留适当法律声明和无担保说明。
- 修改过的受保护代码继续按 AGPL-3.0 提供。
- 在 Web UI 设置或关于页面提供许可证与源代码链接。

协议独立重实现与 UI 代码 fork 的合规边界不同；实施 Plan 必须将许可证审查列为发布工作，不得默认“个人使用”可以忽略许可证义务。

## 25. 外部依赖失效分析

| 假设失效 | 影响 | 设计后的结果 |
|---|---|---|
| Jina 取消免费层或宕机 | 正文质量下降 | URL 保存、metadata、AI 粗标签仍工作 |
| Workers AI 默认模型下线 | 自动标签暂停 | URL 功能可用；切换其他免费模型或 BYOK |
| 目标站禁止抓取 | 无 metadata/正文 | 使用客户端标题、host、默认图 |
| 官方客户端升级协议 | 新版本可能不兼容 | 继续支持锁定版本，完成新 contract 后再升级 |
| 数据增长到 10 倍 | 搜索和 D1 成本上升 | 索引与 100,000 条容量测试决定是否继续免费层 |
| Web fork 方向错误 | Web 返工 | API 和 D1 数据不变，可替换 SPA 而不迁移数据 |

最脆弱的前提是官方客户端内部 tRPC contract 没有稳定版本保证。该风险不会使锁定版本无法使用，但决定了 KaraClone 必须维护明确的客户端兼容矩阵。

## 26. 规格边界变更规则

以下任意要求都必须先修改本规格并重新评估免费层，不能直接进入实施 Plan：

- 增加图片、PDF、视频或 SingleFile 资产。
- 增加截图、Browser Run、OCR 或离线正文。
- 增加多用户、注册、OAuth、邮件和协作。
- 增加 REST v1 完整兼容。
- 增加 RSS、Webhook、规则、导入或自动备份。
- 增加语义搜索、Vectorize 或 Embedding。
- 取消客户端版本锁定。
- 要求原 Karakeep Web 应用原样运行。
- 要求保证第三方抓取或 AI 永久免费。

## 27. 参考依据

- [完整免费层审计](./KARAKEEP_CLOUDFLARE_FREE_TIER_AUDIT.md)
- [早期整体可行性研究](./KARAKEEP_CLOUDFLARE_FEASIBILITY.md)
- [Karakeep 上游仓库](https://github.com/karakeep-app/karakeep)
- [Karakeep tRPC AppRouter](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/trpc/routers/_app.ts)
- [Karakeep bookmark schema](https://github.com/karakeep-app/karakeep/blob/5a2f009e2f6d266087f2f3f527e6e384cefd6de4/packages/shared/types/bookmarks.ts)
- [Cloudflare HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
- [Cloudflare D1 SQL/FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [Cloudflare Queues 定价](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Queues 重试与 DLQ](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Workers AI 定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cloudflare Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [默认 Workers AI 模型](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fast/)
- [Jina Reader](https://jina.ai/reader/)

## 28. 已批准设计摘要

- 要构建什么：一个部署在 Cloudflare 免费层、兼容锁定版本 Karakeep 移动端和浏览器扩展的单用户 URL 书签、AI 标签、基础搜索和精简 Web UI 服务。
- 不构建什么：资产、离线正文、截图、Browser Run、PDF/OCR/视频、多用户、完整 REST、语义搜索及完整 Karakeep 服务端。
- 方案：Worker + Static Assets + D1 + Queue + Workers AI；直接 metadata 抓取优先，Jina 可选增强，所有外部处理失败都不影响 URL 保存。
- 关键决策：锁定客户端版本；保持 tRPC/SuperJSON/Bearer wire contract；D1 为唯一真源；Web 只 fork UI；R2/KV/Browser Run 不进入第一版。
- 已知开工闸门：Workers 单次 CPU、真实客户端 wire contract、默认模型 JSON Mode、Queue 重试/DLQ 和移动端非空详情必须先通过 Phase 0；10,000 条搜索性能必须在发布前实测。Phase 0 通过前，项目不得被标记为完全 Go。
