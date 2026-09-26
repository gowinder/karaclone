# KaraClone

运行在 **Cloudflare 免费层**、与**官方 Karakeep 客户端（移动端 + 浏览器扩展）协议兼容**的单用户 URL 书签服务。保存即持久化，标题抓取、AI 打标签、摘要生成全部异步后台完成。

[English](README.md) | **中文**

---

## 项目介绍

KaraClone 是从零实现 Karakeep 服务端 API 的子集，部署在 Cloudflare Workers 免费计划上。它**不是** Karakeep 完整服务端的移植——只实现锁定客户端版本所需的协议子集，不承诺兼容任意未来版本的官方客户端。

它解决一个问题：书签数据留在你自己的 Cloudflare 账号里，零基础设施成本，同时继续使用你熟悉的官方 Karakeep 移动端和浏览器扩展。

**适合谁用**：想把书签自托管、但没有 VPS 或家用服务器的用户。KaraClone 是 **serverless 的，完全由 Cloudflare 托管**——没有机器要打补丁，没有容器要跑，没有备份脚本要写。如果你已经有服务器，请直接自托管官方 Karakeep，它更完整。

**非商业个人自用**。KaraClone 是个人项目，按「现状」提供，不含任何担保与支持承诺。它不是服务，不是产品，与 Karakeep 没有任何隶属关系（详见下文）。

上游基线：Karakeep `5a2f009e2f6d266087f2f3f527e6e384cefd6de4`（2026-08-31）。目标客户端：Karakeep Mobile 1.11.0、Karakeep Browser Extension 1.2.11。

> **兼容性说明**：KaraClone 实现的是官方客户端使用的**内部 tRPC API**。该 API 属于 Karakeep 项目私有，**不提供兼容性保证**——这与 Karakeep 的公开 REST API 不同。上游版本之间没有稳定性承诺：比上述锁定版本更新的客户端可能可用也可能不可用，上游改动可能使本实现失效，直到跟进为止。

## 功能特性

- **即时保存** — URL 立即持久化，保存不等待抓取或 AI。
- **异步增强** — 后台队列提取标题、简介、OG 图片与可选正文；AI 生成 1–8 个标签和缺失的简短摘要。
- **AI 打标签** — 通过 Workers AI（`@cf/meta/llama-3.1-8b-instruct-fast`，锁定）或用户自配的 LLM 提供商（OpenRouter / Ollama Cloud）生成标签。
- **Web 控制台** — Worker 直出零构建零依赖 HTML：书签列表、保存表单、收藏/归档切换、标签筛选、阅读视图、设置（LLM 提供商 + 模型选择）、账户信息。响应式：桌面左侧固定侧栏，移动端底部 Tab Bar。
- **跨实例导入** — 从任意兼容的 Karakeep 实例迁移书签与标签（最多 500 条，按 URL 去重），后台队列执行，断点续传。
- **导入修复** — 一键修复导入数据：为标题是 URL 的书签抓取真实标题；用 LLM 把英文标签翻译成中文（撞已有中文标签时自动合并）。
- **API Key 认证** — 预生成 `ak2_...` 密钥，与官方客户端登录流程兼容。
- **R2 资产存储** — OG 图片与上传资产存 R2 并提供访问。

## 架构

```
┌─────────────────────────────┐
│  Karakeep Mobile 1.11.0     │
│  Browser Extension 1.2.11    │
│  Web Dashboard（内置）        │
└──────────────┬──────────────┘
               │ HTTPS /api/trpc（tRPC，Bearer ak2_...）
┌──────────────▼──────────────┐
│  Cloudflare Worker          │
│  src/index.ts               │
│  ├─ tRPC routers            │
│  ├─ HTTP: /dashboard,       │
│  │  /api/health, /api/version│
│  └─ Queue consumers         │
└───┬──────────┬──────────┬───┘
    │          │          │
┌───▼───┐ ┌────▼────┐ ┌───▼────────┐
│ D1    │ │ R2      │ │ Queues     │
│ SQLite│ │ assets  │ │ enrichment │
│ (auth,│ │ (OG img)│ │ import     │
│ book- │ │         │ │ + DLQ      │
│ marks)│ │         │ └───┬────────┘
└───────┘ └─────────┘     │
                          │ cron（每小时）重驱滞留任务
```

| 组件 | Binding | 用途 |
|---|---|---|
| D1 数据库 | `DB` | 权威数据源：用户、API Key、书签、标签、列表、导入任务 |
| R2 存储桶 | `ASSETS` | OG 图片与上传资产 |
| 队列 `karaclone-phase0-enrichment` | `ENRICHMENT_QUEUE` | 异步标题/标签/摘要增强 |
| 队列 `karaclone-phase0-import` | `IMPORT_QUEUE` | 后台导入 / 修复任务 |
| 队列 `karaclone-phase0-enrichment-dlq` | — | 增强任务死信队列 |
| Workers AI | `AI` | 内置打标签模型 |
| Cron 触发器 | — | 每小时重驱滞留的增强任务 |

## 客户端兼容性

- **浏览器扩展 1.2.11** — 用服务器地址 + API Key 登录，保存普通 HTTP/HTTPS URL。保存成功不依赖抓取、Jina 或 AI。
- **移动端 1.11.0** — 用服务器地址 + API Key 登录；可查看列表、打开详情、搜索、按标签浏览、收藏、归档、编辑、删除。
- 扩展 Origin 通过 `ALLOWED_EXTENSION_ORIGIN` 变量白名单放行（CORS）。

## 环境要求

- Node.js 20+ 与 npm
- Cloudflare 账号（免费计划即可）
- [wrangler](https://developers.cloudflare.com/workers/wrangler/)（本仓库锁定 `wrangler@4.128.0`）

## 部署

### 1. 安装并登录

```bash
npm install
npx wrangler login
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create karaclone-phase0
```

把返回的 `database_id` 填入 `wrangler.jsonc` → `d1_databases[0].database_id`。

### 3. 创建 R2 存储桶与队列

```bash
npx wrangler r2 bucket create karaclone-phase0-assets
npx wrangler queue create karaclone-phase0-enrichment
npx wrangler queue create karaclone-phase0-enrichment-dlq
npx wrangler queue create karaclone-phase0-import
```

### 4. 设置密钥

`LLM_CONFIG_KEY` 用于加密用户 LLM 提供商 API Key 的静态存储（控制台设置与导入修复翻译都会用到）：

```bash
npx wrangler secret put LLM_CONFIG_KEY
```

生成强随机值，例如 `openssl rand -hex 32`。

### 5. 应用迁移

```bash
npx wrangler d1 migrations apply karaclone-phase0 --remote
```

### 6. 部署

```bash
npx wrangler deploy --strict
```

Worker 地址为 `https://karaclone-phase0.<你的子域>.workers.dev`（`workers_dev: true`）。

### 7. 验证

```bash
curl https://karaclone-phase0.<你的子域>.workers.dev/api/health
curl https://karaclone-phase0.<你的子域>.workers.dev/api/version
```

## 配置

### Wrangler 变量（`wrangler.jsonc`）

| 变量 | 默认值 | 含义 |
|---|---|---|
| `SERVER_VERSION` | `0.1.0` | 通过 `config.clientConfig` 上报给客户端；显示在控制台侧栏 |
| `AI_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | 锁定的 Workers AI 打标签模型 — 不要修改 |
| `PHASE0_CAPTURE` | `true` | 启用 phase-0 探针接口（受认证保护） |
| `ALLOWED_EXTENSION_ORIGIN` | 两个 Chrome 扩展 ID | 浏览器扩展的 CORS 白名单 |

### 密钥

| 密钥 | 用途 |
|---|---|
| `LLM_CONFIG_KEY` | 加密 D1 中用户 LLM API Key 的 AES 密钥 |

### LLM 提供商

在控制台 **设置 → AI 提供商** 中按用户配置：

- **Workers AI** — 内置，免费额度，无需密钥
- **OpenRouter** — 聚合多家模型，按量付费，`https://openrouter.ai/api/v1`
- **Ollama Cloud** — `https://ollama.com`

配置提供商后拉取模型列表，在 **模型选择** 中保存对话模型（可选向量模型）。打标签与摘要使用所选对话模型；导入修复的标签翻译复用同一配置。

## 使用

### Web 控制台

浏览器打开 `/`（或 `/dashboard`）。注册账号后登录。控制台把 API Key 存在 `localStorage`，与官方客户端走同一套 tRPC API。

- **书签** — 默认主页：保存 URL、书签列表、收藏/归档/删除、展开查看笔记 + 摘要 + 打开原文 + 阅读视图、按标签筛选。
- **设置** — LLM 提供商配置、模型选择，以及**导入面板**：从其他 Karakeep 实例迁移（源地址 + 邮箱 + 密码）、查看任务进度、对成功导入的任务执行**修复**（补标题 + 英文标签翻译成中文）。
- **账户信息** — 个人资料、偏好、退出登录。

### 官方客户端

1. 打开 Karakeep 移动端或浏览器扩展。
2. 服务器地址填你的 Worker URL。
3. 用账号邮箱 + 密码登录（客户端自动换取 API Key），或直接粘贴已有的 `ak2_...` 密钥。

### 导入与修复

- **导入** — `imports.startImportJob` 用凭据换取源实例 API Key（密码不落库），队列 consumer 分页拉取源实例并写入书签/标签，按 URL 去重（最多 500 条）。进度按任务持久化；失败可重试并从断点续传。
- **修复** — `imports.fixImportedData` 创建 `kind=fix` 任务：(1) 为标题是 URL 的书签抓取真实标题；(2) 用用户 LLM 分批把英文标签翻译成中文，撞已有中文标签时合并。两个阶段均可断点续传，自动跳过已处理数据。

## 开发

```bash
npm run typecheck         # tsc --noEmit
npm test                  # vitest run --max-workers=1 --no-isolate（349 个测试）
npm run d1:migrate:remote # 向远端 D1 应用迁移
npm run deploy            # wrangler deploy --strict
```

## 项目结构

```
src/
├── index.ts              # Worker 入口：路由、CORS、队列分发
├── env.ts                # Env 接口（global merge）
├── auth/                 # API Key 认证、密码哈希、secret box
├── bookmarks/            # service、page-meta 抓取、阅读视图 HTML
├── contracts/            # 与客户端共享的 zod schema
├── db/                   # D1 访问辅助
├── http/                 # dashboard（1665 行零依赖 UI）、assets、routes
├── queue/                # 增强 consumer、导入 consumer、cron、DLQ
├── trpc/                 # tRPC router + context + 各域 router
└── ai/                   # Workers AI 打标签、OpenAI 兼容客户端
migrations/               # 0011 个 D1 迁移（认证 → 导入任务 → 修复类型）
scripts/phase0/           # preflight、部署、契约回放工具
test/                     # vitest 测试套件（349 个测试）
```

## 已知限制

- 面向单用户（支持多用户，但无团队/协作功能）。
- 不提供整页离线阅读；点击书签打开原始 URL。
- 未启用语义搜索（`search.semanticSearchEnabled: false`）。
- 单次导入上限 500 条书签。
- 仅保证上述锁定客户端版本的兼容性。
- 控制台的搜索框与收藏/标签筛选为 UI 呈现；服务端筛选目前仅支持 `archived`。

## 与 Karakeep 无隶属关系

KaraClone 是**独立的、非商业的、个人自用项目**，与 Karakeep 项目及 karakeep-app 无任何隶属、背书或赞助关系。「Karakeep」及相关标识归其各自所有者所有，此处仅用于描述协议兼容性。

本项目不是 Karakeep 服务端的 fork、移植或再分发。仓库**不包含任何 Karakeep 源码**——只复刻了通信协议，使官方客户端能够连接。

如果你需要完整、官方的体验（含 KaraClone 未实现的功能），请自托管 [Karakeep](https://github.com/karakeep-app/karakeep) 或使用 [Karakeep Cloud](https://karakeep.app/pricing/)。

## 许可证

[AGPL-3.0](LICENSE)，与上游 Karakeep 保持一致。

KaraClone 面向 **个人、非商业用途** 在 Cloudflare 免费层自托管。若你将修改版作为网络服务运行，AGPL 第 13 条要求你向用户提供其源码。
