# KaraClone Phase 0 Go/No-Go Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不实施完整产品的前提下，用一个可丢弃的 Cloudflare 免费层纵向原型，实测证明或否定 Karakeep 扩展 1.2.11、移动端 1.11.0、tRPC/SuperJSON、D1、Queues/DLQ、Workers AI JSON Mode 与 Workers 10ms CPU 限制能否同时成立。

**Architecture:** 目标运行栈严格为 Workers + D1 + Queues + Workers AI。一个 ES Modules Worker 同时承载 `/api/trpc`、健康/版本接口、最小预览页、受 API Key 保护的 Phase 0 探针和 Queue consumer；D1 是唯一权威存储，Queue 使用主队列与 DLQ，Workers AI 执行结构化输出探针。KV、R2、Browser Rendering、Containers 不创建、不绑定、不调用，因为精简 URL 保存与 AI 标签目标不需要它们；本阶段只证明服务不依赖这些可选组件，其额度或可用性不构成阻断。

**Tech Stack:** TypeScript 7.0.2、Cloudflare Workers/Wrangler 4.128.0、D1、Queues、Workers AI、tRPC 11.9.0、SuperJSON 2.2.1、Zod 4.2.0、Vitest 4.1.11、`@cloudflare/vitest-plugin` 1.1.3。

---

## 0. 范围、锁定证据与硬闸门

本计划只覆盖 [KARACLONE_SPEC.md](../../../KARACLONE_SPEC.md) 的 Phase 0 和 AT-000-1 至 AT-000-6。只有最终结论为 `GO` 才能另写正式实现计划；任何失败、缺失证据或无法测量都必须输出 `NO-GO`，不得继续 Web UI、完整 enrichment、搜索、迁移、KV 或 R2。

锁定输入：

- Karakeep commit：`5a2f009e2f6d266087f2f3f527e6e384cefd6de4`。
- Browser Extension：`1.2.11`。
- Mobile：`1.11.0`。
- 上游客户端链路：`httpBatchLink` → `${address}/api/trpc`，`Authorization: Bearer <apiKey>`，transformer 为 SuperJSON。
- 扩展关键调用：`apiKeys.validate`、`bookmarks.checkUrl`、`bookmarks.createBookmark`，打开 `/dashboard/preview/:id`。
- 移动端关键调用：`config.clientConfig`、`apiKeys.validate`、`users.whoami`、`users.settings`、`bookmarks.getBookmarks`、`bookmarks.getBookmark`、`highlights.getForBookmark`、`bookmarks.getReadingProgress`、`bookmarks.updateReadingProgress`。
- 默认 AI 模型：`@cf/meta/llama-3.1-8b-instruct-fast`。运行时不得静默换模型。

当前官方接口复核结果：

- Workers Free：100,000 请求/日，HTTP invocation 使用 Free Usage Model 原生固定 10ms CPU 上限；Free 不支持在 Wrangler 中配置 `limits.cpu_ms`，该字段仅适用于 Standard Usage Model。
- D1 Free：5,000,000 rows read/日、100,000 rows written/日、5GB；自 2026-09-01 起超额会直接失败。
- Queues Free：10,000 operations/日、不可配置的 24 小时 retention；`max_retries`、`dead_letter_queue` 和 `message.retry({delaySeconds})` 可用。Queue 创建后必须从官方控制面/资源详情读取并证明实际 retention 为 24 小时。
- Workers AI：10,000 Neurons/日免费；默认模型仍在 JSON Mode 官方支持列表。
- 测试必须使用当前 `@cloudflare/vitest-plugin`，不再新建基于旧 `@cloudflare/vitest-pool-workers` 的配置。

### 总体验收矩阵

| Gate | 通过条件 | 证据文件 |
|---|---|---|
| G0 | entitlement 三件套只能由 collector 后台启动本次空临时 Chrome/CDP profile 后原子生成；decision 重算官方账户与三方绑定，并从 Git 历史证明 collector/测试与 immutable manifests 同在唯一前置提交且源码未再改写 | `capture-workers-plan-entitlement.mjs`、`workers-plan-entitlement.test.ts`、Git commit/tree/blob、`workers-plan-entitlement.json`、`workers-plan-entitlement.html`、`workers-plan-entitlement.png`、`preflight.json`、`deploy-probes.json` |
| G1 | `local-tests.json` 证明 test、typecheck、deploy dry-run 均成功，Free 配置不含 `limits.cpu_ms`，bindings 与每小时 Cron 精确符合计划；G1/decision 只读 JSON，txt 仅为日志 | `artifacts/phase0/local-tests.json`、`artifacts/phase0/local-tests.txt` |
| G2 | probes deployment 身份完整且账户与 G0 正向 entitlement/API 证据相同；`deploy-probes.json` 直接保存并可重算两条 Queue 的官方资源详情，证明不可配置的 Free retention 实际为 24 小时；bootstrap/smoke/contract/AI/Queue 均以完整 DeploymentProvenance 绑定并通过 | `deploy-probes.json`、`bootstrap.json`、`smoke.json`、`remote-contract.json` |
| G3 | Task 1 两份 manifest 在同一唯一前置提交首次加入且 Git 历史证明 extension manifest 永久只读；独立 Store content binding 绑定其 canonical hash、实装/签名内容、profile/session 与 clients DeploymentProvenance；final 五件套引用并重算该 binding | Git commit/tree/blob、`extension-store-content-binding.json`、`extension-store-content-binding.test.ts`、`replay-final-store.mjs`、`replay-final-store.test.ts`、client lock、Store/client/content manifests、deploy/manual/freeze/wire/截图清单及 PNG |
| G4 | Git 历史证明 Task 1 Android manifest 自同一唯一前置提交首次加入后永久只读；独立 mobile-version-evidence 保存脱敏 dumpsys、版本 PNG/hash及完整 clients provenance，mobile manual 只引用其 canonical hash | Git commit/tree/blob、client lock、`android-client-manifest.json`、`mobile-version-evidence.json`、deploy/manual/freeze/wire/截图清单及 PNG |
| G5 | cpu deployment（capture=false）身份完整且本次 secret/path 安全注入；常用 HTTP 请求无 1102，GraphQL `cpuTimeP99 < 8000µs`；one-time free-limit 后 finally cleanup 覆盖部署、清除临时 binding 并恢复健康 | `deploy-cpu.json`、`cpu.json`、`free-limit.json`、`deploy-cleanup.json` |
| G6 | 默认模型 JSON Mode 返回值通过服务端 Zod 二次验证 | `artifacts/phase0/ai.json` |
| G7 | probes deployment 上 Queue/两个 Cron 功能通过；cpu artifacts 分别保存 Queue 与两个 Cron 的闭合窗口、expected/Telemetry counts 和 event IDs。exact cpu version 中 Queue unique>=1、Cron unique>=2、两个 Cron metadata.id 不同，timestamp 均落在各自窗口且 unique/expected/Telemetry count 闭合；再本地重算无 `exceededCpu` 且 max/P99 `cpuTimeMs<10` | `queue.json`、`cpu-invocation-run.json`、`queue-invocations.json` |
| G8 | G0–G7 决策结果经 schema/failedGates/GO 逻辑校验后原子输出，rename 后的 `decision.json` 再通过后置完整性检查 | `artifacts/phase0/decision.json` |

## Task 1: 最前置账户闸门与最小工程骨架

本 Task 的实际执行顺序覆盖下方历史编号，严格分三段：A）只创建最小 Node/Git 运行环境与 package-lock，不创建 Worker 入口、D1、Queue 或其他 Cloudflare 资源；B）实现并测试 canonical JSON、Android/CRX/Store verifier、Subscription/preflight 与 Dashboard entitlement evidence schema，此阶段允许证据脚本代码，但禁止业务 Worker 代码和资源创建；C）实际运行 Android/CRX/Store 验证、Cloudflare API preflight 与 Workers Free Dashboard entitlement，人工审核并提交 client lock、Store/包 manifests、`preflight.json`、`workers-plan-entitlement.json`。仅当 G0 与 client lock 均通过后，才执行下方资源创建步骤、安装其余业务依赖并开始 Task 2。任何前置失败立即原子写 `NO-GO` 并停止。不得在 verifier 尚未实现时调用它，也不得先创建 D1/Queues 再做 preflight。

**Files（A/B/C 前置阶段，仅限最小 Node/Git、证据脚本与证据 artifact）：**

- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `test/tsconfig.json`
- Create: `vitest.config.ts`
- Create: `scripts/phase0/write-preflight.mjs`
- Create: `scripts/phase0/capture-workers-plan-entitlement.mjs`
- Create: `scripts/phase0/canonical-json.mjs`
- Create: `test/preflight.test.ts`
- Create: `test/workers-plan-entitlement.test.ts`
- Create: `test/canonical-json.test.ts`
- Create: `scripts/phase0/verify-android-package.mjs`
- Create: `scripts/phase0/verify-extension-package.mjs`
- Create: `test/package-verifiers.test.ts`
- Create: `config/phase0/client-lock.json`
- Create: `artifacts/phase0/preflight.json`
- Create: `artifacts/phase0/android-client-manifest.json`
- Create: `artifacts/phase0/extension-client-manifest.json`
- Create: `artifacts/phase0/extension-store-evidence.json`
- Create: `artifacts/phase0/extension-store-evidence.png`
- Create: `artifacts/phase0/workers-plan-entitlement.json`
- Create: `artifacts/phase0/workers-plan-entitlement.html`
- Create: `artifacts/phase0/workers-plan-entitlement.png`

**Files（仅在 G0 与 RESOLVED client lock 均通过并提交后创建）：**

- Create: `test/apply-migrations.ts`
- Create: `wrangler.jsonc`
- Create: `worker-configuration.d.ts`
- Create: `src/index.ts`

- [ ] **C 段：仅在 B 段 verifier/preflight/evidence 脚本及测试已实现后，实际解析、人工审阅并提交客户端信任锁**

先由两个 verifier 生成 `config/phase0/client-lock.json.tmp`，人工逐项对照下列独立官方来源和常量，确认后原子改名为 `config/phase0/client-lock.json`，并仅纳入下方唯一前置提交，不得先单独提交。任何 `lockStatus!=="RESOLVED"`、字段缺失、候选包与独立信任根混用或人工审阅未记录时，立即输出 Phase 0 `NO-GO`；Task 2 及之后任何业务 schema、migration、Worker 或测试实现均不得开始。

Android 锁必须精确保存：`versionName:"1.11.0"`、`versionCode:45`、`url:"https://github.com/karakeep-app/mobile-releases/releases/download/1.11.0/karakeep.apk"`、`assetId:536907626`、`size:150947254`、`packageId:"app.hoarder.hoardermobile"`、`packageSha256:"eb6891a77f1d6471f6139622e2f9242f24fae100ec6f9b0f63d044dfaaa37eab"`、`sourceRepository:"https://github.com/karakeep-app/mobile-releases"`、`sourceTag:"android/v1.11.0-0"`、`sourceCommit:"5780b6eb009cb9dfcca5614aa4f5e2ef501786f3"`、`signingCertificateSha256:"0A:9F:4A:6B:90:0B:DA:E4:D4:AD:7E:F3:E7:D7:73:90:1D:87:08:84:1A:DB:29:4C:49:4B:18:2A:1E:81:C3:D9"`。下载后字节数、SHA-256、apkanalyzer 字段、apksigner 证书必须逐项相等。

扩展的独立信任根必须先写 `extension-store-evidence.json` 和实体 `extension-store-evidence.png`：JSON 固定 Store URL、ID `kgcjekpmcjjogibpjebkhaanilehneje`、version `1.2.11`、publisher `karakeep.app`、获取时间、规范化官方页面/响应 hash，并以 `{file:"extension-store-evidence.png",sha256}` 直接绑定同次截图、人工审核者与审核时间；截图先脱敏并确认无秘密。其 canonical hash 写入 client lock 与 extension client manifest。`package-verifiers.test.ts` 与 Task 15 必须从 PNG 字节重算 SHA-256，截图缺失、替换或 hash 不符均失败。扩展不以 immutable asset URL、asset ID、signer/public-key allow-list 或候选 package hash 作为信任条件；这些条件仅适用于 Android。扩展信任条件仍仅为固定 Google 请求模板、Google 官方 TLS redirect-host allow-list、离线 CRX3 proof、公钥派生 ID及独立 Store ID/version/publisher evidence。

```bash
rtk node scripts/phase0/verify-android-package.mjs --write-lock config/phase0/client-lock.json.tmp
rtk node scripts/phase0/verify-extension-package.mjs --write-lock config/phase0/client-lock.json.tmp
# 人工审阅上述独立来源、常量和 verifier 投影后，脚本原子 finalize；禁止手工复制候选包字段作为 allow-list
rtk node scripts/phase0/verify-extension-package.mjs --finalize-lock config/phase0/client-lock.json.tmp --out config/phase0/client-lock.json
```

此处不得先提交局部 lock；所有 B/C 脚本、测试与最终前置证据必须在下方唯一前置提交中一起冻结，避免首次与后续提交清单冲突。

- [ ] **Step 1: 再做机器可验证的账户与订阅硬检查，不写业务代码**

为 `write-preflight.mjs` 提供仅具 Billing Read 权限的独立 `CLOUDFLARE_BILLING_READ_TOKEN` 环境变量；token 只存在于当前进程环境，不写 `.dev.vars`、命令参数、stdout/stderr 或 artifact。脚本必须实际运行：

```bash
rtk npx wrangler@4.128.0 whoami --json
```

从 `wrangler whoami --json` 的账户 ID 计算 `whoamiAccountIdSha256`；Billing 请求路径中的 `{account_id}` 另行计算 `billingRequestAccountIdSha256`，两者必须相等。随后以该 token 调用官方 `GET /accounts/{account_id}/subscriptions?page=N&per_page=100`，严格按响应 `result_info.page:number`、`result_info.per_page:number`、`result_info.count:number`、`result_info.total_count:number` 逐页抓取，直到已收集的唯一 subscription ID 数等于 `total_count`。每项必须有且类型精确为 `result[].id:string`、`result[].price:number`、`result[].state:"Trial"|"Provisioned"|"Paid"|"AwaitingPayment"|"Cancelled"|"Failed"|"Expired"`、`result[].rate_plan.id:string`、`result[].rate_plan.scope:string|null`、`result[].rate_plan.sets:string[]`、`result[].rate_plan.is_contract:boolean`、`result[].rate_plan.externally_managed:boolean`。即使上游 schema 把后四项标为 optional，它们也全部用于保守判定，缺失即 `NO-GO`。缺字段、类型不符、未知 state、空/重复 subscription ID、页码重复/缺页/不前进、分页参数或总数矛盾、单页 `result.length!==result_info.count`，或最终唯一 subscription ID 数不等于 `total_count` 均失败。原始 ID 不落盘；每项保存 `subscriptionIdSha256`，每页只生成公开 `pageProjection` 并计算 canonical hash。`rate_plan.scope/sets` 只原样规范化投影留证，绝不用于判断订阅属于 Workers。

同一 C 段还须在已登录 Cloudflare 官方 Dashboard 打开该账户的 Workers 计划页面，页面中的 account ID 与 token API account ID 精确相等后才生成 `workers-plan-entitlement.json`。artifact 必须直接保存无敏感 `canonicalDashboardUrl`、`normalizedSelectorText`、脱敏 `renderedDomEvidence`、`selectorVersion`、`extractionRulesVersion`，以及 URL/text/DOM/截图/account 各自 hash、capturedAt、reviewedBy/reviewedAt、canonicalSha256、passed；禁止只保存无法重算的 hash。稳定 selector 读到的规范化官方文本必须明确写出 `Workers Free`，并按同一 extraction rule 从 DOM 提取明确 account ID。截图与 DOM 证据不得含 token、cookie、Authorization、key、个人信息或其他秘密。

`capture-workers-plan-entitlement.mjs` 是三件套的唯一生成器，禁止手工创建最终 JSON/HTML/PNG。它必须自行以后台子进程启动专用 Chrome，创建并记录本次空临时 `expectedUserDataDir`、随机本地 debugging port、Chrome PID、启动参数与不可重放的 `profileSessionNonce`，再暂停并提示用户只在它启动的窗口登录 Cloudflare、选择目标账户，确认后继续。采集前必须从 OS 进程参数、CDP version/user-data-dir 信息和实际 `Profile Path` 交叉验证 PID、启动参数、endpoint、nonce 与路径全部属于本次空临时目录；拒绝日常或已有 profile、已有扩展、错误 PID/args/path/nonce、non-current endpoint，以及同账户但不是本次 profile 的会话。collector 自行导航/读取当前 canonical `https://dash.cloudflare.com/<target-account>/...` Workers plan URL，通过 CDP `Runtime.evaluate` 获取 rendered DOM、selector text 与 account ID，通过 `Page.captureScreenshot` 获取 PNG，并与 `--account-id-source preflight.json` 比较。raw 数据只在内存脱敏/secret scan，三件套原子写入；成功或失败退出时均终止本次 Chrome、删除临时 profile 和 raw 数据。脚本不得接受 `--dom-input`、`--png-input` 或已有 final artifact，任一失败不得产出三件套。

`workers-plan-entitlement.test.ts` 必须覆盖 wrong HTTPS host/path/account、stale/prebuilt outputs、selector missing/无法重提取、含糊或不唯一的 Free 文本、DOM secret、`Page.captureScreenshot` 失败、wrong Chrome PID/启动参数/Profile Path/session nonce、non-current CDP endpoint、同账户但非本次 profile，并保留 Dashboard/API/deploy account 三方不等用例；全部断言 generator 非零退出且不产生 JSON/HTML/PNG。该本地 Chrome/CDP 流程不使用 Cloudflare Browser Rendering，不创建或调用 Cloudflare Browser Rendering 资源，不产生 Cloudflare 费用。

前置 C 段实际执行命令固定为：

```bash
rtk npm test -- test/canonical-json.test.ts
rtk npm test -- test/package-verifiers.test.ts
rtk npm test -- test/preflight.test.ts
rtk npm test -- test/workers-plan-entitlement.test.ts
rtk node scripts/phase0/write-preflight.mjs --out artifacts/phase0/preflight.json
# 单一命令由 collector 后台启动专用 Chrome，暂停等待用户在该 profile 登录/选择目标账户后继续
rtk node scripts/phase0/capture-workers-plan-entitlement.mjs --launch-chrome --account-id-source artifacts/phase0/preflight.json --out-dir artifacts/phase0
rtk git add package.json package-lock.json tsconfig.json test/tsconfig.json vitest.config.ts scripts/phase0/canonical-json.mjs scripts/phase0/verify-android-package.mjs scripts/phase0/verify-extension-package.mjs scripts/phase0/write-preflight.mjs scripts/phase0/capture-workers-plan-entitlement.mjs test/canonical-json.test.ts test/package-verifiers.test.ts test/preflight.test.ts test/workers-plan-entitlement.test.ts config/phase0/client-lock.json artifacts/phase0/android-client-manifest.json artifacts/phase0/extension-client-manifest.json artifacts/phase0/extension-store-evidence.json artifacts/phase0/extension-store-evidence.png artifacts/phase0/preflight.json artifacts/phase0/workers-plan-entitlement.json artifacts/phase0/workers-plan-entitlement.html artifacts/phase0/workers-plan-entitlement.png
rtk git commit -m "test: freeze phase0 preflight gate"
```

上述测试必须严格按 canonical → package/Store evidence → preflight → entitlement 顺序全部通过，随后实际 artifacts 也全部通过并完成这一独立前置 commit；只有该 commit 存在且 G0 与 `lockStatus=RESOLVED` 均通过，才允许创建 Worker 入口、业务依赖或任何 Cloudflare 资源。`android-client-manifest.json` 与 `extension-client-manifest.json` 必须在该同一个提交中首次加入，从此永久只读；`capture-workers-plan-entitlement.mjs` 与 `workers-plan-entitlement.test.ts` 也在该提交冻结。不得通过后续 amend/rebase、第二次提交或 JSON 自报字段伪造此约束；最终 decision 直接查询 Git object/history 验证。

该唯一前置提交完成后立即人工记录命令输出以便后续对照，但不另建可篡改 lock artifact：`git rev-parse HEAD` 得 commit SHA，`git rev-parse HEAD^{tree}` 得 tree SHA，`git rev-parse HEAD:artifacts/phase0/android-client-manifest.json` 与 extension 路径得两个 blob SHA。Task 15 必须自行重跑等价 Git 查询并以首次加入历史为根重新计算，不能信人工记录。

decision 的 G0 输入必须同时包含 collector、其 fail-closed 测试以及 JSON/HTML/PNG 三件套；它不生成或修补证据，重算并验证 `expectedUserDataDir`、Chrome PID/args、实际 Profile Path、CDP endpoint 与 `profileSessionNonce` 的本次会话绑定，再验证官方 URL/account 和 DOM/selector/rule、截图、secret scan及 Dashboard/API/deploy 三方 account hash。错误 PID/args/profile/nonce、non-current endpoint、同账户但非本次 profile、旧/预建 artifact 或任一证据不可重算均 G0 `NO-GO`。

同一最早期 gate 还必须运行两个可重放包验证器；未通过时立即 `NO-GO`，不得进入业务 Task：

- `verify-android-package.mjs` 从锁定的官方不可变 asset URL 下载已签名 Android APK，记录最终 URL、asset ID、version、build、package SHA-256 与工具版本；运行 Android Build Tools 的 `apksigner verify --verbose --print-certs` 及 `apkanalyzer manifest application-id|version-name|version-code`（或计划中锁定的等价工具），保存原始命令输出的脱敏规范化投影及 canonical hash，并校验预期 package ID、version/build、签名证书 SHA-256 allow-list。
- `verify-extension-package.mjs` 仅按固定 Google update 请求模板下载 Chromium CRX3，校验 redirect-host allow-list、CRX3 cryptographic proof，从已验证公钥派生 extension ID，并与独立 Store ID/version/publisher evidence 比较；记录 package SHA-256、signer public-key SHA-256、verifier 版本和可重算投影，但 signer/public-key hash 仅作观测，不参与信任判定。

Android verifier 必须拒绝非锁定 immutable asset URL、错误 asset ID、可变 URL、非 allow-list host、不可导出包或 `packageSha256:null`。扩展不使用 `immutableSourceUrl/assetId`：只接受锁定的 Google `service/update2/crx` 请求模板、固定 extension ID、显式固定并记录的 `prodversion` 与批准的 Google TLS redirect host，并将 request（含 prodversion）、redirect chain、响应投影及 CRX proof 分别 canonical hash 绑定；任何字段变化、unsigned ZIP 或签名链不可离线复验均失败。artifact 不得用 `signatureVerified:true` 代替验证投影。Task 15 重放各自规则并逐 hash 比较。

两份锁定 manifest 的公共 schema 固定包含 `clientLockSha256/lockStatus/client/platform/version/build/packageId/packageSha256/packageSize/verifierVersions/verificationProjection/verificationProjectionSha256/canonicalSha256/passed`，其中所有 SHA-256 必须为 64 位 lowercase hex、字段不可为 null。extension schema 与 client lock 的 extension trust section 必须拒绝 `immutableSourceUrl/assetId/signerAllowList`，改含 `storeEvidenceSha256/crxRequestTemplate/redirectHostAllowList/redirectChain/responseHeadersProjection/downloadedAt/crxFormat:"CRX3"/extensionId/signerPublicKeySha256/crxProofProjection` 及对应可重算 hash；`signerPublicKeySha256`、package/final URL hash 只允许出现在 `observations`/本次重放绑定中，禁止出现在 trust inputs、allow-list 或通过条件。mobile 另含 `immutableSourceUrl/finalUrl/assetId/sourceRepository/sourceTag/sourceCommit/signingCertificateSha256/signerAllowList/apksignerProjection/apkanalyzerProjection`。所有值必须来自并匹配已提交的 RESOLVED lock；`verificationProjection` 是原始工具输出解析后的稳定、脱敏、可机械重算投影，不含包字节、账户或 secret；`passed` 只能由各投影、hash 和各平台独立信任根比较派生，决策器忽略该布尔并自行重算。

`package-verifiers.test.ts` 同时承担必要的 Store-evidence tests：必须构造 Store ID/version/publisher/page/screenshot hash 缺失或不符，以及扩展 `signerAllowList`、`trustedSignerPublicKeySha256`、候选 package/public-key hash 被写入 trust section 或参与 `passed` 的 fixtures，并全部断言失败；Android signing certificate allow-list 的对应 fixture 仍须通过。Task 15 decision fixtures 同样必须证明：即使观测到的 signer/public-key hash 与历史值相等，也不能替代 Google 请求模板、redirect-host allow-list、CRX3 proof、公钥派生 ID 与独立 Store ID/version/publisher evidence 中任一项。

- [ ] **Step 2: 仅在 G0/client lock 通过后创建 Worker 骨架并安装固定业务依赖**

A 段先初始化 Git，并创建最小 `package.json`/`package-lock.json`；其中只能包含运行 canonical JSON、preflight、包验证、Dashboard entitlement capture 及其 fail-closed tests 所必需的依赖，不得包含 tRPC、SuperJSON、Zod、Cloudflare Workers runtime/plugin 或其他业务依赖。B/C 段不得创建 `src/index.ts`、`wrangler.jsonc`、`worker-configuration.d.ts`、migration、D1、Queue、Worker deployment 或任何 Cloudflare 资源。

只有前置 G0 三件套、preflight 与 RESOLVED client lock 全部通过、人工复核并提交后，才允许把 `package.json` 扩展为下列完整固定依赖，更新 lockfile，并创建上列 Worker 骨架文件；任一前置失败必须立即 `NO-GO`，不得执行本 Step。

`package.json` 使用精确版本：

```json
{
  "name": "karaclone-phase0",
  "private": true,
  "type": "module",
  "scripts": {
    "cf:types": "wrangler types worker-configuration.d.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --max-workers=1 --no-isolate",
    "deploy": "wrangler deploy --strict --message phase0-go-no-go",
    "d1:migrate:remote": "wrangler d1 migrations apply karaclone-phase0 --remote",
    "phase0:preflight": "node scripts/phase0/write-preflight.mjs"
  },
  "dependencies": {
    "@trpc/server": "11.9.0",
    "superjson": "2.2.1",
    "zod": "4.2.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.1.3",
    "@cloudflare/workers-types": "5.20260902.1",
    "@trpc/client": "11.9.0",
    "@types/node": "26.4.1",
    "typescript": "7.0.2",
    "vitest": "4.1.11",
    "wrangler": "4.128.0"
  }
}
```

`.gitignore`：

```gitignore
node_modules/
.wrangler/
.dev.vars
.phase0/
artifacts/phase0/*.secret
```

Phase 0 所有 artifact 哈希统一复用 `scripts/phase0/canonical-json.mjs`：仅接受 JSON 的 null/boolean/string/有限数字/数组/普通对象；对象 key 按 Unicode code point 递归升序，数组保序；字符串保持原 Unicode code points、不做 NFC/NFD 归一化，并按 JSON 必需规则转义；数字使用 ECMAScript `JSON.stringify` 的最短十进制表示，`-0` 规范为 `0`。拒绝 `undefined`、函数、symbol、BigInt、NaN、±Infinity、稀疏数组、重复解析 key、非普通对象及循环引用。最终文本无空白/尾换行，以 UTF-8 编码后 SHA-256 lowercase hex。计算 artifact 自身 hash 时递归排除所有名为 `canonicalSha256` 的自哈希字段；其他字段不得排除。preflight、四份 deploy、freeze、wire、manual 与客户端 manifest 全部调用此唯一实现。`test/canonical-json.test.ts` 用固定向量覆盖 UTF-8、多语言/代理对、key 顺序、数字/`-0`、非法值、自哈希排除、输入不变性及跨 artifact 一致性。

Commands：

```bash
rtk git init
rtk npm install
```

Expected：生成 `package-lock.json`，安装过程无 peer dependency error。

- [ ] **Step 3: 拉取并验证锁定的上游协议源码**

```bash
rtk git clone --filter=blob:none https://github.com/karakeep-app/karakeep.git .phase0/upstream/karakeep
rtk git -C .phase0/upstream/karakeep checkout --detach 5a2f009e2f6d266087f2f3f527e6e384cefd6de4
rtk git -C .phase0/upstream/karakeep rev-parse HEAD
```

Expected：最后一行精确为锁定 commit。Task 2 只把该目录列明的文件作为互操作性参考，按已审核 spec 独立重写字段/类型；不得复制实现、注释、UI 或导入任何 `@karakeep/*` 包。若 commit 不存在或 procedure 与计划不符，立即 `NO-GO`，不能改用主分支。

- [ ] **Step 4: 建立 Worker 配置，但不引入禁用资源**

`wrangler.jsonc`：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "karaclone-phase0",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": { "invocation_logs": true }
  },
  "ai": { "binding": "AI" },
  "vars": {
    "SERVER_VERSION": "0.1.0",
    "AI_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast",
    "PHASE0_CAPTURE": "true"
  },
  "triggers": {
    "crons": ["0 * * * *"]
  },
  "queues": {
    "producers": [
      { "binding": "ENRICHMENT_QUEUE", "queue": "karaclone-phase0-enrichment" }
    ],
    "consumers": [
      {
        "queue": "karaclone-phase0-enrichment",
        "max_batch_size": 1,
        "max_batch_timeout": 1,
        "max_retries": 3,
        "dead_letter_queue": "karaclone-phase0-enrichment-dlq"
      },
      {
        "queue": "karaclone-phase0-enrichment-dlq",
        "max_batch_size": 1,
        "max_batch_timeout": 1,
        "max_retries": 0
      }
    ]
  }
}
```

`src/index.ts` 先放可编译的空入口：

```ts
export default {
  fetch(): Response {
    return new Response("phase0 scaffold", { status: 503 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **G0 与 client lock 均通过后的资源阶段：创建免费层远端资源并生成 Env 类型**

```bash
rtk npx wrangler d1 create karaclone-phase0 --location apac --binding DB --update-config
rtk npx wrangler queues create karaclone-phase0-enrichment
rtk npx wrangler queues create karaclone-phase0-enrichment-dlq
rtk npm run cf:types
```

Expected：`wrangler.jsonc` 被自动加入 `DB` binding 和真实 UUID，且所有 Free profile 配置均不含 `limits.cpu_ms`；生成 `worker-configuration.d.ts`，其中包含 `DB: D1Database`、`AI: Ai`、`ENRICHMENT_QUEUE: Queue`。Free Queue retention 不可配置，创建命令禁止传 retention 参数；创建后必须立即通过官方控制面/资源详情确认两条 Queue 的实际 retention 均为 24 小时，详情缺失或非 24 小时立即停止。Task 11 的 `deploy.mjs` 再从同一官方来源获取两条 Queue 的脱敏资源详情投影、查询来源、retention 值与 canonical hash，直接写入 `deploy-probes.json` 作为 Task 15 可重算的 fail-closed 证据；不得回写唯一前置提交中的 `preflight.json`。证据不可重算、retention 非 24 小时或任一步要求付费均为 `NO-GO`。

- [ ] **Step 6: 配置当前 Workers Vitest 插件和 D1 migrations 注入**

`vitest.config.ts`：

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
```

`test/apply-migrations.ts`：

```ts
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

执行器要在 `test/tsconfig.json` 中加入 `"types": ["@cloudflare/vitest-plugin/types"]`，并让 `worker-configuration.d.ts` 同时包含测试专用 `TEST_MIGRATIONS: D1Migration[]`。

- [ ] **Step 7: 写入预检证据**

`scripts/phase0/write-preflight.mjs` 保存每页公开 `pageProjection`，字段严格为 `page/perPage/totalCount/count/items/canonicalSha256`；items 每项严格为 `subscriptionIdSha256/ratePlanId/state/price/scope/sets/isContract/externallyManaged`，后六项分别来自 `result[].rate_plan.id/scope/sets/is_contract/externally_managed` 与顶层 state/price，`sets` 排序去重，items 与 pages 均按 canonical 字节稳定排序。官方 state 只允许 `Trial|Provisioned|Paid|AwaitingPayment|Cancelled|Failed|Expired`，大小写精确；未知 state、重复 subscriptionIdSha256 或任何判定字段缺失/类型错误均 fail-closed。扁平 `subscriptionProjection` 由全部 pageProjection.items 派生；`scope/sets` 仅留证。

`test/preflight.test.ts` 通过注入执行器/fetch 覆盖：whoami/API 失败、两个 account hash 不一致、所有字段路径/类型、分页缺失/重复/不前进/计数矛盾、重复 `result[].id`、唯一订阅 ID 数不等于 `result_info.total_count`、pageProjection/hash 篡改、七种官方 state、未知 state、四种活跃 state、`result[].rate_plan.is_contract=true`、`result[].rate_plan.externally_managed=true`、token/原始响应落盘；任何风险项均 `passed:false`，只有完整分页且所有项均为 `Cancelled|Failed|Expired`、两个风险布尔为 false 才可通过，不检查 scope/sets 产品语义。`test/package-verifiers.test.ts` 覆盖固定 APK/CRX3 成功向量以及 URL/asset/version/build/package ID/extension ID/package hash/signer allow-list/cryptographic proof/工具版本/规范化输出 hash 的每种不一致，覆盖 ZIP、商店 UI、不可导出包和 null hash 全部失败。先运行测试，Expected：实现前失败、实现后通过。

```js
{
  "whoamiAccountIdSha256": "<64 lowercase hex>",
  "billingRequestAccountIdSha256": "<same 64 lowercase hex>",
  "pageCount": 2,
  "totalCount": 101,
  "projectedCount": 101,
  "pageProjections": [{"page":1,"perPage":100,"totalCount":101,"count":100,"items":[],"canonicalSha256":"<hash>"}],
  "uniqueSubscriptionIdCount": 101,
  "subscriptionProjection": [{"subscriptionIdSha256":"<64 lowercase hex>","ratePlanId":"free","state":"Cancelled","price":0,"scope":null,"sets":[],"isContract":false,"externallyManaged":false}],
  "subscriptionProjectionSha256": "<64 lowercase hex>",
  "activeOrPendingSubscriptionCount": 0,
  "contractOrExternallyManagedCount": 0,
  "subscriptionRiskFree": true,
  "upstreamCommit": "5a2f009e2f6d266087f2f3f527e6e384cefd6de4",
  "extensionVersion": "1.2.11",
  "mobileVersion": "1.11.0",
  "checkedAt": "2026-09-02T00:00:00.000Z",
  "canonicalSha256": "<64 lowercase hex>",
  "passed": true
}
```

只有两个账户 hash 相等、分页闭合，且所有订阅均不处于 `Trial|Provisioned|Paid|AwaitingPayment`、所有 `isContract/externallyManaged` 均为 false 才能通过；`Cancelled|Failed|Expired` 仍须完整投影。rate plan、price、scope、sets 均保留为公开审计字段，但不得由其推断 Workers 产品。`decide` 从 pageProjection 重算每页 hash、分页闭合、扁平稳定投影、数量、投影 hash 和风险结论，不能信派生布尔/计数；G0 不得单独输出或声称 Workers Free，最终运行态结论必须等待 G2 同账户部署证据。

Command：

```bash
rtk git add package.json package-lock.json test/apply-migrations.ts wrangler.jsonc worker-configuration.d.ts src/index.ts
rtk git commit -m "chore: scaffold phase0 free-tier probe"
```

## Task 2: 先锁定协议 schema 与失败测试

**硬前置：** 唯一 Task 1 前置提交、G0 与 client lock 已通过。此后创建的 Free Worker 配置及 Task 2 以后所有 dry-run/deploy fixtures 都必须拒绝 `limits.cpu_ms`；10ms 是 Free Usage Model 的原生固定上限，不是可配置字段，后续只由 authenticated one-time free-limit 1102/`exceededCpu` 闭环验证。

**Files:**

- Create: `src/contracts/bookmarks.ts`
- Create: `src/contracts/client-config.ts`
- Create: `src/contracts/users.ts`
- Create: `src/contracts/phase0.ts`
- Create: `test/contracts.test.ts`

**Locked read-only references:**

- `.phase0/upstream/karakeep/packages/shared/types/config.ts`
- `.phase0/upstream/karakeep/packages/shared/types/users.ts`
- `.phase0/upstream/karakeep/packages/shared/types/bookmarks.ts`
- `.phase0/upstream/karakeep/packages/shared/types/highlights.ts`
- `.phase0/upstream/karakeep/packages/shared/types/pagination.ts`
- `.phase0/upstream/karakeep/packages/trpc/routers/apiKeys.ts`
- `.phase0/upstream/karakeep/packages/trpc/routers/lists.ts`
- `.phase0/upstream/karakeep/packages/trpc/routers/bookmarks.ts`

- [ ] **Step 1: 写锁定客户端契约测试，确认先红**

测试必须覆盖：API key 格式、完整 `clientConfig`、WhoAmI、settings、Bookmark Date、link content、cursor v2、AI 输出。关键断言：

```ts
expect(apiKeySchema.safeParse("ak2_k1_secret").success).toBe(true);
expect(clientConfigSchema.parse(clientConfigFixture).auth.disablePasswordAuth).toBe(true);
expect(bookmarkSchema.parse(bookmarkFixture).createdAt).toBeInstanceOf(Date);
expect(getBookmarksResponseSchema.parse({ bookmarks: [bookmarkFixture], nextCursor: null })).toBeTruthy();
expect(aiTagResultSchema.safeParse({ tags: ["cloudflare"], description: null }).success).toBe(true);
expect(aiTagResultSchema.safeParse({ tags: [], description: null }).success).toBe(false);
```

Command：

```bash
rtk npm test -- test/contracts.test.ts
```

Expected：因模块不存在而失败。

- [ ] **Step 2: 实现精确最小 schema**

`src/contracts/phase0.ts`：

```ts
import { z } from "zod";

export const apiKeySchema = z.string().regex(/^ak2_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
export const aiTagResultSchema = z.object({
  tags: z.array(z.string().min(1).max(40)).min(1).max(8),
  description: z.string().max(300).nullable(),
});
export type AiTagResult = z.infer<typeof aiTagResultSchema>;
```

`bookmarks.ts` 必须把 `createdAt`、`modifiedAt`、`crawledAt` 声明为 `z.date()`/nullable，不得用 ISO string；link 的所有未启用资源 ID、reader 字段和 `htmlContent` 都保留 nullable 字段；`assets` 为数组；create response 在 bookmark 上扩展 `alreadyExists:boolean`。

`client-config.ts` 必须按已审核 spec 逐字段独立重写与锁定 `zClientConfigSchema` 等价的 schema；`users.ts` 同样独立重写 `WhoAmI` 和 user settings schema，其中 `tagStyle` 包含已锁定枚举并使用 `lowercase-spaces`。不得复制上游注释或实现代码。

- [ ] **Step 3: 运行契约测试并提交**

```bash
rtk npm test -- test/contracts.test.ts
rtk npm run typecheck
rtk git add src/contracts test/contracts.test.ts
rtk git commit -m "test: lock karakeep phase0 wire schemas"
```

Expected：全部通过，且无 `any`、无手写日期 string 降级。

## Task 3: D1 数据模型、日期与重复 URL 契约

**Files:**

- Create: `migrations/0001_phase0.sql`
- Create: `src/db/bookmarks.ts`
- Create: `src/db/users.ts`
- Create: `src/db/jobs.ts`
- Create: `src/url/canonicalize.ts`
- Create: `test/d1-bookmarks.test.ts`

- [ ] **Step 1: 先写 D1 失败测试**

覆盖：用户/key 插入、bookmark/link/job 使用一个 `DB.batch`、epoch millisecond → Date、canonical URL 唯一约束、相同 URL 返回同一 bookmark、query 顺序保留、fragment 删除、默认端口删除。

```ts
expect(canonicalizeUrl("HTTPS://ExAmPle.com:443/a/#x")).toBe("https://example.com/a");
expect(canonicalizeUrl("https://example.com/?b=2&a=1")).toBe("https://example.com/?b=2&a=1");
expect(first.id).toBe(second.id);
expect(second.alreadyExists).toBe(true);
expect(first.createdAt).toBeInstanceOf(Date);
```

Command：`rtk npm test -- test/d1-bookmarks.test.ts`；Expected：失败。

- [ ] **Step 2: 建立最小 migration**

`migrations/0001_phase0.sql` 至少包含以下权威字段和约束：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'fullaccess'),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  title TEXT,
  note TEXT,
  summary TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  favourited INTEGER NOT NULL DEFAULT 0 CHECK (favourited IN (0,1)),
  source TEXT,
  crawl_status TEXT CHECK (crawl_status IN ('pending','success','failure')),
  tagging_status TEXT CHECK (tagging_status IN ('pending','success','failure')),
  created_at INTEGER NOT NULL,
  modified_at INTEGER,
  UNIQUE(user_id, canonical_url)
);

CREATE TABLE bookmark_links (
  id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  favicon TEXT,
  crawled_at INTEGER
);

CREATE TABLE reading_progress (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offset INTEGER NOT NULL,
  anchor TEXT,
  percent INTEGER CHECK (percent BETWEEN 0 AND 100),
  modified_at INTEGER NOT NULL,
  PRIMARY KEY(bookmark_id, user_id)
);

CREATE TABLE enrichment_jobs (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','retry_wait','success','failure','dead','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  lease_expires_at INTEGER,
  last_message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX enrichment_jobs_one_active
ON enrichment_jobs(bookmark_id)
WHERE status IN ('pending','running','retry_wait');

CREATE INDEX enrichment_jobs_retry_idx
ON enrichment_jobs(status, next_retry_at, created_at);
```

- [ ] **Step 3: 实现 canonical URL 和 D1 mapper**

`canonicalize.ts` 必须仅执行规格规定的变化：

```ts
export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL_VALIDATION_FAILED");
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}
```

D1 mapper 必须使用整数毫秒，返回对象时 `new Date(row.created_at)`；不得把 D1 row 原样透传给客户端。创建流程先检查 canonical URL，再用 `env.DB.batch([...])` 写 bookmark、link、job；遇到唯一约束后重新读取并返回 `alreadyExists:true`。

- [ ] **Step 4: 验证 migration 和 D1 契约**

```bash
rtk npm test -- test/d1-bookmarks.test.ts
rtk npm run typecheck
rtk git add migrations src/db src/url test/d1-bookmarks.test.ts
rtk git commit -m "feat: add phase0 d1 bookmark contract"
```

Expected：重复 URL 仅一行，Date 为 Date，测试独立运行两次仍通过。

## Task 4: API Key SHA-256、固定时间比较与 tRPC 基础设施

**Files:**

- Create: `src/auth/api-key.ts`
- Create: `src/trpc/context.ts`
- Create: `src/trpc/base.ts`
- Create: `src/trpc/router.ts`
- Create: `test/auth.test.ts`
- Create: `test/trpc-auth.test.ts`

- [ ] **Step 1: 先写认证失败测试**

测试有效、错误 secret、已吊销、错误格式、无 Bearer、`apiKeys.exchange` FORBIDDEN，且数据库里不存在明文 secret。

```ts
expect(await authenticateApiKey(env.DB, validKey)).toMatchObject({ id: userId });
expect(await authenticateApiKey(env.DB, validKey + "x")).toBeNull();
expect(await authenticateApiKey(env.DB, "not-a-key")).toBeNull();
expect(stored.secret_hash).not.toContain(secret);
```

Command：`rtk npm test -- test/auth.test.ts test/trpc-auth.test.ts`；Expected：失败。

- [ ] **Step 2: 实现 Web Crypto SHA-256 和固定时间比较**

```ts
const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fixedTimeEqualHex(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}
```

Key 拆为 `ak2_<keyId>_<secret>`，只查询 `key_id`，再比较 secret hash；成功后用 `ExecutionContext.waitUntil()` 更新 `last_used_at`，不得产生悬空 Promise。

- [ ] **Step 3: 建立 tRPC context 与 protected procedure**

```ts
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

export type Context = {
  env: Env;
  req: Request;
  executionCtx: ExecutionContext;
  user: { id: string; name: string | null; email: string | null } | null;
};

const t = initTRPC.context<Context>().create({ transformer: superjson });
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
```

`createContext` 从 `Authorization: Bearer` 读取 key；公开 procedure 允许 `user:null`。不得在模块全局缓存用户或 D1 结果。

- [ ] **Step 4: 验证 tRPC auth envelope 并提交**

```bash
rtk npm test -- test/auth.test.ts test/trpc-auth.test.ts
rtk npm run typecheck
rtk git add src/auth src/trpc test/auth.test.ts test/trpc-auth.test.ts
rtk git commit -m "feat: add karakeep api key authentication"
```

## Task 5: 客户端启动所需的配置、用户与 API Key procedures

**Files:**

- Create: `src/trpc/routers/api-keys.ts`
- Create: `src/trpc/routers/config.ts`
- Create: `src/trpc/routers/users.ts`
- Modify: `src/trpc/router.ts`
- Create: `test/client-bootstrap.test.ts`

- [ ] **Step 1: 写出锁定客户端的精确输出测试**

测试 `config.clientConfig` 可匿名访问；`apiKeys.validate` 接收 `{ apiKey }`；`users.whoami` 与 `users.settings` 必须认证。固定如下关键断言：

```ts
expect(clientConfig.serverVersion).toBe("0.1.0");
expect(clientConfig.publicApiUrl).toBe("https://example.com");
expect(clientConfig.inference).toMatchObject({ isConfigured: true, inferredTagLang: "zh-CN" });
expect(clientConfig.auth).toMatchObject({ disableSignups: true, disablePasswordAuth: true });
expect(settings).toMatchObject({ archiveDisplayBehaviour: "show", bookmarkClickAction: "open_original_link" });
expect(whoami).toMatchObject({ id: userId, email: null, image: null, localUser: true });
expect(validate).toEqual({ success: true });
```

还要断言错误 key 返回 tRPC `UNAUTHORIZED`；`apiKeys.exchange` 必须返回 `FORBIDDEN` 和精确消息 `Password authentication is disabled`。`apiKeys.revoke` 必须接收 `{id:string}` 并返回无输出 envelope；错误 id、跨用户 id 和重复吊销都同样幂等成功且无输出，但数据库不发生额外变更。

Command：`rtk npm test -- test/client-bootstrap.test.ts`；Expected：失败，procedure 尚不存在。

- [ ] **Step 2: 实现匿名客户端配置**

`config.clientConfig` 从 `new URL(ctx.req.url).origin` 生成 URL，不信任 `Host` 拼字符串。返回完整但禁用的能力字段：

```ts
return {
  publicUrl: origin,
  publicApiUrl: origin,
  auth: {
    disableSignups: true,
    disablePasswordAuth: true,
    oauthAutoRedirect: false,
  },
  turnstile: null,
  inference: {
    isConfigured: true,
    inferredTagLang: "zh-CN",
    enableAutoTagging: true,
    enableAutoSummarization: false,
  },
  chat: { enabled: false },
  search: { semanticSearchEnabled: false },
  stripe: { isConfigured: false },
  legal: {},
  serverVersion: ctx.env.SERVER_VERSION,
  disableNewReleaseCheck: true,
};
```

`src/contracts/client-config.ts` 按已审核 spec 独立重写与锁定 `zClientConfigSchema` 等价的字段；本响应不返回可选 `demoMode`，其余字段必须与上面的对象逐字一致，不得增加别名。

- [ ] **Step 3: 实现用户与 API Key procedures**

`apiKeys.validate` 复用 `authenticateApiKey`，不创建 session。`users.settings` 返回以下完整个人用户设置；`users.whoami` 返回 `{id,name,email,image:null,localUser:true}`：

```ts
const defaultSettings = {
  bookmarkClickAction: "open_original_link",
  archiveDisplayBehaviour: "show",
  timezone: "Asia/Shanghai",
  backupsEnabled: false,
  backupsFrequency: "weekly",
  backupsRetentionDays: 7,
  readerFontSize: null,
  readerLineHeight: null,
  readerFontFamily: null,
  autoTaggingEnabled: true,
  autoSummarizationEnabled: false,
  tagStyle: "lowercase-spaces",
  curatedTagIds: null,
  inferredTagLang: "zh-CN",
} as const;
```

`apiKeys.exchange` 显式禁用：

```ts
exchange: publicProcedure.mutation(() => {
  throw new TRPCError({ code: "FORBIDDEN", message: "Password authentication is disabled" });
}),
```

`apiKeys.revoke` 是 `protectedProcedure.input(z.object({ id: z.string() }))`。输入的 `id` 是 `api_keys.id`，必须以当前认证用户双重限定并执行 `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`，不得按 `key_id` 吊销。procedure 与锁定上游保持幂等且无输出：正确当前用户 `id`、错误 `id`、其他用户的 `id` 和已吊销 `id` 均成功返回 `undefined`，不能以 `NOT_FOUND` 泄露记录是否存在；只有正确且未吊销的当前用户记录发生一次变更。测试真实 `apiKeys.revoke({ id })` 的无输出 envelope，断言错误、跨用户、重复吊销均不改变任何记录，并断言首次正确吊销后原 key 的下一次鉴权返回 `UNAUTHORIZED`。

- [ ] **Step 4: 合并 router、跑测试并提交**

```bash
rtk npm test -- test/client-bootstrap.test.ts test/trpc-auth.test.ts
rtk npm run typecheck
rtk git add src/trpc test/client-bootstrap.test.ts
rtk git commit -m "feat: add client bootstrap procedures"
```

## Task 6: 书签核心 procedures、分页与动态 Reader HTML

**Files:**

- Create: `src/bookmarks/contracts.ts`
- Create: `src/bookmarks/service.ts`
- Create: `src/bookmarks/reader-html.ts`
- Create: `src/queue/contracts.ts`
- Create: `src/trpc/routers/bookmarks.ts`
- Modify: `src/trpc/router.ts`
- Create: `test/queue-contract.test.ts`
- Create: `test/bookmarks-service.test.ts`
- Create: `test/bookmarks-trpc.test.ts`

- [ ] **Step 1: 先写服务层失败测试**

先在 `test/queue-contract.test.ts` 锁定公共 Queue schema：对象必须精确包含 `bookmarkId`、`jobId`、`urlSnapshot`、`requestedAt`，拒绝缺失或额外字段；校验通过后以 `TextEncoder` 计算 `JSON.stringify(payload)` 的 UTF-8 字节数并要求 `< 2048`，等于或超过 2048 必须失败。再覆盖创建 URL、canonical URL 去重、同用户重复保存不重复入队、不同用户可保存同 URL、分页稳定、归档过滤、阅读进度 upsert。关键断言：

```ts
expect(first.created).toBe(true);
expect(second.created).toBe(false);
expect(await queueMessageCount()).toBe(1);
expect(page1.bookmarks).toHaveLength(20);
expect(page2.bookmarks[0]?.id).not.toBe(page1.bookmarks.at(-1)?.id);
expect(await getReadingProgress(db, userId, bookmarkId)).toEqual({
  readingProgressOffset: 42,
  readingProgressAnchor: null,
  readingProgressPercent: 42,
});
```

Command：`rtk npm test -- test/queue-contract.test.ts test/bookmarks-service.test.ts`；Expected：失败。

- [ ] **Step 2: 实现单事务创建与提交后入队**

在 `src/queue/contracts.ts` 实现唯一公共 `QueueMessage` schema 和 `parseQueueMessage`：严格校验精确四字段，再检查序列化 UTF-8 字节数 `< 2048`，任一失败都不得调用 binding。创建时使用 `D1Database.batch()` 完成 bookmark、link、job 写入；依赖 `(user_id, canonical_url)` 唯一约束处理竞态。只有首次创建在数据库成功后先调用 `parseQueueMessage`，再把返回值发送：

```ts
const payload = parseQueueMessage({
  bookmarkId,
  jobId,
  urlSnapshot,
  requestedAt: new Date().toISOString(),
});
await env.ENRICHMENT_QUEUE.send(payload);
```

所有 Task 6 send 都必须先通过该 schema 和大小校验。后续生产者（Cron 补投和 Phase 0 探针）必须复用它；序列化后的消息只允许 `bookmarkId`、`jobId`、`urlSnapshot`、`requestedAt`，不得加入 `kind`、`probeId` 或重试计数。Queue send 失败时不得回滚已提交书签；将 job 保持 `pending`，返回书签，并写结构化 error log。不得把 Queue 作为事实来源。

- [ ] **Step 3: 写锁定 tRPC 输入/输出测试**

至少覆盖：

```ts
await caller.bookmarks.createBookmark({
  type: "link",
  url: "https://example.com/article?utm_source=x",
  title: "Example",
  source: "extension",
});

await caller.bookmarks.checkUrl({ url: "https://example.com/article" });
await caller.bookmarks.getBookmarks({
  archived: false,
  sortOrder: "desc",
  useCursorV2: true,
  includeContent: false,
  cursor: null,
});
await caller.bookmarks.getBookmark({ bookmarkId, includeContent: true });
await caller.bookmarks.updateReadingProgress({
  bookmarkId,
  readingProgressOffset: 42,
  readingProgressAnchor: null,
  readingProgressPercent: 42,
});
await caller.bookmarks.getReadingProgress({ bookmarkId });
```

断言 `checkUrl` 精确返回 `{ bookmarkId: string|null }`；列表返回 `bookmarks` 与 `nextCursor`；详情包含 `content`、`tags`、`assets`、`note`、`archived` 等已锁定 nullable 字段；阅读进度读取精确返回 `{readingProgressOffset:42,readingProgressAnchor:null,readingProgressPercent:42}`。不允许 `undefined` 泄漏到 wire。

Command：`rtk npm test -- test/bookmarks-trpc.test.ts`；Expected：失败。

- [ ] **Step 4: 实现 procedure schemas 与游标**

所有 input/output 都用 Zod 声明。V2 cursor 是 `{ createdAt: Date, id: string } | null`，SQL 使用 `(created_at < ?) OR (created_at = ? AND id < ?)`，取 `limit + 1` 判定下一页。SuperJSON 负责 Date，不手工转 epoch。

`createBookmark` 初始响应固定为上游 `zBookmarkSchema` 加 `alreadyExists`，其中关键字段为：

```ts
{
  content: {
    type: "link",
    url: normalizedUrl,
    title: input.title ?? normalizedUrl,
    description: null,
    htmlContent: null,
    crawlStatus: "pending",
  },
  taggingStatus: "pending",
  summarizationStatus: null,
  embeddingStatus: null,
  summary: null,
  tags: [],
  assets: [],
  archived: false,
  alreadyExists: false,
}
```

`content` 其余 image/asset/reader/author/publisher/date 字段全部显式为 null；根对象的 `title`、`note`、`source`、`favourited`、Date 字段和 `userId` 按锁定 schema 返回，不能省略必需字段。

- [ ] **Step 5: 实现安全的动态 Reader HTML**

`includeContent:true` 返回由当前书签字段动态生成的最小 HTML；标题、URL、摘要必须 HTML escape，链接属性必须 attribute escape：

```ts
export function renderReaderHtml(bookmark: ReaderBookmark): string {
  const title = escapeHtml(bookmark.title ?? bookmark.url);
  const href = escapeAttribute(bookmark.url);
  const summary = bookmark.summary ? `<p>${escapeHtml(bookmark.summary)}</p>` : "";
  return `<article><h1>${title}</h1>${summary}<p><a href="${href}" rel="noreferrer">打开原链接</a></p></article>`;
}
```

测试 `<script>`、引号和 `javascript:`。URL 在写入时仅接受 `http:`/`https:`，因此 Reader 不会输出危险协议。

- [ ] **Step 6: 用真实 HTTP batch link 验证协议并提交**

测试启动 Worker fetch handler，通过 `@trpc/client` 的 `httpBatchLink`、Bearer 和 SuperJSON 发出同一批 query/mutation，验证 batch success 与单项错误 envelope。

```bash
rtk npm test -- test/queue-contract.test.ts test/bookmarks-service.test.ts test/bookmarks-trpc.test.ts
rtk npm run typecheck
rtk git add src/bookmarks src/queue/contracts.ts src/trpc test/queue-contract.test.ts test/bookmarks-service.test.ts test/bookmarks-trpc.test.ts
rtk git commit -m "feat: add phase0 bookmark protocol"
```

## Task 7: 兼容空能力、健康接口、预览页与统一 JSON 错误

**Files:**

- Create: `src/trpc/routers/lists.ts`
- Create: `src/trpc/routers/highlights.ts`
- Create: `src/http/routes.ts`
- Create: `src/env.ts`
- Modify: `src/trpc/router.ts`
- Modify: `src/index.ts`
- Create: `test/http-compat.test.ts`

- [ ] **Step 1: 写兼容面失败测试**

覆盖锁定客户端可能调用但 Phase 0 不实现的读取 procedures：

```ts
expect(await caller.lists.list()).toEqual({ lists: [] });
expect(await caller.lists.getListsOfBookmark({ bookmarkId })).toEqual({ lists: [] });
expect(await caller.lists.stats()).toEqual({ stats: new Map() });
expect(await caller.highlights.getForBookmark({ bookmarkId })).toEqual({ highlights: [] });
expect(await caller.highlights.getAll({ cursor: null })).toEqual({ highlights: [], nextCursor: null });
```

只读空能力返回结构兼容结果；创建/修改 list、highlight、rule 或 asset 的 mutation 按规格返回 `BAD_REQUEST`，不能假装成功。`users.create`、`users.deleteAccount`、`users.changePassword` 才返回 `FORBIDDEN`。

HTTP 断言：

```ts
expect(await json("/api/health")).toEqual({ status: "ok", message: "Web app is working" });
expect(await json("/api/version")).toEqual({ version: "0.1.0" });
expect((await fetchWorker("/api/unknown")).status).toBe(404);
expect((await fetchWorker(`/dashboard/preview/${bookmarkId}`)).headers.get("content-type")).toContain("text/html");
```

再模拟无 Origin 的移动端请求和带 `chrome-extension://kgcjekpmcjjogibpjebkhaanilehneje` Origin 的扩展请求。无 Origin 必须正常；扩展 Origin 的 OPTIONS 必须解析 `Access-Control-Request-Headers`，对 `Authorization`、`Content-Type` 和符合 HTTP token 语法的客户端任意自定义头进行动态回显，实际响应允许该精确 Origin；不得使用 `*`。至少以 `X-KaraClone-Phase0` 证明预检响应包含该头，随后带该头的真实 tRPC 请求成功。非法 header name、随机网页 Origin不返回 CORS allow header。扩展 ID 必须来自 Google 官方 CRX3 已验证公钥的确定性推导，并与客户端锁中的独立 Store ID 相等；Worker 使用非秘密配置变量 `ALLOWED_EXTENSION_ORIGIN`，不能使用 secret 或允许任意 `chrome-extension://*`。

`src/env.ts` 通过 global interface merge 为生成的 `Env` 增加 `ALLOWED_EXTENSION_ORIGIN:string`；不得手工重写 `worker-configuration.d.ts`。

Command：`rtk npm test -- test/http-compat.test.ts`；Expected：失败。

- [ ] **Step 2: 实现兼容空 routers**

加入规格已分类的兼容 procedures：`lists.list`、`lists.stats`、`lists.getListsOfBookmark`、`highlights.getAll`、`highlights.getForBookmark`、`rules.list`、`assets.list`。`lists.stats` 返回 `new Map()` 交给 SuperJSON；不得改成普通对象。未知 procedure 继续由 tRPC 返回 `NOT_FOUND`，供抓包闸门发现。

- [ ] **Step 3: 实现 HTTP dispatcher**

`src/index.ts` 按顺序处理：CORS preflight、Phase 0 探针、`/api/trpc`、健康/版本、预览页、已知 `/api/assets/*`、最后 404。tRPC 使用当前 fetch adapter：

```ts
return fetchRequestHandler({
  endpoint: "/api/trpc",
  req,
  router: appRouter,
  createContext: () => createContext({ req, env, executionCtx: ctx }),
  onError({ path, error }) {
    console.error(JSON.stringify({ event: "trpc_error", path, code: error.code }));
  },
});
```

所有 `/api/*` 404 返回 `application/json`；预览页不存在返回普通 404 HTML，不重定向到未实现登录页。

- [ ] **Step 4: 回归验证并提交**

```bash
rtk npm test -- test/http-compat.test.ts test/bookmarks-trpc.test.ts test/client-bootstrap.test.ts
rtk npm run typecheck
rtk git add src/index.ts src/http src/trpc test/http-compat.test.ts
rtk git commit -m "feat: add client compatibility routes"
```

## Task 8: 无敏感数据的 wire shape 捕获与未知 procedure 闸门

**Files:**

- Create: `migrations/0002_protocol_capture.sql`
- Create: `src/phase0/capture.ts`
- Create: `src/trpc/capture-middleware.ts`
- Modify: `src/trpc/base.ts`
- Modify: `src/http/routes.ts`
- Create: `scripts/phase0/export-wire.mjs`
- Create: `scripts/phase0/freeze-capture.mjs`
- Create: `test/capture.test.ts`

- [ ] **Step 1: 先写脱敏与 shape 测试**

测试捕获结果只保留 procedure、类型、状态、字段名和数据类型；请求头证据只允许固定测试头是否出现的布尔值，禁止保存任意 header 名称集合或任何 header 值。扩展另只保存预检是否请求并允许固定测试头、Origin 是否匹配两个布尔。不得包含 Bearer、API key、URL query、正文、prompt 或返回值。另测试 `INSERT ... SELECT` 在 runId/client 不匹配或 stop 后 `enabled=0` 时写入 0 行；冻结脚本必须经历三次、5 秒间隔的 stop 前静默轮询，stop 后两次查询也必须间隔 5 秒，并对 runId/client 不匹配、计数变化和无静默窗口 fail-closed；export 必须拒绝缺失/失败/间隔不足的 freeze JSON，并拒绝 D1 session 的 enabled、runId/client 或带间隔计数复核不匹配。测试还须对任一 artifact URL/runId/client/hash 不一致、截图文件 hash 重算不符、锁定发行包或版本证据 hash 不符 fail-closed：

```ts
expect(shapeOf({ url: "https://x.test/a?token=secret", title: "Private" })).toEqual({
  url: "url",
  title: "string",
});
expect(JSON.stringify(event)).not.toContain("secret");
expect(JSON.stringify(event)).not.toContain("Private");
```

数组表示为 `{ type:"array", item:<shape> }`；Date 为 `date`；null 为 `null`；对象 key 排序，确保 diff 稳定。

Command：`rtk npm test -- test/capture.test.ts`；Expected：失败。

- [ ] **Step 2: 增加捕获会话与事件表**

`migrations/0002_protocol_capture.sql`：

```sql
CREATE TABLE phase0_capture_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('extension', 'mobile', 'contract')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  started_at TEXT NOT NULL
);

CREATE TABLE protocol_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  client TEXT NOT NULL,
  procedure TEXT NOT NULL,
  procedure_type TEXT NOT NULL,
  input_shape TEXT NOT NULL,
  output_shape TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX protocol_events_run_idx ON protocol_events(run_id, id);

CREATE TABLE protocol_http_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  client TEXT NOT NULL,
  method TEXT NOT NULL,
  is_batch INTEGER NOT NULL CHECK (is_batch IN (0, 1)),
  procedures TEXT NOT NULL,
  request_envelope_shape TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_envelope_shape TEXT NOT NULL,
  fixed_test_header_seen INTEGER NOT NULL CHECK (fixed_test_header_seen IN (0, 1)),
  cors_fixed_header_requested INTEGER CHECK (cors_fixed_header_requested IN (0, 1)),
  cors_fixed_header_allowed INTEGER CHECK (cors_fixed_header_allowed IN (0, 1)),
  cors_origin_matched INTEGER CHECK (cors_origin_matched IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX protocol_http_events_run_idx ON protocol_http_events(run_id, id);

CREATE TABLE protocol_route_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  client TEXT NOT NULL,
  method TEXT NOT NULL,
  route_template TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  request_shape TEXT NOT NULL,
  response_shape TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX protocol_route_events_run_idx ON protocol_route_events(run_id, id);
```

不得存 raw body、headers、cookies、authorization、URL 值、任意 header 名称集合或任何 header 值。`fixed_test_header_seen` 仅判断常量 `X-KaraClone-Phase0`；三个 CORS 布尔仅对 extension 事件有值，mobile 必须为 null。

- [ ] **Step 3: 实现受认证保护的捕获控制接口**

`POST /__phase0/capture/start` 接收 `{runId, client}`，要求合法 Bearer，清空旧事件后 upsert singleton；`POST /__phase0/capture/stop` 将 `enabled=0`；`GET /__phase0/capture/status` 返回计数和 unknown procedure 数，不返回输入值。

`runId` 只允许 `[A-Za-z0-9_-]{1,64}`；client 只允许枚举。接口在 `PHASE0_CAPTURE !== "true"` 时返回 404。

- [ ] **Step 4: 在 tRPC middleware 捕获已知 procedure，在 onError 捕获未知 procedure**

middleware 在 procedure 完成后调用 `ctx.executionCtx.waitUntil(recordProtocolEvent(...))`。错误只记录 tRPC error code。fetch adapter `onError` 对 `NOT_FOUND` 同样记录 procedure path；若当前无 enabled session，不写 D1。

每次写 `protocol_events` 或 `protocol_http_events` 必须使用单条 `INSERT ... SELECT`，其 `SELECT` 从 `phase0_capture_session` 条件读取，并同时限定调用开始时捕获的 `run_id = ?`、`client = ?`、当前 `enabled = 1`；不得先读 session 再无条件 INSERT。这样 stop 之后才完成的在途 `waitUntil` 不会污染已冻结 run。

在 capture 模式下，tRPC HTTP dispatcher 还要 clone request/response，解析 GET query 或 POST body，只将 `shapeOf()` 结果、procedure 名、是否 batch、HTTP status 写入 `protocol_http_events`。它只以常量查找 `X-KaraClone-Phase0` 并写 `fixed_test_header_seen`，绝不枚举或保存 header 名称/值。扩展 OPTIONS 事件另计算 `cors_fixed_header_requested`、`cors_fixed_header_allowed`、`cors_origin_matched`；移动端不要求 CORS。解析失败必须记录 `unparseable` shape 并使导出 gate 失败；不得把 raw query/body 写入日志或 D1。这样真实客户端证据同时覆盖 procedure、input/output/error 和 tRPC/SuperJSON batch envelope。

最外层 fetch router 还必须覆盖客户端流程命中的全部 Worker 请求（tRPC、`/api/health`、`/api/version`、`/dashboard/preview/:id` 及实际发现的其他路由），以同一 `INSERT ... SELECT` 规则写 `protocol_route_events`，仅保存 method、白名单 route template、status、request/response shape。动态路径 ID 必须先映射为 `:id`；禁止原始 pathname、query、body、headers 或值。capture start/stop/status 等 `/__phase0/capture/*` 控制端点必须排除，避免自污染。无法映射的路由记录为 unknown，解析失败记录 unparseable，两者均使 gate 失败。

为了避免测 CPU 时增加额外 D1 读写，`PHASE0_CAPTURE=false` 必须在函数第一行短路，且生产式常用请求不查询 capture session。

- [ ] **Step 5: 实现确定性导出脚本**

`scripts/phase0/freeze-capture.mjs` 接收 `--client`、`--run-id`、`--deploy artifacts/phase0/deploy-clients.json` 与 `--out`，并只从 passed clients deploy artifact 读取 Worker URL/deploymentId/versionIds。操作员确认客户端无在途请求后，脚本在 stop 前每隔 5 秒轮询目标 run 的 procedure/HTTP/route count，连续三次相同（覆盖至少 10 秒）才构成静默窗口；否则等待或超时失败。随后调用 capture/stop，固定等待 5 秒查询第一次 status，再等待 5 秒查询第二次 status；两次都必须精确匹配目标 runId/client、`enabled=false` 且各项 count 相同。原子输出顶层记录 runId、client、Worker URL、deploymentId、稳定排序 versionIds、三类计数、时间戳、`canonicalSha256` 和 `passed`。

`scripts/phase0/export-wire.mjs` 接收 `--client extension|mobile --run-id <id> --freeze <path> --deploy <path> --out <path>`；它不负责 stop，先校验 freeze JSON 的 runId/client/Worker URL、静默窗口间隔、stop 后查询间隔、计数和 `passed:true`，重算 freeze canonical SHA-256，并要求 freeze/deploy 的 Worker URL 一致；再独立查询 capture singleton，确认 `enabled=0` 且 runId/client 与参数精确一致，固定等待 5 秒后再次查询并确认各项 count 不变。若任一 URL、哈希、freeze/session/deploy 不匹配、仍开启或计数变化则非零退出。随后查询事件并输出：

```json
{
  "client": "extension",
  "runId": "extension-20260902",
  "workerUrl": "https://<worker-host>",
  "deploymentId": "<production-deployment-id>",
  "versionIds": ["<production-version-id>"],
  "profile": "clients",
  "sourceDeploySha256": "<sha256>",
  "freezeSha256": "<sha256>",
  "events": [],
  "httpEnvelopes": [],
  "routeEvents": [],
  "unknownProcedures": [],
  "captureQuietWindowPassed": true,
  "captureStopped": true,
  "captureCountsStable": true,
  "fixedTestHeaderSeen": true,
  "corsFixedHeaderRequested": true,
  "corsFixedHeaderAllowed": true,
  "corsOriginMatched": true,
  "passed": false
}
```

mobile 的三个 CORS 字段必须为 null。只有 procedure、HTTP envelope、routeEvents 均非空并覆盖该客户端实际流程，固定测试头确实出现（扩展还须三个 CORS 布尔全 true）、顶层 deploymentId/versionIds/Worker URL/runId/client 与 freeze/deploy 逐项一致、交叉哈希匹配、静默窗口/stop/带间隔复核均通过、无 unknown route/`unparseable` 且 `unknownProcedures.length===0` 才能 `passed:true`。

- [ ] **Step 6: 验证脱敏、迁移并提交**

```bash
rtk npm test -- test/capture.test.ts
rtk npm run typecheck
rtk git add migrations/0002_protocol_capture.sql src/phase0 src/trpc src/http scripts/phase0/export-wire.mjs scripts/phase0/freeze-capture.mjs test/capture.test.ts
rtk git commit -m "test: add protocol shape capture gate"
```

## Task 9: 真实 Queue 重试、延迟、状态迁移与 DLQ

**Files:**

- Modify: `src/queue/contracts.ts`（复用 Task 6 公共 schema；仅补 consumer 所需导出，不重定义消息）
- Create: `src/queue/consumer.ts`
- Create: `src/queue/dlq.ts`
- Create: `src/queue/cron.ts`
- Create: `src/phase0/queue-probe.ts`
- Modify: `src/index.ts`
- Create: `migrations/0003_queue_probe.sql`
- Create: `test/queue-consumer.test.ts`

- [ ] **Step 1: 写 attempts 1–4 的本地行为测试**

复用 Task 6 已创建并测试的唯一消息 schema；创建、探针和 Cron 都不得重定义或使用其他 payload：

```ts
import { parseQueueMessage, type QueueMessage } from "./contracts";

const message: QueueMessage = parseQueueMessage(rawMessage);
```

使用 `cloudflare:test` 的 `createMessageBatch`、`createExecutionContext`、`getQueueResult`。分别构造 attempts 1–4，断言：

```ts
expect(result.retryMessages[0]?.options?.delaySeconds).toBe(30);
expect(delays).toEqual([30, 300, 1800]);
expect(attempt4.ackAll).toBe(false);
expect(job.status).toBe("dead");
expect(bookmark.tagging_status).toBe("failure");
```

Command：`rtk npm test -- test/queue-consumer.test.ts`；Expected：失败。

- [ ] **Step 2: 实现幂等、带租约条件的 Queue consumer**

每次处理先用条件更新拿执行权：

```sql
UPDATE enrichment_jobs
SET status = 'running', attempt = ?, last_message_id = ?,
    lease_expires_at = ?, updated_at = ?
WHERE id = ? AND (
  status IN ('pending', 'retry_wait')
  OR (status = 'running' AND (
    (last_message_id = ? AND attempt < ?)
    OR lease_expires_at <= ?
  ))
);
```

租约固定为当前时间加 20 分钟。若条件更新 `meta.changes===0`，重新读取：job 已 `success`、`failure`、`dead`、`cancelled` 或仍持有有效租约时直接 `message.ack()`。

consumer 通过 `jobId` 查询 D1 job 的 `probe_mode` 判定是否为 Phase 0 固定失败探针，不能从消息 payload 判定。普通 job 在 Phase 0 仅记录一次成功消费证据并把 job 置 `success`、清空 lease，不伪造标签。探针 attempts 1–3 使用 `[30,300,1800][attempts-1]`，在一个 D1 batch 内写 `status='retry_wait'`、`attempt=message.attempts`、`next_retry_at`、清空 lease、写 `queue_probe_events`，然后：

```ts
message.retry({ delaySeconds });
```

attempt 4 在一个 D1 batch 内写 job=`dead`、`attempt=4`、清空 lease、bookmark.tagging_status=`failure`、事件=`consumer_failed`；随后抛出错误，让平台把消息送入 DLQ，不能 `ack()` 或再次 `retry()`。

- [ ] **Step 3: 实现 DLQ consumer 与探针接口**

同一个 Worker 的 `queue()` 根据 `batch.queue` 分发主队列或 DLQ。DLQ consumer 写入 `queue_probe_events(kind='dlq_received')` 后 ack。

`POST /__phase0/queue/start` 创建专用 bookmark/job，在 job 行设置 `probe_mode=1`，并 enqueue 同一四字段消息；响应只返回 `jobId`。`GET /__phase0/queue/:jobId` 通过 jobId 查询 job 和事件，返回每次平台时间戳、attempts、请求 delay、相邻事件实际秒差、最终状态和 DLQ 到达状态。两者均要求 API Key，且仅在 `PHASE0_CAPTURE=true` 暴露。

同一个 Worker 还必须导出 `scheduled()`。每次生成唯一 `invocationId`，使用 `ORDER BY created_at ASC, id ASC LIMIT 10` 只选择创建超过 5 分钟、`status='pending'` 的最多 10 个 job，关联 bookmark 取得当前 URL，并逐条调用真实 `env.ENRICHMENT_QUEUE.send(payload, options?)`。payload 必须先通过 Task 6 公共 schema 与大小校验，序列化后小于 2 KB，且精确只有四字段。每次调用都写 invocation 审计：先记录本次 `selectedCount` 和每个被选 job，再逐项记录 `sent`/`failed` 及该次 send 的 `delaySeconds`（无 option 时为 null），最后汇总 `sentCount`、`failedCount`；任一完成审计必须满足 `selectedCount = sentCount + failedCount`。成功发送后以条件更新记录 `enqueued_at`；发送失败保持 `pending`。查询和更新必须避免同一轮重复补投，不处理 `retry_wait`、`running` 或终态 job。

仅当 `PHASE0_CAPTURE === "true"` 且 D1 job 带一次性 `fail_next_cron_send=1` 时，该 job 第一次被 scheduled 选中必须调用真实 Queue binding：

```ts
await env.ENRICHMENT_QUEUE.send(payload, { delaySeconds: 86401 });
```

`86401` 是确定超出 QueueSendOptions `delaySeconds` 合法范围 `0..86400` 的一次性非法 option；它只能作为 `send` 的第二参数，绝不能进入 payload。必须让平台真实拒绝并进入 `catch`；catch 中以条件更新清除 `fail_next_cron_send`、保持 job `pending`、不写 `enqueued_at`，并在同一 invocation 的 job 审计中记录 `failed` 和稳定错误分类。若非法 send 意外成功，探针立即 fail-closed。下一次真实 Cron 读取到标记已清除，必须用 `env.ENRICHMENT_QUEUE.send(payload)`，不得再携带任何非法或探针 option，并最终消费成功。`PHASE0_CAPTURE !== "true"` 时即使数据库异常残留标记也禁止传非法 option。

为 scheduled handler 补本地测试：少于 5 分钟不投、12 条乱序插入且含相同 `created_at` 的候选严格按 `created_at ASC, id ASC` 选择前 10 条、同一 invocation 的计数恒等式、每个 job 发送结果、复用 Task 6 公共 schema、payload 精确四字段且小于 2 KB、标记 job 第一次调用真实注入 binding 的 `send(payload,{delaySeconds:86401})` 并在拒绝后保持 pending/清除标记、下一次调用无 option 且成功、非 capture 模式不使用非法 option、普通发送失败仍 pending、非 pending 不投。

- [ ] **Step 4: 加入 Queue 事件迁移**

Create: `migrations/0003_queue_probe.sql`

```sql
CREATE TABLE queue_probe_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempt INTEGER,
  requested_delay_seconds INTEGER,
  occurred_at TEXT NOT NULL
);
CREATE INDEX queue_probe_events_job_idx ON queue_probe_events(job_id, id);

CREATE TABLE cron_invocations (
  invocation_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  selected_count INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);

CREATE TABLE cron_invocation_jobs (
  invocation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  send_result TEXT NOT NULL CHECK (send_result IN ('selected', 'sent', 'failed')),
  send_delay_seconds INTEGER,
  error_code TEXT,
  PRIMARY KEY (invocation_id, job_id),
  FOREIGN KEY (invocation_id) REFERENCES cron_invocations(invocation_id)
);
CREATE INDEX cron_invocation_jobs_invocation_idx ON cron_invocation_jobs(invocation_id, job_id);
```

同一迁移为 `enrichment_jobs` 增加 `probe_mode INTEGER NOT NULL DEFAULT 0`、`fail_next_cron_send INTEGER NOT NULL DEFAULT 0` 和 nullable `enqueued_at TEXT`；探针关联只能使用 `job_id`，不得创建或保留 `probe_id`。Cron 审计不得存 payload、URL、异常原文或 secret。

- [ ] **Step 5: 本地验证并提交**

```bash
rtk npm test -- test/queue-consumer.test.ts
rtk npm run typecheck
rtk git add src/queue src/phase0/queue-probe.ts src/index.ts migrations/0003_queue_probe.sql test/queue-consumer.test.ts
rtk git commit -m "test: add queue retry and dlq probe"
```

## Task 10: 默认 Workers AI 模型的 JSON Mode 运行时闸门

**Files:**

- Create: `src/ai/tag-schema.ts`
- Create: `src/ai/cloudflare-ai.ts`
- Create: `src/ai/tagger.ts`
- Create: `src/phase0/ai-probe.ts`
- Modify: `src/http/routes.ts`
- Create: `test/ai-tagger.test.ts`

- [ ] **Step 1: 先写响应解析与二次验证测试**

Schema 固定：

```ts
export const tagResultSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  description: z.string().max(300).nullable(),
});
```

测试 Workers AI 返回 object、JSON string、markdown fence、缺失 tags、超长 tag、非法字符和 normalized 重复 tag。只接受 object 或纯 JSON string；markdown fence 必须失败，防止宽松解析掩盖 JSON Mode 失效。normalize 时移除 `#` 前缀和首尾空白，仅允许文字、数字、空格、`-`、`_`，按小写并移除空格/`-`/`_` 后的名称去重。

Command：`rtk npm test -- test/ai-tagger.test.ts`；Expected：失败。

- [ ] **Step 2: 实现严格模型锁定与 JSON schema**

```ts
if (env.AI_MODEL !== "@cf/meta/llama-3.1-8b-instruct-fast") {
  throw new Error(`Unexpected AI model: ${env.AI_MODEL}`);
}

const raw = await runLockedTextModel(env.AI, {
  messages: [
    { role: "system", content: "Return 1-8 concise Chinese bookmark tags and a description or null." },
    { role: "user", content: `${title}\n${description}` },
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: {
        tags: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
        description: { type: ["string", "null"], maxLength: 300 },
      },
      required: ["tags", "description"],
      additionalProperties: false,
    },
  },
});
```

由于当前 `@cloudflare/workers-types` 的 `AiModels` 联合可能滞后于官方活跃模型目录，`cloudflare-ai.ts` 只做一个显式 `unknown` 双重转换到最小结构接口：`run(model: LockedModel,input:TagModelInput):Promise<unknown>`；实现内部始终传固定字面量模型。不得使用 `any`，不得放宽为任意模型字符串。远端探针是最终真实性闸门。

解析后必须经 Zod；trim、按大小写不敏感去重并再次校验。不允许回退到其他模型或把非 JSON 文本切词冒充成功。

- [ ] **Step 3: 暴露一次性 AI 探针**

`POST /__phase0/ai-json` 使用固定公开文本，不发送用户数据；返回 model、validated、tags、错误类型和 `passed`。要求 API Key 且 `PHASE0_CAPTURE=true`。远端成功才算 G6，本地 mock 只验证代码路径。

- [ ] **Step 4: 本地测试并提交**

```bash
rtk npm test -- test/ai-tagger.test.ts
rtk npm run typecheck
rtk git add src/ai src/phase0/ai-probe.ts src/http/routes.ts test/ai-tagger.test.ts
rtk git commit -m "test: add workers ai json mode gate"
```

## Task 11: 远端 bootstrap、部署与基础 smoke

**Files:**

- Create: `scripts/phase0/bootstrap-admin.mjs`
- Create: `scripts/phase0/deploy.mjs`
- Create: `scripts/phase0/smoke.mjs`
- Create: `artifacts/phase0/.gitkeep`
- Create: `artifacts/phase0/deploy-probes.json`
- Create: `artifacts/phase0/bootstrap.json`
- Create: `artifacts/phase0/smoke.json`

- [ ] **Step 1: 实现一次性管理员和 API key bootstrap**

脚本生成 `userId`、`keyId` 和 32-byte secret，key 格式为 `ak2_<keyId>_<secret>`；只把 SHA-256 hex 写入远端 D1。`userId`、`keyId`、hash、时间和固定文本均由脚本自身生成并逐项通过严格字符白名单后，交给 `wrangler d1 execute --remote --command`；完整 secret 不能出现在 command、SQL、artifact 或 git 中。

脚本接受 `--deploy artifacts/phase0/deploy-probes.json --write-dev-vars .dev.vars --out artifacts/phase0/bootstrap.json`。`bootstrap.json` 顶层唯一结构为 `{deploymentId,versionIds:[sorted],profile:"probes",workerUrl,sourceDeploySha256,...artifactSpecific}`，artifactSpecific 仅含非敏感 user/key ID、`.dev.vars` 权限检查、时间戳、`canonicalSha256` 与 `passed`；不得记录 key/hash/token。

若远端已存在管理员，脚本明确失败，不覆盖或复用未知 key。

- [ ] **Step 2: 实现确定性部署脚本**

顺序固定：

```text
rtk npx wrangler d1 migrations apply karaclone-phase0 --remote
rtk npx wrangler deploy --strict --message phase0-go-no-go
GET /api/health
GET /api/version
```

每次真实 deploy 后必须立即执行 `wrangler deployments status --json`，只接受其中 production deployment/version，并与刚部署 Worker 的 `/api/version` 交叉。`deploy.mjs --profile probes|cpu|clients|cleanup --out ...` 原子输出对应 `deploy-probes.json`、`deploy-cpu.json`、`deploy-clients.json`、`deploy-cleanup.json`：固定含 profile、captureEnabled、Worker URL、production `deploymentId`、稳定排序 `versionIds`、实际部署账户的 `accountIdSha256`、git commit、Wrangler 配置 canonical SHA-256、source/bundle manifest canonical SHA-256（manifest 为每个输入/输出文件的相对路径、字节数、SHA-256，稳定排序）、D1/Queue 名称、migration/deploy/status/health/version 各项布尔、时间、`canonicalSha256` 和 `passed`，不含明文 Account ID/token/key。四份 deploy 的 account hash 必须相等；probes 的 `accountIdSha256` 必须与 preflight 的 `whoamiAccountIdSha256`、`billingRequestAccountIdSha256` 相等。status 无 production、ID/version/account hash/commit/hash 任一不匹配均失败。probes、cpu、clients、cleanup 的配置/source manifest 都必须证明不存在 `limits.cpu_ms`；发现该字段立即拒绝部署或写 `passed:false`。probes 要求 capture=true；cpu 要求 capture=false 且 probe=true；cleanup 要求 capture=false、probe=false 且 CPU 探针临时 binding 已删除；clients 要求 capture=true，并把非秘密配置变量 `ALLOWED_EXTENSION_ORIGIN="chrome-extension://kgcjekpmcjjogibpjebkhaanilehneje"` 写入部署配置。clients artifact 额外保存该字符串 UTF-8 SHA-256 的 `allowedExtensionOriginSha256`。部署后必须读取当前 production version settings，确认变量值的 hash 与 artifact/config/client lock 一致；缺失、作为 secret 写入、明文落 artifact 或不一致均失败。

`deploy-probes.json` 还必须直接保存主 Queue 与 DLQ 的官方控制面/资源详情脱敏投影：各自固定资源名、`retentionHours:24`、查询来源/时间、投影 canonical SHA-256，并保存证明创建请求未携带任何 retention 参数的可重算命令投影。Free retention 不可配置；任一详情缺失、hash 不可重算、值不是 24 小时或创建请求含 retention 参数，`deploy-probes.json.passed` 必须为 false。Task 15 只从该直接内容重算，不信任单独布尔。

唯一部署来源结构定义为 `DeploymentProvenance={deploymentId:string,versionIds:string[]（稳定排序）,profile:"probes"|"cpu"|"clients"|"cleanup",workerUrl:string,sourceDeploySha256:string}`。`sourceDeploySha256` 精确等于对应 deploy artifact 内 canonical source/bundle manifest 的 SHA-256。所有部署后 artifact 顶层必须直接展开这五个字段，不得靠 URL、间接 hash 或 decision join 补齐：probes 对应 bootstrap/smoke/remote-contract/ai/queue，cpu 对应 cpu-invocation-run/queue-invocations/cpu/free-limit，cleanup 由 deploy-cleanup 直接给出并由 free-limit 引用其 canonical hash，clients 对应两端 freeze/wire/manual 及各自截图清单。每个 runner 的 schema 与 fixture 均要求五字段；decision 逐 artifact 与对应 deploy artifact 严格相等，任一缺失、versionIds 未稳定排序或跨 profile 即 `NO-GO`。

`extension-screenshots.json` 与 `mobile-screenshots.json` 顶层分别展开 clients DeploymentProvenance，并含稳定排序的 `{file,sha256,manualReviewPassed,reviewer,reviewedAt}`；decision 从仓库 PNG 重算每个 hash。`mobile-screenshots.json` 只列四张用户流程截图，不得列 `mobile-version.png`，后者只能由 `mobile-version-evidence.json` 绑定。截图清单不是 manual 内数组的替代引用，不能缺少五个直接来源字段。

bootstrap、smoke、run-remote-gates、各远端子 probe、measure-cpu、freeze-capture、export-wire 每个 runner 启动时都必须独立执行 `wrangler deployments status --json`，确认当前 production versionIds 与其目标 deploy artifact 完全一致；运行结束写 artifact 前再检查一次，期间发生漂移即失败。

- [ ] **Step 3: 实现远端 smoke**

`scripts/phase0/smoke.mjs` 从权限为 `0600` 的 `.dev.vars` 安全加载 `PHASE0_API_KEY`。`smoke.json` 顶层唯一结构为 `{deploymentId,versionIds:[sorted],profile:"probes",workerUrl,sourceDeploySha256,...artifactSpecific}`，artifactSpecific 为各检查布尔、`canonicalSha256` 和 `passed`；五个 provenance 字段须与 deploy-probes 严格相等。

- [ ] **Step 4: 执行部署前本地总检**

```bash
rtk npm test
rtk npm run typecheck
rtk npx wrangler deploy --dry-run
```

Expected：单测全绿；dry-run 显示 D1、AI、Queue bindings 和 `0 * * * *` Cron Trigger，无 KV/R2/Browser/Container binding，且配置与生成结果均不含 `limits.cpu_ms`。

- [ ] **Step 5: 按依赖顺序实际部署、bootstrap、smoke 并提交证据**

表在 remote migration 前不存在，因此顺序不得调整，也不得只编写脚本而不执行：

```bash
rtk node scripts/phase0/deploy.mjs --profile probes --out artifacts/phase0/deploy-probes.json
rtk node scripts/phase0/bootstrap-admin.mjs --deploy artifacts/phase0/deploy-probes.json --write-dev-vars .dev.vars --out artifacts/phase0/bootstrap.json
rtk node scripts/phase0/smoke.mjs --deploy artifacts/phase0/deploy-probes.json --bootstrap artifacts/phase0/bootstrap.json --env-file .dev.vars --out artifacts/phase0/smoke.json
rtk git add scripts/phase0 artifacts/phase0/.gitkeep artifacts/phase0/deploy-probes.json artifacts/phase0/bootstrap.json artifacts/phase0/smoke.json
rtk git commit -m "chore: deploy and record phase0 bootstrap smoke"
```

三个 artifact 必须均有 `passed:true`，且 Worker URL/deploymentId 精确一致；任一缺失、失败或身份不一致立即停止并转 Task 15 生成 `NO-GO`。这里保持 migration→deploy→health/version→bootstrap→smoke 的实际顺序；cpu/clients 后续部署不得重跑 bootstrap。

## Task 12: 远端 D1/tRPC/AI/Queue/CPU 自动化证据

**Files:**

- Create: `scripts/phase0/remote-contract.mjs`
- Create: `scripts/phase0/run-ai-probe.mjs`
- Create: `scripts/phase0/run-queue-probe.mjs`
- Create: `scripts/phase0/measure-cpu.mjs`
- Create: `scripts/phase0/run-free-limit.mjs`
- Create: `scripts/phase0/run-remote-gates.mjs`
- Create: `scripts/phase0/verify-remote-artifacts.mjs`
- Create: `test/phase0-scripts.test.ts`
- Create: `artifacts/phase0/remote-contract.json`
- Create: `artifacts/phase0/ai.json`
- Create: `artifacts/phase0/queue.json`
- Create: `artifacts/phase0/queue-invocations.json`
- Create: `artifacts/phase0/cpu-invocation-run.json`
- Create: `artifacts/phase0/cpu.json`
- Create: `artifacts/phase0/free-limit.json`
- Create: `artifacts/phase0/deploy-cpu.json`
- Create: `artifacts/phase0/deploy-cleanup.json`
- Read: `artifacts/phase0/deploy-probes.json`
- Read: `artifacts/phase0/bootstrap.json`
- Read: `artifacts/phase0/smoke.json`

- [ ] **Step 1: 先测试 artifact 写入的失败安全行为**

把 HTTP、Wrangler、Telemetry Query 与包验证器调用作为注入函数测试；覆盖 preflight 的 Billing API 非 2xx、两个账户 hash 不一致、Subscription 字段/类型/分页错误、四种活跃 state、contract/externally managed 风险、token/原始响应泄漏，以及 deploy/bootstrap/smoke artifact 缺失、`passed:false`、deployment/version/account/Worker URL 不一致、`.dev.vars` 权限不为 0600 或无法安全加载 API key，以及网络超时、1102、部分 tRPC batch 失败、AI 非 JSON、Queue 未到 DLQ、Telemetry 分页或数据错误、Cron 审计缺失、同一 invocation 计数不恒等、`selectedCount>10`、非法 delay 未拒绝、失败 job 未保持 pending、一次性标记未清除、第二周期 `sendDelaySeconds` 非 null、第二周期未消费。CPU/cleanup fixtures 还必须覆盖 `deploy-cpu.json` 缺失或非当前 production、预存 handoff、复用旧 secret/path/session nonce、secret/path/nonce 明文进入 argv/stdout/stderr/JSON/Git、Wrangler secret stdin 注入失败、运行时 binding 名缺失、`run-free-limit` 未使用本次 hash、finally 未调用 cleanup、`deploy-cleanup.json` 缺失、cleanup version 未覆盖 cpu version、probe 未关闭、临时 secret/path binding 未删除或轮换、status/health/version 不匹配；每项均须非零并保留 `NO-GO`，即使探针本身失败也必须断言 cleanup 仍被调用。客户端 fixture 还必须覆盖验证器复验不一致、header 名称集合/值被拒绝、固定测试头与 CORS 布尔缺失、manual/wire/freeze/deploy 顶层 deploymentId/versionIds/URL/runId/client/hash 不一致及本地截图 hash 重算失败。每种情况都必须写 `passed:false`，然后以非零码退出；绝不能保留上一次成功 artifact。

```ts
expect(await runContract({ fetch: returns1102 })).toMatchObject({ passed: false });
expect(await runCpu({ graphql: returnsNoRows })).toMatchObject({ passed: false, reason: "no_cpu_data" });
expect(await runQueue({ poll: neverReachesDlq })).toMatchObject({ passed: false });
expect(await runQueue({ cronAudit: { selectedCount: 11 } })).toMatchObject({ passed: false });
expect(await runQueue({ secondCron: { sendDelaySeconds: 86401 } })).toMatchObject({ passed: false });
```

Command：`rtk npm test -- test/phase0-scripts.test.ts`；Expected：失败。

- [ ] **Step 2: 实现远端 contract gate**

`remote-contract.mjs` 使用真实 `@trpc/client` `httpBatchLink` + SuperJSON，且只接受 probes deploy artifact；按顺序验证：

1. 创建带 Date 的书签，返回 Date 实例。
2. `checkUrl` 命中同一 ID。
3. canonical 等价 URL 再创建，不新增 bookmark/job。
4. 同一 HTTP batch 中执行 `users.whoami`、`users.settings`、`bookmarks.getBookmarks`。
5. `includeContent:true` 返回动态且已转义的 Reader HTML。
6. 更新并读取 reading progress。
7. 用远端 D1 查询校验行数和无明文 key。

输出 `remote-contract.json`：顶层展开 probes 的完整 DeploymentProvenance，并记录每项布尔、请求次数、1102 次数、D1 rows read/write（可测时）、`canonicalSha256`、`passed`。bootstrap、smoke、AI 与 Queue artifact 同样必须顶层展开并校验该五字段；禁止跨 deployment 拼接。

- [ ] **Step 3: 执行真实 Workers AI gate**

`run-ai-probe.mjs` 调用一次 `POST /__phase0/ai-json`，要求 HTTP 200、model 精确等于锁定模型、`validated===true`、1–8 个非空 tags，description 为字符串或 null。写 `artifacts/phase0/ai.json`。额度不足、模型不可用、付费要求、非 JSON 或 schema 错误全部为 `passed:false`，不得换模型重试。

- [ ] **Step 4: 并行执行真实 Queue retry/DLQ 与 Cron 子探针**

此时 probes deployment 必须仍是 production。先执行 `wrangler deployments status --json`，确认当前 production versionIds 与 deploy-probes artifact 精确一致，再运行 `rtk node scripts/phase0/run-remote-gates.mjs`；该 runner 启动时再次做同一检查，然后依次生成 contract/AI，并并行执行 Queue 子探针。`remote-contract.json`、`ai.json`、`queue.json` 全部原子写成 `passed:true` 前，严禁部署 cpu profile；deploy-cpu 绑定的 Telemetry 查询在 Step 5 执行。

`run-queue-probe.mjs` 同时启动两个独立子探针并并行轮询，每个子探针拥有自己的开始时间、`AbortController` 和 deadline；脚本整体另有从启动计时的 135 分钟硬 deadline（包含建数、轮询、最终查询与 artifact 原子写入）。retry/DLQ 子探针 deadline 为 45 分钟，Cron 子探针 deadline 为 130 分钟；任一子探针失败或超时必须取消另一子探针、写 `passed:false` 并非零退出。不能串行等待、缩短平台 delay 或用本地模拟作为远端证据。retry/DLQ 子探针每 20 秒轮询，通过条件：

```ts
attempts.map((x) => x.attempt).join(",") === "1,2,3,4"
requestedDelays.join(",") === "30,300,1800"
actualGaps[0] >= 30 && actualGaps[1] >= 300 && actualGaps[2] >= 1800
finalJobStatus === "dead"
finalTaggingStatus === "failure"
dlqReceived === true
```

实际 gap 没有上限闸门，因为免费层调度可能延后；但必须记录每个 gap、总耗时和 DLQ 到达时间到 `artifacts/phase0/queue.json`。期间每 60 秒输出一行简短进度，避免无反馈长等。

并行的 Cron 子探针创建至少 12 条 `created_at` 超过 5 分钟、`status='pending'` 且未直接 enqueue 的专用 Cron job，其中 `fail_next_cron_send=1` 的 job 必须具有 12 条中最早的 `created_at`；若时间并列，其 `id` 必须按字典序最小。脚本写入后必须查询 `ORDER BY created_at ASC, id ASC LIMIT 10` 并断言该失败 job 位于首个选择集，不能依赖未定义顺序。全部使用可序列化为小于 2 KB 四字段 payload 的公开固定 URL。该子探针等待两个连续的真实已部署 `0 * * * *` Cron 周期，独立 deadline 为 130 分钟，不能手工调用 `scheduled()` 冒充远端证据；它与 45 分钟 retry/DLQ 子探针从建数完成后并行计时，二者及收尾共同受 135 分钟整体 deadline 限制。

第一个周期必须从同一个 `invocationId` 的 `cron_invocations` 与 `cron_invocation_jobs` 直接证明：`selectedCount<=10`、逐 job 结果齐全、`selectedCount===sentCount+failedCount`；不得从 Queue 消费事件反推上限。带标记 job 必须证明真实 binding 的 `send(payload,{delaySeconds:86401})` 被平台拒绝，审计为 failed 且 `send_delay_seconds=86401`，job 仍 pending，标记已清除。第二个周期必须从新的 invocation 审计证明该 job 被再次选择、`send_delay_seconds IS NULL`、send 审计为 sent，并由 Queue 消费事件证明最终 success。其余候选还要证明跨 invocation 不丢失，且每次各自 `selectedCount<=10`。

`artifacts/phase0/queue.json` 必须保存两个 invocation 的非敏感审计摘要（invocationId、scheduledAt、selectedCount、sentCount、failedCount、逐 job 的 sendResult 与 sendDelaySeconds）、`payloadExactKeys:true`、`payloadBytesLt2048:true`、`invalidDelayRejected:true`、`failedJobStayedPending:true`、`oneShotFlagCleared:true`、`nextCronSentWithoutOptions:true`、`nextCronConsumed:true`、`retryDlqPassed:true`、`cronAuditPassed:true`、`cronFailureRecoveryPassed:true` 和 `passed`。任何 Cron 未触发、审计恒等式失败、单次 selectedCount 超过 10、非法 send 未拒绝、失败后状态改变、下一周期仍携带 option、未最终消费、出现额外 payload 字段或超时都必须写 `passed:false` 并非零退出。

`queue-invocations.json` 只能来自官方 `POST /accounts/{account_id}/workers/observability/telemetry/query`。token 仅通过环境变量提供，权限必须为 `Workers Observability Write`，不得落盘；权限不足或响应拒绝即失败。请求 body 固定为 `{queryId,timeframe:{from,to},view:"events",limit,offset?,offsetDirection:"next"?,parameters:{datasets:["cloudflare-workers"],filterCombination:"and",filters:[{key:"$workers.scriptVersion.id",operation:"eq",type:"string",value:<versionId>},{key:"$workers.eventType",operation:"eq",type:"string",value:<eventType>}]}}`；`limit` 为 `1..2000`，时间为 UTC epoch milliseconds。`filterCombination` 与 `filters` 只能位于 `parameters` 内；每个 exact deploy-cpu versionId 与 `queue|cron` eventType 分别查询，fixtures、保存的 query projection 和 decision 均逐层校验 `parameters` 嵌套以及每个 filter 的 `key/operation/type/value`。禁止顶层 `dataset/filterCombination/filters/orderBy`。首次读取 `result.events.count:number`；事件字段固定为 `result.events.events[].$metadata.id:string`、`$workers.scriptVersion.id:string`、`$workers.eventType:string`、`$workers.outcome:string`、`$workers.cpuTimeMs:number`、`timestamp:number`。

若 `result.events.count>result.events.events.length`，下一页保持嵌套 `parameters` 不变，并在请求顶层增加 `offset:<上一页最后一条 $metadata.id>`、`offsetDirection:"next"`，同时使用新的 `queryId`；opaque cursor 只要求非空、与上一页不同且没有重复事件 ID，不做字典序比较。循环至唯一 ID 数严格等于首屏 `result.events.count`，随后以原始首屏请求再查一次并要求 count 未变化，否则稳定窗口未闭合、立即失败。

`cpu-invocation-run.json` 必须在各触发完成后记录 Queue send/consume run marker 与两个真实 Cron invocation marker，以及各自闭合 `from/to`；`expectedCount` 只能由这些已发生的触发/审计记录推导，禁止在 runner 前猜测或写入未来 Telemetry event ID。随后 `queue-invocations.json` 查询并直接保存实际 `$metadata.id` 原值、Telemetry `totalCount` 及规范化事件投影，再把这些实际 IDs 回写到 finalized `cpu-invocation-run.json` 的对应窗口。两份 artifact 均须保存可重算的触发标识、窗口、expected count、Telemetry count 与稳定排序实际 event IDs，不得只保存 event ID hash 或 aggregate。每个窗口另保存脱敏 query projection（逐页 queryId、毫秒 timeframe、view、limit、完整嵌套的 `parameters.datasets/filterCombination/filters` 及每个 filter 的 key/operation/type/value、第二页起的 offsetHash/offsetDirection）、`pageCount`、每页 `count/offsetHash/canonicalSha256`。不得保存 token/account ID，也不得只信服务端 aggregate。

decision 针对 exact deploy-cpu version 从完整事件集重算：Queue unique event ID 数 `>=1`，Cron unique event ID 数 `>=2`，且两个 Cron tick 的 `$metadata.id` 必须不同；每个 timestamp 必须位于其所属闭合窗口（含端点），每窗 unique 数必须同时等于 artifact 的 `expectedCount` 与 Telemetry `totalCount`。仅有任意事件数据、只满足 aggregate 或把两个 Cron 合并为同一事件均不得通过。空页但未收齐、重复 ID、缺页、cursor 不变化、count 不闭合或复查漂移、错 version/eventType/窗口均 `NO-GO`。闭合后再从完整事件集本地重算 `maxCpuTimeMs` 与 nearest-rank P99，确认无 `outcome="exceededCpu"` 且 max/P99 均 `<10`；等于 10 失败。cpu profile 上须重放同等 Queue consumer 与两个真实 Cron 观测窗口，不能把 probes version 的事件当成 cpu 证据；`queue.json` 仍绑定 probes 功能闸门。测试覆盖 expected/Telemetry/unique count 不等、Queue 0 条、Cron 少于 2 条、两个 Cron metadata.id 相同及 timestamp 越界。

- [ ] **Step 5: 关闭捕获后重新部署并生成 CPU 流量**

仅在 Step 4 的 contract/AI/Queue 全部通过后，先验证 `deploy-probes.json`、`remote-contract.json`、`ai.json`、`queue.json` 均 `passed:true` 且当前 production 仍精确等于 probes version；任一不符不得生成凭据或部署。随后必须先执行 `rtk node scripts/phase0/deploy.mjs --profile cpu --out artifacts/phase0/deploy-cpu.json`，成功生成并复核本次 cpu production deployment 后，才可运行 `measure-cpu.mjs`。

`deploy.mjs --profile cpu` 必须在进程内用 CSPRNG 分别生成至少 256-bit 的 `PHASE0_CPU_LIMIT_SECRET`、至少 128-bit 的 URL-safe path segment 和不可重放 handoff session nonce；拒绝任何预存 handoff、已有值或与本仓库既有 CPU 证据 hash 相同的值。脚本以子进程 stdin（不得用 argv、shell interpolation 或环境回显）依次调用 `wrangler versions secret put PHASE0_CPU_LIMIT_SECRET` 与 `wrangler versions secret put PHASE0_CPU_LIMIT_PATH_SEGMENT`，再执行 cpu profile 的最终 `wrangler deploy`，使 secret 与 path 作为 Workers secret bindings 持久化到远端；临时版本不得被当作被测 production。最终配置固定 `PHASE0_CAPTURE=false`、`PHASE0_CPU_LIMIT_PROBE=true` 且不含 `limits.cpu_ms`。脚本随后读取 production status/settings 与 `/api/version`，验证最终 version、两个 binding 名、配置/source manifest 和账户均属于本次 cpu deployment；任一失败立即进入 cleanup。

明文 secret/path/session nonce 只允许存在于 deploy 进程内存以及固定本地 `.phase0/runtime/cpu-limit-handoff` 中。deploy 脚本必须以独占创建、目录 `0700`、文件 `0600` 写入该临时 handoff；该路径必须被 Git 排除，内容不得出现在 JSON、stdout/stderr、命令行参数、source manifest 或 Git。`deploy-cpu.json` 只直接保存 `secretBindingName:"PHASE0_CPU_LIMIT_SECRET"`、`pathBindingName:"PHASE0_CPU_LIMIT_PATH_SEGMENT"`、`secretSha256`、`pathSegmentSha256`、`handoffSessionNonceSha256`、凭据生成时间/算法、完整 cpu DeploymentProvenance、production settings/status/version 脱敏投影及各 canonical hash；不得保存三项明文或仅以 `passed` 代替投影。

`measure-cpu.mjs` 启动时先要求 `deploy-cpu.json` 已存在且通过上述直接内容重算，再执行 `wrangler deployments status --json`，确认当前 production versionIds 与 deploy-cpu 精确一致；不一致不得发流量。随后确认除带完整认证的 CPU-limit 路由外其他 `/__phase0/*` 返回 404，并只对该 cpu deployment 执行 1,000 次操作，同时以只读/幂等测试数据重放 Queue consumer 与两个 scheduled 观测窗口；完成后按上文完整分页规则生成 `queue-invocations.json`，再生成 `cpu.json`：

触发 CPU 观测前只生成 runId 与完整 cpu DeploymentProvenance，不得写 expected event IDs。Queue consume 与每个真实 Cron tick 发生后，分别记录其非敏感触发/审计标识和闭合窗口，并据已发生记录计算 expected counts；随后查询 Telemetry，记录实际 `$metadata.id` 与 Telemetry counts，再原子 finalize `cpu-invocation-run.json` 和 `queue-invocations.json`。Queue success 与两个真实 Cron tick 必须分别属于其窗口，G7 不得复用 probes `queue.json` 的窗口。

仅 cpu profile 可设非秘密开关 `PHASE0_CPU_LIMIT_PROBE=true`。专用路由为 `POST /__phase0/cpu-limit/<segment>`，其中 segment 来自本次远端 `PHASE0_CPU_LIMIT_PATH_SEGMENT` binding；请求还必须携带本次 `PHASE0_CPU_LIMIT_SECRET` 与一次性 nonce。nonce 由 runner 先以短 TTL 写入 D1；路由必须在一个 D1 事务中验证 path、secret 与 nonce，确认 nonce 未过期/未消费并标记 consumed，事务成功后才进入确定性 CPU busy-loop，直到平台终止。路径错误、secret/nonce 错误、nonce 重放、过期、普通 probes/clients/cleanup profile 或开关 false 一律 404，且不得开始 busy-loop。

`run-free-limit.mjs` 只能在常规 G5 HTTP/GraphQL 窗口与 G7 Queue/两个 Cron 窗口均已闭合、`cpu.json`/`cpu-invocation-run.json`/`queue-invocations.json` 已原子完成并通过 regular-only 校验后运行。它必须独占打开 `.phase0/runtime/cpu-limit-handoff`，验证权限/owner、本次 cpu deployment/version、handoff session nonce hash、secret hash 与 path hash全部等于 `deploy-cpu.json`，再把明文仅留在当前进程内存；不得接受 CLI secret/path、其他环境来源、旧文件或其他 deployment。runner 创建一次性 D1 nonce 和独立 runId/闭合窗口，使用该 handoff 的 path/secret 发出恰好一次请求，要求 Free 原生固定 10ms 上限产生 HTTP 1102，并用 `CLOUDFLARE_OBSERVABILITY_TOKEN` 查询 exact cpu version/窗口得到 `outcome="exceededCpu"`。不得使用 Wrangler CPU 配置值或自报 usage model 代替该 authenticated one-time 实测。

`run-free-limit.mjs` 必须以 `try/finally` 包围凭据读取、nonce 创建、请求与 Telemetry 查询；`finally` 无条件清空内存引用、unlink handoff 并以参数数组启动同一个部署器，等价执行 `rtk node scripts/phase0/deploy.mjs --profile cleanup --from artifacts/phase0/deploy-cpu.json --out artifacts/phase0/deploy-cleanup.json`。cleanup profile 先固定 `PHASE0_CAPTURE=false`、`PHASE0_CPU_LIMIT_PROBE=false` 且不含 `limits.cpu_ms`，通过 `wrangler versions secret delete` 删除 `PHASE0_CPU_LIMIT_SECRET` 与 `PHASE0_CPU_LIMIT_PATH_SEGMENT`（若平台要求轮换则生成全新值、证明 hash 与 cpu 值不同且不再被 source 引用），再执行最终 cleanup 覆盖部署；必须复查 production status/settings、两个临时 binding 已不存在或已轮换且不可达、CPU-limit 路由为 404、`/api/health` 正常及 `/api/version` 精确等于 cleanup version。禁止删除整个 Worker/deployment 代替覆盖部署。

`free-limit.json` 顶层展开被测 cpu DeploymentProvenance，直接保存 runId、闭合 window、三组常规 G5/G7 窗口、`windowsNonOverlapping`、`secretSha256`、`pathSegmentSha256`、`handoffSessionNonceSha256`、nonceSha256、nonceConsumed、http1102Seen、telemetryExceededCpuSeen、probePassed，以及 `deployCleanupCanonicalSha256`、cleanup 是否由 finally 调用和 cleanup 结果摘要、canonicalSha256、passed；不得保存 path、secret 或 nonce 明文，也不得只保存不可重算的结论 hash。`deploy-cleanup.json` 独立直接保存 cleanup DeploymentProvenance、由 cpu deployment ID/version 到 cleanup deployment ID/version 的覆盖链、稳定排序 source manifest 及 canonical SHA-256、production status/settings 脱敏投影与 hash、probe=false/无 `limits.cpu_ms` 投影、两个 binding 的 deleted/rotated 状态与前后 hash 比较、CPU-limit 路由 404、health/version 投影与 hash、canonicalSha256 和 passed。free-limit 探针失败时仍须原子写 `passed:false` 并完成 cleanup；cleanup 失败时同样 `passed:false`，原探针失败不得被 cleanup 成功覆盖。

decision 从各 artifact 的闭合端点重算 free-limit 与所有常规 G5/G7 窗口两两不重叠，验证 free-limit 使用的 secret/path/session hashes 与 `deploy-cpu.json` 相等、nonce 已一次性消费、HTTP 1102 与 exact cpu version Telemetry `exceededCpu` 同时出现，并从 `deploy-cleanup.json` 的稳定排序 source manifest 重算 `sourceDeploySha256`，逐字段校验 cleanup DeploymentProvenance、cpu→cleanup 版本链、production status/settings、配置中不存在 `limits.cpu_ms`、probe=false、临时 binding 已删除或安全轮换、CPU-limit 路由不可达及 health/version 投影。任一 CPU 部署缺失、凭据复用或泄露、原子消费、预期终止、窗口重叠、Telemetry、finally cleanup、恢复健康、cleanup 配置/部署/status/version/binding 失败均 `NO-GO`。

```text
20% config.clientConfig
20% users.settings
25% bookmarks.getBookmarks
20% bookmarks.checkUrl
10% bookmarks.getBookmark(includeContent=false)
5% bookmarks.createBookmark（唯一 URL）
```

记录每类请求数、HTTP 状态、tRPC code 和 1102 次数；任何 1102 立即失败。

- [ ] **Step 6: 查询 Cloudflare GraphQL CPU P99**

GraphQL runner 只读取独立环境变量 `CLOUDFLARE_ANALYTICS_TOKEN`（仅需 Analytics Read）；Telemetry runner 只读取 `CLOUDFLARE_OBSERVABILITY_TOKEN`（Workers Observability Write）。二者及 Billing token 不得互相 fallback。preflight 权限检查、runner 与 fixtures 分别验证 token 存在、最小权限用途和错误 token/权限不足的 fail-closed 行为，且任何 token 不落盘。`CLOUDFLARE_ACCOUNT_ID` 只在当前进程使用。查询刚才流量的完整 UTC 分钟窗口：

```graphql
query Cpu($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 100
        filter: {
          datetime_geq: $datetimeStart
          datetime_leq: $datetimeEnd
          scriptName: $scriptName
        }
      ) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { datetime scriptName status }
      }
    }
  }
}
```

CPU 字段单位按 Cloudflare schema 为微秒。合并窗口中取最大的 `cpuTimeP99`，通过条件为 `requests>=1000`、`errors===0`、`cpuTimeP99<8000`。没有 P99、没有数据、GraphQL 权限不足或单位无法确认都判失败。输出 `artifacts/phase0/cpu.json`，不保存 API token 或完整 Account ID。

执行：`rtk node scripts/phase0/measure-cpu.mjs`。runner 必须在发流量前后各执行一次 production status 校验，任一次 versionIds 漂移都写 `passed:false`。

- [ ] **Step 7: 汇总校验并提交（不得重跑 probes gate）**

Step 7 先完成常规 G5/G7，再运行破坏性的 free-limit，最后验证 cleanup；probes 的 contract/AI/Queue 必须早于 deploy-cpu 生成并绑定 probes versionIds，CPU 与 queue-invocations 必须晚于 deploy-cpu 且绑定 cpu deploymentId/versionIds。不得在 cpu deployment 成为 production 后再次运行 `run-remote-gates.mjs`。执行顺序不得调整：

```bash
rtk node scripts/phase0/deploy.mjs --profile cpu --out artifacts/phase0/deploy-cpu.json
rtk node scripts/phase0/measure-cpu.mjs
rtk node scripts/phase0/verify-remote-artifacts.mjs --regular-only
rtk node scripts/phase0/run-free-limit.mjs --deploy artifacts/phase0/deploy-cpu.json --cpu-run artifacts/phase0/cpu-invocation-run.json --queue-invocations artifacts/phase0/queue-invocations.json --cpu artifacts/phase0/cpu.json --cleanup-out artifacts/phase0/deploy-cleanup.json --out artifacts/phase0/free-limit.json
rtk npm test -- test/phase0-scripts.test.ts
rtk npm run typecheck
rtk node scripts/phase0/verify-remote-artifacts.mjs
rtk git add scripts/phase0 test/phase0-scripts.test.ts artifacts/phase0/deploy-cpu.json artifacts/phase0/deploy-cleanup.json artifacts/phase0/remote-contract.json artifacts/phase0/ai.json artifacts/phase0/queue.json artifacts/phase0/cpu-invocation-run.json artifacts/phase0/queue-invocations.json artifacts/phase0/cpu.json artifacts/phase0/free-limit.json
rtk git commit -m "test: record remote cloudflare gates"
```

其中第一条命令必须在执行前重算 Step 4 四个 probes artifact 且确认 production 未漂移；`deploy.mjs` 只经 stdin 向 Wrangler 注入 secret/path，并留下权限受限 handoff。`run-free-limit.mjs` 内部的 `finally` 必须明确执行同一 `deploy.mjs --profile cleanup --from artifacts/phase0/deploy-cpu.json --out artifacts/phase0/deploy-cleanup.json`，然后清理 handoff；无论 probe 主流程以成功、异常或超时离开都不得跳过。Expected：deploy-cpu、deploy-cleanup、remote-contract、ai、queue、queue-invocations、cpu、free-limit 均 `passed:true`，常规窗口先闭合且与 free-limit 窗口不重叠，本次 secret/path/session/nonce、1102/exceededCpu 闭合，并已覆盖部署 `PHASE0_CPU_LIMIT_PROBE=false`、临时 binding 已删除或轮换的 cleanup production，其完整 source manifest/provenance/status/settings/version/health 已验证；否则立即转 Task 15 生成 `NO-GO`，跳过 Task 13–14。

## Task 13: 官方浏览器扩展 1.2.11 真实兼容验收

**Files:**

- Create: `artifacts/phase0/extension-manual.json`
- Create: `artifacts/phase0/wire-extension.json`
- Create: `artifacts/phase0/capture-freeze-extension.json`
- Read: `artifacts/phase0/extension-client-manifest.json`
- Create: `artifacts/phase0/deploy-clients.json`
- Create: `artifacts/phase0/extension-login.png`
- Create: `artifacts/phase0/extension-save.png`
- Create: `artifacts/phase0/extension-preview.png`
- Create: `artifacts/phase0/extension-version.png`
- Create: `artifacts/phase0/extension-screenshots.json`
- Create: `artifacts/phase0/extension-store-install.png`
- Create: `artifacts/phase0/installed-content-manifest.json`
- Create: `artifacts/phase0/signed-content-manifest.json`
- Create: `artifacts/phase0/extension-store-content-binding.json`
- Create: `test/extension-store-content-binding.test.ts`

- [ ] **Step 1: 消费并复验最早期锁定的官方 1.2.11 CRX3**

读取 Task 1 已通过的 `extension-client-manifest.json` 与 Store-evidence，按锁定的 `clients2.google.com/service/update2/crx` 请求模板重新下载 CRX3，复核 request、redirect-host allow-list/chain、response projection、size、package SHA-256、CRX3 proof、公钥派生 ID、Store ID/version/publisher evidence 与 verifier 版本。不得要求扩展 `immutableSourceUrl/assetId/signerAllowList`；signer/public-key hash 仅观测，不得作为 trust input。不得改写锁定 manifest；任何信任条件或本次绑定不一致立即失败。

随后创建全新 Chrome profile，只从官方 Chrome Web Store 安装锁定 ID/version，保存 `extension-store-install.png` 及其 SHA-256；定位该 profile 的实际扩展目录并再次核验 ID/version。以固定规则生成 `installed-content-manifest.json`：相对 POSIX 路径、字节数、每文件 SHA-256 稳定排序，排除且仅排除 verifier 版本中明确列出的 Chrome 运行时生成文件。将刚验签且 packageSha256 匹配的 CRX3 解压，按完全相同规则生成 `signed-content-manifest.json`，两份 canonical hash 必须相等。严禁向 `extension-client-manifest.json` 新增字段或以任何方式改写它；部署 clients 后单独生成 `extension-store-content-binding.json`，直接保存并重算原 extension manifest canonical hash、installed/signed manifest canonical hashes、相同 `contentExclusionRulesVersion`、Store evidence/install screenshot hashes、profile path hash、profile session nonce，以及顶层完整 clients `DeploymentProvenance`。`test/extension-store-content-binding.test.ts` 必须证明原 manifest 字节发生任何变化、任一 hash/rule/profile/session/provenance 缺失或错配均失败。无法安装锁定 Store 包、定位目录、形成可比较 manifest 或 hash 不等均立即 `NO-GO`；禁止使用 unpacked extension 替代。

- [ ] **Step 2: 配置精确扩展 Origin、恢复 capture 并开启会话**

从已审阅 client lock 读取并设置非秘密 Wrangler 配置变量 `ALLOWED_EXTENSION_ORIGIN="chrome-extension://kgcjekpmcjjogibpjebkhaanilehneje"`，不得使用 secret。设 `PHASE0_CAPTURE=true`，执行 `rtk node scripts/phase0/deploy.mjs --profile clients --out artifacts/phase0/deploy-clients.json`。随后读取当前 production version/settings，回验该变量、`allowedExtensionOriginSha256`、deploymentId/versionIds 与 lock/config 完全一致，再调用：

```http
POST /__phase0/capture/start
Authorization: Bearer <PHASE0_API_KEY>
Content-Type: application/json

{"runId":"extension-20260902","client":"extension"}
```

响应必须为 `{ enabled:true, eventCount:0 }`。该 HTTP 示例中的尖括号代表运行时环境变量，不可把真实 key 写进计划、脚本或 artifact。

- [ ] **Step 3: 执行三项真实用户流程**

在全新浏览器 profile 中：

1. Server Address 填 clients Worker origin，API Key 填本次 key，并在 `customHeaders` 设置中加入固定测试头 `X-KaraClone-Phase0`；只执行一次登录。该真实登录请求必须成功，且 capture 证明 OPTIONS 请求并允许固定头、Origin 匹配、随后 tRPC 请求出现固定头；截图 `extension-login.png`。证据只记录布尔值，绝不记录头值、任意 header 名称集合或开发者工具 header dump。
2. 在公开网页点击保存；UI 明确成功，D1 新增一条书签；截图 `extension-save.png`。
3. 点击扩展中的打开/预览动作，实际到达 `/dashboard/preview/:id`，页面标题和原链接正确；截图 `extension-preview.png`。
4. 打开该全新 profile 的 Chromium 扩展管理页，显示实际安装的 Karakeep、版本 1.2.11 和 ID `kgcjekpmcjjogibpjebkhaanilehneje`，遮蔽其他扩展与个人信息后截图 `extension-version.png` 并计算 SHA-256；该截图只证明实际 ID/version，不证明 publisher。publisher 只由已人工审核的 Store-evidence 证明。

测试 URL 使用公开固定页 `https://example.com/`，避免把私人浏览记录写进 artifact。

- [ ] **Step 4: 停止并导出 wire shape**

```bash
rtk node scripts/phase0/freeze-capture.mjs --client extension --run-id extension-20260902 --deploy artifacts/phase0/deploy-clients.json --out artifacts/phase0/capture-freeze-extension.json
rtk node scripts/phase0/export-wire.mjs --client extension --run-id extension-20260902 --freeze artifacts/phase0/capture-freeze-extension.json --deploy artifacts/phase0/deploy-clients.json --out artifacts/phase0/wire-extension.json
```

运行 freeze 前必须确认扩展不再有在途请求。freeze 必须取得 stop 前至少 10 秒静默窗口，stop 后固定等待并完成两次相隔 5 秒的 status；两次均须匹配 runId/client、`enabled:false` 且 event/http envelope count 完全一致。export 再独立做带间隔复核；任一失败不得导出。命令不得输出 Authorization 或 API key。

手工 JSON 固定结构：

```json
{
  "clientVersion": "1.2.11",
  "runId": "extension-20260902",
  "client": "extension",
  "workerUrl": "https://<deployed-worker-host>",
  "deploymentId": "<production-deployment-id>",
  "versionIds": ["<production-version-id>"],
  "profile": "clients",
  "sourceDeploySha256": "<sha256>",
  "clientManifestSha256": "<sha256>",
  "releasePackageSha256": "<sha256>",
  "versionEvidenceScreenshotSha256": "<sha256>",
  "freezeSha256": "<sha256>",
  "wireSha256": "<sha256>",
  "canonicalSha256": "<sha256>",
  "login": true,
  "save": true,
  "openPreview": true,
  "fixedTestHeaderSeen": true,
  "corsFixedHeaderRequested": true,
  "corsFixedHeaderAllowed": true,
  "corsOriginMatched": true,
  "captureQuietWindowPassed": true,
  "captureStopped": true,
  "captureCountsStable": true,
  "databaseVerified": true,
  "screenshots": [{"file":"extension-login.png","sha256":"<sha256>"},{"file":"extension-save.png","sha256":"<sha256>"},{"file":"extension-preview.png","sha256":"<sha256>"},{"file":"extension-version.png","sha256":"<sha256>"}],
  "passed": true
}
```

manual、freeze、wire、截图清单与 `extension-store-content-binding.json` 顶层都必须直接展开相同的 DeploymentProvenance，并与 deploy-clients 五字段精确相等，同时保持相同 runId/client；content binding 必须从只读 extension manifest 与直接内容重算，wire 记录 freeze artifact 的 canonical SHA-256，最终写 manual 时记录 freeze、wire 与 content binding 的 canonical SHA-256。只有三项 UI 流程、服务端固定测试头与三个 CORS 布尔、数据库验证、capture 静默窗口/停止/带间隔稳定复核、wire 非空且 unknown procedures 为 0，且全部 hash 均匹配时才能 true。

- [ ] **Step 5: 提交非敏感证据**

```bash
rtk npm test -- test/extension-store-content-binding.test.ts
rtk git add test/extension-store-content-binding.test.ts artifacts/phase0/deploy-clients.json artifacts/phase0/extension-manual.json artifacts/phase0/capture-freeze-extension.json artifacts/phase0/wire-extension.json artifacts/phase0/installed-content-manifest.json artifacts/phase0/signed-content-manifest.json artifacts/phase0/extension-store-content-binding.json artifacts/phase0/extension-screenshots.json artifacts/phase0/extension-*.png
rtk git commit -m "test: record extension 1.2.11 compatibility"
```

PNG 必须先人工确认不含 secret、API key、Authorization，所有 key 字段保持 mask，且只展示 `example.com` 流程，再纳入 git；不得引入 R2。decision 从仓库文件重算每张 PNG、manifest 与 artifact 哈希。

## Task 14: 官方移动端 1.11.0 真实兼容验收

**Files:**

- Create: `artifacts/phase0/mobile-manual.json`
- Create: `artifacts/phase0/wire-mobile.json`
- Create: `artifacts/phase0/capture-freeze-mobile.json`
- Read: `artifacts/phase0/android-client-manifest.json`
- Create: `artifacts/phase0/mobile-login.png`
- Create: `artifacts/phase0/mobile-list.png`
- Create: `artifacts/phase0/mobile-detail.png`
- Create: `artifacts/phase0/mobile-original.png`
- Create: `artifacts/phase0/mobile-version.png`
- Create: `artifacts/phase0/mobile-version-evidence.json`
- Create: `artifacts/phase0/mobile-screenshots.json`
- Read: `artifacts/phase0/deploy-clients.json`

- [ ] **Step 1: 开启独立移动端捕获会话**

调用 `/__phase0/capture/start`，runId=`mobile-20260902`、client=`mobile`；接口会清空扩展事件，但 Task 13 已导出，不受影响。响应 eventCount 必须为 0。

- [ ] **Step 2: 消费并复验最早期锁定的官方 1.11.0 APK**

只使用 Android 参考工件：读取 Task 1 已通过的 `android-client-manifest.json`，再次运行同一 `verify-android-package.mjs` 从固定不可变官方 URL 下载签名 APK，重跑 `apksigner`/`apkanalyzer`，逐字段比较 package ID、version/build、package SHA-256、证书 SHA-256 allow-list、asset metadata、工具版本和规范化命令输出 hash；不得改写锁定 manifest。然后才可在真实 Android 设备或官方模拟器安装该已验证 APK。无法下载并离线复验的商店安装、IPA、null package hash 或任何不一致均立即 `NO-GO`；其他平台须单独重跑 Phase 0。

- [ ] **Step 3: 执行四项真实用户流程**

先确保 D1 至少有 Task 13 保存的 `https://example.com/`：

1. 在锁定移动端的 `customHeaders` 配置中加入固定测试头 `X-KaraClone-Phase0`，确认服务端 capture 的 `fixedTestHeaderSeen=true` 且真实 tRPC 请求成功；只记录布尔值，绝不记录头值或任意 header 名称集合。移动端不要求 CORS；不得用 curl 或脚本请求替代。
2. 填 Worker origin 与 API key，登录成功；截图 `mobile-login.png`。
3. 首页加载非空列表且显示 Example Domain；截图 `mobile-list.png`。
4. 打开详情，`includeContent:true` 的 Reader 内容非空且含“打开原链接”；截图 `mobile-detail.png`。
5. 点击原链接，在系统浏览器到达 `https://example.com/`；截图 `mobile-original.png`。
6. 在真机或模拟器打开 Android 应用信息/版本页面，随后统一执行 `adb exec-out screencap -p > artifacts/phase0/mobile-version.png`；不得用 macOS `screencapture` 代替设备画面。另执行 `adb shell dumpsys package app.hoarder.hoardermobile`，只保存脱敏规范化投影。Task 14 严禁修改 Task 1 的 `android-client-manifest.json`；必须新建 `mobile-version-evidence.json`，直接保存原 Android manifest canonical hash、脱敏 dumpsys 投影及其 canonical hash、由投影重提取的 package `app.hoarder.hoardermobile`/versionName 1.11.0/versionCode 45/签名证书 SHA-256、`{file:"mobile-version.png",sha256}`、人工无秘密审核信息、顶层完整 clients DeploymentProvenance及自身 canonical hash。decision 从 JSON 内容与 PNG 字节重算并与已验签 APK、只读 Android manifest、deploy-clients 交叉。

同时检查阅读进度请求无错误；highlights 为空时客户端不得崩溃。

- [ ] **Step 4: 导出 wire 并写人工证据**

```bash
rtk node scripts/phase0/freeze-capture.mjs --client mobile --run-id mobile-20260902 --deploy artifacts/phase0/deploy-clients.json --out artifacts/phase0/capture-freeze-mobile.json
rtk node scripts/phase0/export-wire.mjs --client mobile --run-id mobile-20260902 --freeze artifacts/phase0/capture-freeze-mobile.json --deploy artifacts/phase0/deploy-clients.json --out artifacts/phase0/wire-mobile.json
```

运行 freeze 前必须确认移动端不再有在途请求。freeze 必须取得 stop 前至少 10 秒静默窗口，stop 后固定等待并完成两次相隔 5 秒的 status；两次均须匹配 runId/client、`enabled:false` 且 event/http envelope count 完全一致。export 再独立做带间隔复核；任一失败不得导出。命令不得输出 Authorization 或 API key。

`mobile-manual.json` 固定字段：clientVersion、platform、runId、client、完整 DeploymentProvenance、clientManifestSha256、packageSha256、`mobileVersionEvidenceSha256`、freezeSha256、wireSha256、login、nonEmptyList、nonEmptyDetail、openOriginal、readingProgress、fixedTestHeaderSeen、captureQuietWindowPassed、captureStopped、captureCountsStable、screenshots、canonicalSha256、passed；它只能引用 `mobile-version-evidence.json` 的 canonical hash，不得直接保存、复制或替代 dumpsys 投影、版本 PNG/hash。manual 的 `screenshots` 仅列四张用户流程截图，不得列 `mobile-version.png`；版本 PNG 只能经 version evidence 绑定。manual、version evidence、freeze、wire 与截图清单顶层必须直接展开相同 DeploymentProvenance，并与 deploy-clients 五字段精确相等。只有全部直接内容和交叉 hash 可重算且匹配时才能 passed。

- [ ] **Step 5: 提交非敏感证据**

```bash
rtk git add artifacts/phase0/mobile-manual.json artifacts/phase0/mobile-version-evidence.json artifacts/phase0/capture-freeze-mobile.json artifacts/phase0/wire-mobile.json artifacts/phase0/mobile-screenshots.json artifacts/phase0/mobile-*.png
rtk git commit -m "test: record mobile 1.11.0 compatibility"
```

## Task 15: 自动 GO/NO-GO 判定、覆盖审计与终止点

**Files:**

下列 final 五件套虽标记为 Create，但只能由 `replay-final-store.mjs` 一次性原子生成；人工或其他脚本预建任一文件都会使 generator 失败。

本表共有 55 条 `Read`：其中 50 个是 `decide` 的直接证据文件输入，另外 5 个是任务内审计读取的 generator/测试源码；不得把源码读取计入运行时证据数量，也不得遗漏任何实体 PNG。Git object/history 由 `decide` 直接查询，不虚增为文件输入。

- Create: `scripts/phase0/decide.mjs`
- Create: `scripts/phase0/run-local-tests.mjs`
- Create: `scripts/phase0/replay-final-store.mjs`
- Create: `test/decision.test.ts`
- Create: `test/replay-final-store.test.ts`
- Create: `artifacts/phase0/decision.json`
- Create: `artifacts/phase0/final-store-binding.json`
- Create: `artifacts/phase0/final-store-install.png`
- Create: `artifacts/phase0/final-store-screenshot-manifest.json`
- Create: `artifacts/phase0/final-installed-content-manifest.json`
- Create: `artifacts/phase0/final-signed-content-manifest.json`
- Read: `artifacts/phase0/final-store-binding.json`
- Read: `artifacts/phase0/final-store-install.png`
- Read: `artifacts/phase0/final-store-screenshot-manifest.json`
- Read: `artifacts/phase0/final-installed-content-manifest.json`
- Read: `artifacts/phase0/final-signed-content-manifest.json`
- Read: `scripts/phase0/replay-final-store.mjs`
- Read: `test/replay-final-store.test.ts`
- Read: `scripts/phase0/capture-workers-plan-entitlement.mjs`
- Read: `test/workers-plan-entitlement.test.ts`
- Create: `artifacts/phase0/local-tests.json`
- Create: `artifacts/phase0/local-tests.txt`
- Read: `artifacts/phase0/local-tests.json`
- Read: `config/phase0/client-lock.json`
- Read: `artifacts/phase0/preflight.json`
- Read: `artifacts/phase0/workers-plan-entitlement.json`
- Read: `artifacts/phase0/workers-plan-entitlement.html`
- Read: `artifacts/phase0/workers-plan-entitlement.png`
- Read: `artifacts/phase0/deploy-probes.json`
- Read: `artifacts/phase0/deploy-cpu.json`
- Read: `artifacts/phase0/deploy-cleanup.json`
- Read: `artifacts/phase0/deploy-clients.json`
- Read: `artifacts/phase0/bootstrap.json`
- Read: `artifacts/phase0/smoke.json`
- Read: `artifacts/phase0/remote-contract.json`
- Read: `artifacts/phase0/ai.json`
- Read: `artifacts/phase0/queue.json`
- Read: `artifacts/phase0/queue-invocations.json`
- Read: `artifacts/phase0/cpu.json`
- Read: `artifacts/phase0/extension-client-manifest.json`
- Read: `artifacts/phase0/extension-store-evidence.json`
- Read: `artifacts/phase0/extension-store-evidence.png`
- Read: `artifacts/phase0/extension-store-content-binding.json`
- Read: `artifacts/phase0/extension-store-install.png`
- Read: `test/extension-store-content-binding.test.ts`
- Read: `artifacts/phase0/installed-content-manifest.json`
- Read: `artifacts/phase0/signed-content-manifest.json`
- Read: `artifacts/phase0/extension-screenshots.json`
- Read: `artifacts/phase0/extension-manual.json`
- Read: `artifacts/phase0/capture-freeze-extension.json`
- Read: `artifacts/phase0/wire-extension.json`
- Read: `artifacts/phase0/android-client-manifest.json`
- Read: `artifacts/phase0/mobile-manual.json`
- Read: `artifacts/phase0/mobile-version-evidence.json`
- Read: `artifacts/phase0/capture-freeze-mobile.json`
- Read: `artifacts/phase0/wire-mobile.json`
- Read: `artifacts/phase0/extension-login.png`
- Read: `artifacts/phase0/extension-save.png`
- Read: `artifacts/phase0/extension-preview.png`
- Read: `artifacts/phase0/extension-version.png`
- Read: `artifacts/phase0/mobile-login.png`
- Read: `artifacts/phase0/mobile-list.png`
- Read: `artifacts/phase0/mobile-detail.png`
- Read: `artifacts/phase0/mobile-original.png`
- Read: `artifacts/phase0/mobile-version.png`
- Read: `artifacts/phase0/mobile-screenshots.json`
- Read: `artifacts/phase0/cpu-invocation-run.json`
- Read: `artifacts/phase0/free-limit.json`

- [ ] **Step 1: 先写 fail-closed 决策测试**

表驱动测试只把 G0–G7 作为 `decide` 输入：文件缺失、JSON 损坏、`passed` 缺失、`passed:false`、G0 两个 account hash 不等、`result[].id`/rate_plan 判定字段/官方 enum/分页闭合/投影 hash 缺失或矛盾、唯一 subscription ID 数不等于 total_count、存在四种活跃 state/contract/externally managed 风险、client lock 缺失/未提交/未人工审阅/非 RESOLVED、候选 CRX 自建信任根、G1 `local-tests.json` 任一命令非零或 bindings/Cron 检查失败、G2 deploy account hash 与 G0 不等或 deploy/bootstrap/smoke 任一失败、unknown procedure 非空、CPU 等于 8000、Queue 少一次 attempt、payload 非精确四字段或达到 2 KB、Cron invocation 审计缺失/计数不恒等/任一次 `selectedCount>10`、非法 delay 未被真实拒绝、失败 job 未保持 pending、一次性标记未清除、下一 Cron 仍携带 option 或未消费、Telemetry 官方 body/权限/分页/过滤边界/数量不闭合/跨 deploy-cpu version/本地 max/P99 不符、free-limit 与常规窗口重叠、nonce 未消费、1102/exceededCpu 任一缺失、cpu deployment 缺失或不是被测 production、secret/path/session hash 与本次 handoff 不一致、旧凭据复用、明文泄露、cleanup 未由 finally 执行、deploy-cleanup 缺失、cpu→cleanup 版本链不闭合、cleanup version/status/settings/health 不一致、probe 未关闭或临时 binding 未删除/轮换、客户端 capture 静默/冻结证据缺失、clients settings 或 allowedExtensionOriginSha256 不符、固定测试头布尔缺失、扩展 CORS 三布尔缺失、manual/wire/freeze/deploy 顶层 deploymentId/versionIds/URL/runId/client/hash 不一致、APK/CRX3 重下载复验不符、发行包/版本截图/流程截图本地 SHA-256 重算不符、客户端版本不符都必须得到 `NO-GO`。仅 G0–G7 完整绿证据得到 `GO`。测试必须预置一个相互矛盾的旧 `decision.json`，证明首次或后续运行均不读取它，且输入对象/文件映射中不存在 G8 或 decision artifact。

G1 fixture 必须单独覆盖 `local-tests.json` 缺失、字节或 canonical hash 被篡改、任一命令结果缺失/非零、顶层 `passed:false`、dry-run 出现 `limits.cpu_ms` 或 bindings/Cron 检查失败，全部断言 `NO-GO`；`local-tests.txt` 永远不是 G1 或 decision 输入。

```ts
expect(decide(allPassing)).toEqual({ decision: "GO", failedGates: [] });
expect(decide({ ...allPassing, cpu: { passed: true, cpuTimeP99Us: 8000 } }).decision).toBe("NO-GO");
expect(decide(missingMobile)).toMatchObject({ decision: "NO-GO", failedGates: ["G4"] });
```

Command：`rtk npm test -- test/decision.test.ts`；Expected：失败。

`decision.test.ts` 还必须逐一构造 `extension-store-content-binding.json` 缺失或其原 extension manifest canonical hash、installed/signed hashes、rule、profile/session、DeploymentProvenance 任一错配，以及 `final-store-binding.json`、`final-store-screenshot-manifest.json`、`final-installed-content-manifest.json`、`final-signed-content-manifest.json` 或 `final-store-install.png` 缺失的 fixtures。两份 final manifest 的 `exclusionRulesVersion` 不同、逐文件内容或 canonical hash 不等、final 五件套未引用同一 Task 13 content binding、截图或任一 binding/content/CRX hash 不符，以及最终重放不是本次新 profile 或其 Store ID/version/锁定 CRX package/profile session nonce/content manifest 不匹配，全部断言 `NO-GO`。原 Task 1 extension manifest 的字节或 canonical hash 被 Task 13/15 改写也必须 `NO-GO`。`final-store-binding.json` 或 final screenshot manifest 顶层任一 clients DeploymentProvenance 字段缺失、与 `deploy-clients.json` 逐字段不等，或 screenshot manifest 的 PNG hash 无法从仓库重算，均必须 `NO-GO`。G7 fixtures 必须覆盖 Queue unique=0、Cron unique<2、两个 Cron metadata.id 相同、timestamp 不在各自闭合窗口、unique/expected/Telemetry count 任一不等，以及“仅有数据但未闭合”，均断言 `NO-GO`。

同一测试必须对三条实体证据链逐项 fail-closed：`extension-store-evidence.png` 缺失、替换或与 `extension-store-evidence.json` 的 SHA-256 不符；`extension-store-install.png` 缺失、替换或与 `extension-store-content-binding.json` 的 SHA-256 不符；`mobile-version-evidence.json`/`mobile-version.png` 任一缺失或替换、PNG/hash、脱敏 dumpsys 投影、原 Android manifest hash、完整 clients DeploymentProvenance 任一不可重算或不符。还必须证明 `mobile-manual.json` 含直接 dumpsys/PNG hash、未只引用 `mobileVersionEvidenceSha256`，或 Task 14 改写 `android-client-manifest.json` 时均为 `NO-GO`。

Git 历史 fixtures 必须覆盖：两份 Task 1 immutable manifest 未在同一提交首次加入、存在多个候选前置提交、首次加入后任一文件发生第二次内容修改、`HEAD`/index/工作树当前字节经 `git hash-object` 得到的 blob SHA 任一不等于首次提交 blob SHA、前置 commit 不是当前 `HEAD` 的祖先，以及 multiline history 解析、commit SHA、tree SHA 或任一 manifest blob SHA 无法重算/不一致；全部断言 `NO-GO`。`decide` 将重算出的唯一前置 commit SHA、tree SHA、Android blob SHA 与 extension blob SHA 记录到新生成的 `decision.json`，但不信任任何 artifact 内的同名声明。

源码审计 fixtures 必须覆盖 `scripts/phase0/capture-workers-plan-entitlement.mjs` 或 `test/workers-plan-entitlement.test.ts` 缺失、当前 blob/源码 hash 与唯一前置提交不符、首次提交后发生内容修改，全部断言 G0 `NO-GO`。另外三个既有源码审计输入 `scripts/phase0/replay-final-store.mjs`、`test/replay-final-store.test.ts`、`test/extension-store-content-binding.test.ts` 继续保留并执行既有缺失/hash 审计；不得用 artifact 自报源码 hash 替代 Git blob 与工作树字节重算。

`replay-final-store.test.ts` 必须 fail-closed 覆盖：临时 profile 目录预先非空或已有扩展、final 五文件任一预先存在、安装来源不是官方 Chrome Web Store、实际 ID/version 错误、重下载 CRX package/proof/hash 错误、两份 manifest 的规则或 canonical hash 不一致、截图失败、CDP/profile session 不是脚本本次创建的新 profile。generator 必须在这些场景非零退出，且不得留下部分 final artifact 或把旧文件当成功输入。

另以 fixtures 覆盖：G0 分页/数量/投影排序或重算 hash/订阅风险结论矛盾，Dashboard URL 非 HTTPS、host 非 `dash.cloudflare.com`、path 不属于目标 account、canonicalDashboardUrl/normalizedSelectorText/renderedDomEvidence 或规则版本缺失、DOM 含秘密、selector/rule 无法重提取、未明确提取 `Workers Free` 或 account ID、Dashboard/API/deploy 三方 account hash 不等；Queue 官方资源详情投影/来源/hash/retention 缺失、不可重算或任一 retention 非 24 小时，或创建证据出现 retention 配置参数；四份 deployment status/account identity/config/source hash 不完整，probes/cpu/clients/cleanup 任一配置或 source manifest 出现 `limits.cpu_ms`；`deploy-cpu.json` 缺失、非当前 production、secret/path binding 名或 hash 缺失、credential/session 时间不属于本次运行、复用旧 secret/path/session、artifact/source/log/argv 出现任一明文，或 free-limit 的 secret/path/session hash 与 cpu deploy 不等；`deploy-cleanup.json` 缺失、不是由 finally 生成、production version 未从 exact cpu version 前进、source/provenance/status/settings/version/health hash 不可重算、probe 未关闭、CPU-limit 路由仍可达、secret/path binding 未删除或未证明轮换为不同 hash；任一部署后 artifact 缺少或错配完整 DeploymentProvenance；Telemetry 把 filterCombination/filters 放在顶层、parameters 嵌套错误、任一 filter 的 key/operation/type/value 错误、count 不闭合、分页 hash/事件字段错误、无数据、错窗口、`exceededCpu` 或本地 P99 不达标；routeEvents 缺失/unknown/unparseable；Store-evidence 缺失或 publisher/page/screenshot hash 不符；Google CRX 请求/redirect/header 证据不符；Store 实装目录与验签 CRX3 的内容 manifest hash 不等；Android dumpsys 投影或 PNG hash 不符。以上一律 `NO-GO`。

- [ ] **Step 2: 实现 G0–G7 纯函数决策器、原子输出与 G8 后置检查**

`scripts/phase0/replay-final-store.mjs` 是 final Store 五文件的唯一生成器，禁止手工预建或由 `decide` 生成。它必须自行创建空的随机临时 Chrome `user-data-dir`、随机本地 CDP port 与不可重放的 `profileSessionNonce`；目录非空、已有扩展、CDP 不是本次 profile，或五个目标文件任一已存在时立即失败。脚本打开官方 Chrome Web Store 锁定页面，等待用户只在该 profile 中从 Store 安装锁定 ID/version，并通过 CDP 页面/安装来源证据和实际扩展目录确认不是 unpacked、侧载或其他来源。随后脚本按锁定 Google request template 重新下载 CRX3，验证 redirect-host allow-list、CRX3 proof、公钥派生 ID、Store ID/version/publisher 与 package hash，定位真实安装目录，并以同一 `exclusionRulesVersion` 对安装目录和验签 CRX 解包目录生成稳定排序的逐文件 `{path,size,sha256}` manifests；两者 canonical hash 必须相等。脚本通过 CDP 截取 `final-store-install.png`，完成脱敏/secret scan 后，以临时文件、fsync/close 和整体提交方式原子生成 `final-installed-content-manifest.json`、`final-signed-content-manifest.json`、`final-store-binding.json`、PNG、`final-store-screenshot-manifest.json`，失败不得留下部分输出，结束时删除临时 profile、下载包、解包目录和 raw 截图/DOM。

五文件必须共同绑定相同 clients `DeploymentProvenance={deploymentId,versionIds,profile,workerUrl,sourceDeploySha256}`、CRX package SHA-256、Store ID/version、`profileSessionNonce` 与本次 profile 路径 hash，并共同引用 Task 13 `extension-store-content-binding.json` 的 canonical hash及其锁定的原 extension manifest canonical hash。binding 引用两份 final manifest 的 canonical hash及 screenshot manifest hash，并保存 Store/CRX request/proof 可重算投影、capturedAt、reviewedBy/reviewedAt、canonicalSha256、passed；screenshot manifest 顶层直接展开同五个 DeploymentProvenance 字段。禁止复用 Task 13 manifests 或改写 Task 1 client manifests。该本地 Chrome/CDP 流程不使用 Cloudflare Browser Rendering，不创建或调用相关资源，不产生 Cloudflare 费用。

`decide` 的 G0–G7 直接证据输入固定为 Files 表中的 50 个 config/artifact/PNG 文件，明确包括 `local-tests.json`、`deploy-cpu.json` 与 `deploy-cleanup.json`；表中的 5 个 generator/测试源码是独立源码审计输入，不计入运行时证据数量。直接证据还必须显式包含 `extension-store-evidence.json` 及其 PNG、Task 1 两份 client manifests、Task 13 content binding及 `extension-store-install.png`、Task 14 `mobile-version-evidence.json` 及版本 PNG、final 五件套和其余 G0–G7 artifacts。决策器不得生成、改写或补齐证据；它从实体 PNG 字节和 JSON 直接内容重算 Store-evidence、content binding、mobile version evidence、`local-tests.json`、cpu/cleanup 安全投影及所有 provenance/引用，任一文件缺失、替换、hash 不符或失败结果均 fail-closed。

`decide` 加载 Files 表固定的 50 个 G0–G7 直接证据输入和 5 个源码审计输入，但不得读取旧 `decision.json`、`local-tests.txt` 或把 G8 当输入。它逐一从 JSON 直接内容、仓库 PNG/源码字节及 Git object/history 重算 hash、引用和 DeploymentProvenance；其中 G1 只依据 `local-tests.json`。对 CPU 链，它必须重算 deploy-cpu 的 binding 名、secret/path/session hashes 与 production 投影，验证 free-limit 使用同一组 hash 和 exact cpu version，再重算 deploy-cleanup 的 source manifest/provenance/status/settings/version/health、cpu→cleanup 覆盖顺序、probe=false、路由不可达及 binding 删除/轮换状态；任何明文字段命中全仓库证据 secret scan 即失败。它还必须证明两份 immutable manifest 在同一个唯一 Task 1 前置提交首次加入、该提交是当前 `HEAD` 的祖先、此后无第二次内容修改，且 `HEAD`、index 与工作树当前字节的 blob SHA 均等于首次提交 blob，并记录重算的 commit/tree/两个 blob SHA；还必须证明 entitlement collector 与对应测试的 `HEAD`/index/工作树 blob及源码 hash等于该前置提交且此后未改写。任一输入或源码缺失/替换、Git 历史歧义、SHA 不符、跨 deployment 或绑定不可证即 fail-closed；仅全部通过才原子生成 decision。

```json
{
  "decision": "NO-GO",
  "failedGates": ["G4"],
  "gates": {"G0": true, "G1": true, "G2": true, "G3": true, "G4": false, "G5": true, "G6": true, "G7": true},
  "checkedAt": "2026-09-02T00:00:00.000Z",
  "lockedVersions": {
    "karakeepCommit": "5a2f009e2f6d266087f2f3f527e6e384cefd6de4",
    "extension": "1.2.11",
    "mobile": "1.11.0"
  }
}
```

`checkedAt` 使用运行时 UTC；示例时间只表示格式。进程退出码：GO=0、NO-GO=2、证据解析错误=3。

决策器必须复用唯一 canonical JSON 实现，重算每个 artifact、subscriptionProjection、deploy config/source manifest、客户端 manifest 与仓库 PNG hash。G0 从完整稳定投影重算分页数量/hash、两个 account hash 相等及零活跃/合同/外部管理风险；G2 从 deploy-probes 重算第三个 account hash 相等及部署成功，只有 G0+G2 才得出同账户 Workers Free 运行态结论。G2/G6 与 Queue 功能证据接受 probes deployment，G5 及 G7 Telemetry 只接受 cpu deployment，G3/G4 只接受 clients deployment。每个后续 artifact 必须顶层含匹配的 production deploymentId/versionIds，禁止仅按相同 URL 或间接 hash 跨 deployment 拼接。decision 纯校验 replay generator 已保存的 CRX request/redirect/proof/package 与内容投影并重算其 hash，不执行网络下载或 Chrome 操作，也不信 artifact 自报布尔；任一 deployment status、routeEvents、完整 Telemetry 分页或客户端签名链不可证即 fail-closed。

- [ ] **Step 3: 运行本地最终验证并生成机器可读 G1 证据**

```bash
rtk node scripts/phase0/run-local-tests.mjs
```

`run-local-tests.mjs` 按顺序执行 `npm test`、`npm run typecheck`、`npx wrangler deploy --dry-run`，将完整 stdout/stderr 追加到 `local-tests.txt`，同时原子生成 `local-tests.json`。JSON 为每条命令记录 `command`、`exitCode`，并为 dry-run 记录解析后的 D1/Queues/AI bindings、禁止资源检查、`limits.cpu_ms` 缺失断言和 `0 * * * *` Cron 检查，顶层含 `passed`；不得把 txt 当 JSON 解析。任一命令非零、必需 binding/Cron 缺失、出现 `limits.cpu_ms` 或出现 KV/R2/Browser/Container 时 `passed:false` 并非零退出。G1 和 `decide` 只读取 `local-tests.json`；txt 仅供人工诊断。

- [ ] **Step 4: 执行协议覆盖审计**

比较锁定源码清单与两份 wire：

```text
Extension: config.clientConfig, apiKeys.validate, bookmarks.checkUrl, bookmarks.createBookmark
Mobile: config.clientConfig, apiKeys.validate, users.whoami, users.settings,
        bookmarks.getBookmarks, bookmarks.getBookmark, highlights.getForBookmark,
        bookmarks.getReadingProgress, bookmarks.updateReadingProgress
```

每个实际调用必须有 router 和通过事件；任何额外 procedure 必须已实现并加入自动测试，不能只从 unknown 列表删除。

再执行 `rtk rg -n '@karakeep/|\.phase0/upstream' src test package.json package-lock.json`；Expected：无匹配，证明运行代码和依赖不引用上游源码。

- [ ] **Step 5: 执行决策并严格停止/放行**

```bash
rtk npm test -- test/replay-final-store.test.ts
rtk node scripts/phase0/replay-final-store.mjs --client-lock config/phase0/client-lock.json --store-evidence artifacts/phase0/extension-store-evidence.json --store-content-binding artifacts/phase0/extension-store-content-binding.json --deploy-provenance artifacts/phase0/deploy-clients.json --out-dir artifacts/phase0
rtk node scripts/phase0/decide.mjs
rtk git add scripts/phase0/decide.mjs scripts/phase0/run-local-tests.mjs scripts/phase0/replay-final-store.mjs test/decision.test.ts test/replay-final-store.test.ts artifacts/phase0/decision.json artifacts/phase0/local-tests.json artifacts/phase0/local-tests.txt artifacts/phase0/final-store-binding.json artifacts/phase0/final-store-screenshot-manifest.json artifacts/phase0/final-installed-content-manifest.json artifacts/phase0/final-signed-content-manifest.json artifacts/phase0/final-store-install.png
rtk git commit -m "test: decide cloudflare phase0 feasibility"
```

Expected：

- `GO`：Phase 0 目标完成，才允许根据 `KARACLONE_SPEC.md` 新建正式产品实施计划。
- `NO-GO`：提交失败 gate 和证据后停止；不得继续实现 Web UI、enrichment、搜索、迁移、KV 或 R2。

## 16. 计划完成前自检

- [ ] 每个 spec Phase 0 acceptance test 都映射到作为决策输入的 G0–G7 和至少一个具体脚本/人工证据；G8 仅是新 decision 原子输出后的完整性检查，不作为输入且不读取旧 decision。
- [ ] 所有代码修改步骤都给出精确文件、先失败的测试、运行命令和预期结果。
- [ ] G0 实际执行 `whoami --json` 与 Billing Read API 全部分页；精确校验 `result[].id`、顶层 state/price、`result[].rate_plan.id/scope/sets/is_contract/externally_managed` 及 result_info 类型；optional 判定字段缺失即失败。artifact 只保存 subscriptionIdSha256，唯一 ID 数必须等于 total_count；decision 重算分页闭合、投影、数量和全部 hash。
- [ ] G0 state 仅接受官方七值；任何 `Trial|Provisioned|Paid|AwaitingPayment`、contract、externally managed、缺失/未知值均失败；scope/sets 仅投影留证。无风险 Subscription 与 G2 同账户 deployment 只作交叉证据，不得替代 Dashboard 正向 entitlement。
- [ ] G0 entitlement JSON/HTML/PNG 只能由 collector 自行后台启动空临时 Chrome/CDP profile，记录并校验 expected user-data-dir、Chrome PID/args、实际 Profile Path、current endpoint 与 session nonce，暂停等待用户登录目标账户后采集并在退出时清理。collector 与 `workers-plan-entitlement.test.ts` 必须冻结在唯一 Task 1 前置提交；decision 校验其 Git blob/源码 hash 及后续零修改。测试覆盖 wrong PID/args/profile/nonce、non-current endpoint、同账户但非本次 profile、源码缺失/改写及既有失败集，失败不得产出三件套。
- [ ] Billing、GraphQL、Telemetry 分别只用 `CLOUDFLARE_BILLING_READ_TOKEN`、`CLOUDFLARE_ANALYTICS_TOKEN`、`CLOUDFLARE_OBSERVABILITY_TOKEN`，权限、runner 与失败 fixtures 独立且不得 fallback。
- [ ] `canonical-json.mjs` 是 preflight、四份 deploy、manifest、freeze、wire、manual 的唯一 canonical/hash 实现；UTF-8、Unicode、key、数字、非法值和自哈希字段排除规则均有固定测试。
- [ ] Task 11 实际顺序固定为 remote migrations→probes deploy→status→health/version→deploy-probes.json，再 bootstrap→bootstrap.json，再 smoke→smoke.json；三者均 passed 且 Worker URL/deploymentId 一致，Task 12 才可安全加载 `.dev.vars` 并启动。
- [ ] probes/cpu/clients/cleanup 每次真实 deploy 后都执行 `wrangler deployments status --json`。所有部署后 artifact 与两端截图清单顶层直接展开完整 DeploymentProvenance；`sourceDeploySha256` 等于所属 deploy artifact 的 canonical source/bundle manifest SHA-256，decision 五字段逐项相等且禁止间接 join 或跨 deployment 拼接。
- [ ] 所有远端关键结论来自实际 Cloudflare Free 账户，不以本地 workerd 代替。
- [ ] G1 只由 `local-tests.json` 机器可读记录三条命令的 exitCode、bindings、Cron 与 `limits.cpu_ms` 缺失检查；该文件列入 Files、生成、50 个直接 decision 输入与提交清单，缺失/篡改/失败均 No-Go，`local-tests.txt` 仅作日志。
- [ ] AI 模型、Karakeep commit、扩展版、移动端版均精确锁定，无静默 fallback。
- [ ] capture artifact 不含 secret、Authorization、完整 URL query、正文或 prompt。
- [ ] `src/`、`test/` 和依赖树不含 `@karakeep/*` 或复制的上游实现；`.phase0/upstream` 仅作未跟踪的只读互操作性参考。
- [ ] CPU 测试关闭 capture，`cpuTimeP99 < 8000µs`，且 1102 为 0。
- [ ] 所有 Free probes/cpu/clients/cleanup 配置及 source manifest 均不含仅 Standard 可配置的 `limits.cpu_ms`；10ms 只依赖 Free 原生固定上限。常规 CPU 流量前必须先运行 `deploy.mjs --profile cpu`，以 Wrangler stdin secret bindings 注入本次高熵 secret/path，受限 handoff 只供 `run-free-limit.mjs` 使用且立即清理；deploy-cpu 仅存 binding/name/hash/provenance。`run-free-limit.mjs` 仅在常规 G5/G7 窗口闭合后运行，并以 authenticated one-time 1102/`exceededCpu` 闭环验证原生上限；其 `finally` 无条件调用同一 `deploy.mjs --profile cleanup` 生成 `deploy-cleanup.json`，关闭 probe、删除或轮换临时 bindings并验证 production status/settings/version、路由 404 与 `/api/health`。probe 失败仍为 No-Go，cleanup 不得删除 deployment 替代。
- [ ] Task 6 在任何 Queue send 前已创建并测试唯一公共 schema；创建、探针和 Cron 全部复用它，消息严格只有 `bookmarkId`、`jobId`、`urlSnapshot`、`requestedAt` 且小于 2 KB；探针仅按 D1 `job_id` 关联，证据覆盖 attempts 1–4、30/300/1800 秒、dead、tagging failure 和 DLQ。
- [ ] 每次 Cron 严格按 `created_at ASC, id ASC` 选择最多 10 条，并由同一 invocation 的 D1 审计直接证明 `selectedCount<=10`、`selectedCount=sentCount+failedCount` 且每个 job 有发送结果；远端失败 job 被确定性建为首个选择集中的最老记录，不能依赖未定义顺序或从消费事件反推。
- [ ] PHASE0_CAPTURE 一次性失败探针确实调用 Queue binding 的 `send(payload,{delaySeconds:86401})` 并被平台拒绝，catch 后 job 保持 pending 且清除标记；下一真实 Cron 使用同一四字段 payload、不携带非法 option，并发送及消费成功。
- [ ] 扩展与移动端均以锁定客户端 `customHeaders` 发出固定测试头并成功；capture 只记录该头是否出现的布尔，绝不记录任意 header 名称集合或值；扩展另记录预检请求/允许固定头及 Origin 匹配三个布尔，移动端不要求 CORS。无在途请求后均通过 stop 前至少 10 秒静默窗口，再 stop，之后完成两次相隔 5 秒的稳定查询，export 还独立核对 disabled、Worker URL、runId/client、计数和哈希链。
- [ ] 两端 manual/wire/freeze/deploy/截图清单、锁定发行包或版本证据、版本截图和全部流程截图 SHA-256 可由 decision 本地重算并交叉验证；任一文件或 DeploymentProvenance 字段缺失、不一致即 fail-closed。
- [ ] Queue retry/DLQ 与 Cron 子探针并行运行，独立 deadline 分别为 45 和 130 分钟，整体含收尾 deadline 为 135 分钟；任一失败均 fail-closed。
- [ ] G7 仅使用官方 Observability Telemetry Query；权限为 Workers Observability Write。body 仅顶层含 `queryId/timeframe/view/limit/offset?/offsetDirection?`，`datasets/filterCombination/filters` 全部嵌套在 `parameters`，两个 filter 的 `key/operation/type/value` 精确校验；禁止顶层 dataset/filterCombination/filters/orderBy。每个 exact versionId+eventType 单独查询，以 `result.events.count` 和顶层 `offset/offsetDirection:"next"` 完整分页并复查 count 稳定；事件绑定 deploy-cpu，decision 本地重算无 exceededCpu 且 max/P99 `<10ms`。
- [ ] wire 的 `routeEvents` 覆盖客户端命中的全部 Worker API/preview 路由，只含 method/route template/status/request-response shape；capture 控制端点排除，原始 ID/path/query/body/header 禁止入库，unknown/unparseable 均失败。
- [ ] Task 1 在业务代码前已提交 RESOLVED client lock 与 Store-evidence。扩展信任仅依赖固定 Google update 请求模板、redirect-host allow-list、CRX3 proof、公钥派生 ID 等于独立 Store ID、Store ID/version/publisher evidence；immutable asset URL、asset ID、signer allow-list 仅适用于 Android，扩展 signer/publicKey hash 仅观测。全新 Store profile 实装 manifest 与 CRX3 解包 manifest 相等，禁止 unpacked 替代。
- [ ] Task 1 的两份 client manifest 在同一个唯一前置 commit 首次加入；decision 直接检查该 commit 是 `HEAD` 祖先、自首次加入后无第二次内容修改，且 `HEAD`/index/工作树 blob 均等于首次提交 blob，并记录/重算 commit、tree 与两个 blob SHA。Task 13 只新增 `extension-store-content-binding.json`，由测试和 decision 重算其原 manifest hash、installed/signed hashes、profile/session 与完整 clients DeploymentProvenance，final 五件套引用该 binding。
- [ ] Queue 创建命令不含 retention 参数；`deploy-probes.json` 保存两条 Queue 的官方资源详情可重算投影并证明实际 Free retention 均为 24 小时，缺失、篡改、非 24 小时或出现 retention 配置参数均 No-Go。
- [ ] Task 15 Files 表精确为 55 条 Read：50 个 G0–G7 直接证据输入（含 `local-tests.json`、`deploy-cpu.json`、`deploy-cleanup.json`）和 5 个源码审计输入；Git object/history 为直接查询而非文件输入，全文不再保留旧计数口径。
- [ ] 最终 decision 前必须运行唯一 `replay-final-store.mjs`：它创建空随机临时 Chrome profile/CDP port，等待官方 Store 安装，验证来源与锁定 ID/version，重下载并验签 CRX3，绑定 profile session nonce 与完整 clients DeploymentProvenance，原子生成 final 五件套并清理临时目录；预存 profile/artifact、非 Store 安装、hash/manifest/截图/profile 任一异常均失败。`decide` 只读取并重算，不生成或修改这些证据。
- [ ] 两个 Chrome/CDP 流程均为本地流程，不使用 Cloudflare Browser Rendering，也不产生 Cloudflare 费用。
- [ ] Task 1 顺序为最小环境→证据脚本/schema→实际运行并审核前置证据；G0/client lock 通过前不创建 D1/Queues、不安装业务依赖、不写业务 Worker。
- [ ] `extension-version.png` 与 `mobile-version.png` 均按任务中的实际截图命令生成并人工核验无秘密；`mobile-version.png` 只由独立 `mobile-version-evidence.json` 绑定，mobile manual 仅引用该 evidence canonical hash，decision 从仓库字节重算。
- [ ] 所有客户端 PNG 已确认无秘密、key 保持 mask、仅含 `example.com` 流程并纳入 git；不使用 R2，decision 从仓库重算 PNG hash。
- [ ] `apiKeys.revoke` 输入严格为 `{id:string}`，按当前 `user_id + api_keys.id` 吊销且幂等无输出；错误 id、跨用户和重复吊销均成功无输出且不改变记录，首次正确吊销后鉴权失败。
- [ ] 计划未越过 Phase 0 硬闸门；正式产品计划将在 GO 后单独编写。
