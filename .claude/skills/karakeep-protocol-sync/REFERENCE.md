# REFERENCE — 协议漂移修复流程

`SKILL.md` 的展开版。仅在 `check-drift.mjs` 报出 `missingForClients` 时读这一份。

## 1. 定位上游定义

上游 tRPC 定义分散在三处，按这个顺序查：

| 层 | 路径 | 内容 |
|---|---|---|
| 路由 + 输入输出 | `.phase0/upstream/karakeep/packages/trpc/routers/<router>.ts` | procedure 定义、`.input()` / `.output()` |
| 共享 schema | `.phase0/upstream/karakeep/packages/shared/types/<domain>.ts` | `zXxxSchema`、类型导出 |
| 权限/中间件 | `.phase0/upstream/karakeep/packages/trpc/index.ts` | `protectedProcedure` 等 |

示例——查 `tags.get`：

```bash
cd .phase0/upstream/karakeep
grep -n -A20 "^  get: tagsProcedure" packages/trpc/routers/tags.ts
```

```ts
// packages/trpc/routers/tags.ts:49
get: tagsProcedure
  .input(z.object({ tagId: z.string() }))
  .output(zGetTagResponseSchema)
  .use(ensureTagOwnership)
  .query(async ({ ctx }) => await ctx.tag.getStats()),
```

再查 `zGetTagResponseSchema` 的实际形状：

```bash
grep -rn "zGetTagResponseSchema" packages/shared/types/tags.ts
```

## 2. 映射到本仓库

| 上游 router | 本仓库文件 |
|---|---|
| `bookmarks` | `src/trpc/routers/bookmarks.ts` |
| `apiKeys` | `src/trpc/routers/api-keys.ts` |
| `users` | `src/trpc/routers/users.ts` |
| `tags` | `src/trpc/routers/tags.ts` |
| `lists` | `src/trpc/routers/lists.ts` |
| `highlights` | `src/trpc/routers/highlights.ts` |
| `rules` | `src/trpc/routers/rules.ts` |
| `config` | `src/trpc/routers/config.ts` |
| `assets` | `src/trpc/routers/assets.ts` |
| `importSessions` | `src/trpc/routers/imports.ts`（另有 `import-fix.ts` 辅助） |
| `subscriptions` / `admin` / `feeds` / `webhooks` / … | 未实现（客户端不调用） |
| — | `src/trpc/routers/llm.ts`（本仓库自有，上游无对应） |

权威来源是 `src/trpc/router.ts` 的注册表，不是本表。

契约形状放 `src/contracts/<domain>.ts`；只有新形状才需要加，能复用就别新增文件。

## 3. 已补齐的缺口（基线 5a2f009e 检出，现已实现）

`check-drift.mjs` 在基线上曾报出以下 3 个移动端会调用的 procedure。它们已全部实现，
当前 `verdict` 为 `IN_SYNC`、`missingForClients` 为空。保留此表供回归对照：

| Procedure | 输入 | 触发场景 | 实现位置 |
|---|---|---|---|
| `tags.get` | `{ tagId }` | 移动端标签详情页（`app/dashboard/tags/[slug].tsx`） | `src/trpc/routers/tags.ts`（校验 user_id 归属，非本人 → `NOT_FOUND`） |
| `users.stats` | 无 | 移动端「设置 → 用量统计」 | `src/trpc/routers/users.ts`（schema 对齐上游；无 highlights/lists 数据源，计数恒 0；时区用 settings 默认值） |
| `bookmarks.searchBookmarks` | `{ text, searchMode, cursor }` | 移动端搜索框 | `src/trpc/routers/bookmarks.ts` + `src/bookmarks/search-query.ts`（语法解析；`searchMode !== "fts"` → `BAD_REQUEST`） |

搜索语法支持范围（上游基于 typescript-parsec 的完整语法只实现了客户端常用子集）：

- 支持：`is:fav`、`is:archived`、`#tag`、`tag:`、`url:`、`title:`、`source:`、`after:`、`before:`、裸词（标题/URL/简介/笔记 ILIKE）
- 忽略不报错：`list:`、`feed:`、`age:`、`is:tagged`、`is:inlist`、`is:broken`（本仓库无对应数据源）
- 匹配语义是 LIKE 而非 FTS/语义检索；`searchMode: "semantic" | "hybrid"` 直接 `BAD_REQUEST`

新增缺口时按第 4 节五步走；全部清零后 `verdict` 变 `IN_SYNC`，可推进基线。

## 4. 实现清单

每个 procedure 走完这五步：

1. **契约** — 若形状是新的，加 `src/contracts/<domain>.ts` 并导出 zod schema。
2. **实现** — 在对应 router 加 procedure，用 `protectedProcedure`（除非上游是 public）。
3. **测试** — `test/<domain>-trpc.test.ts`，覆盖客户端的确切调用形状（含 cursor、分页边界）。
4. **验证** — `npx tsc --noEmit`，然后 `rtk npx vitest run --max-workers=1 --no-isolate`（当前 360 个测试）。
5. **部署** — `rtk npx wrangler@4.128.0 deploy --strict`，再用浏览器/curl 实测该 procedure。

## 5. 兼容性语义

理解这几条能避免过度反应：

- **客户端调用面 = 兼容性边界。** 客户端不调的 procedure，不实现也不影响用户。
- **上游保「新客户端 → 老服务端」**，方向是单向的。所以新客户端可能用新 procedure 打老服务端 → 这是唯一会崩的方向。
- **本仓库保「锁定客户端 ↔ 本仓库」**。锁定版本之外的客户端不承诺兼容，README 已声明。
- **上游内部 tRPC 无兼容性承诺**（维护者在 discussion #3122 明确说明）。schema 随时可能变，跟进是被动且持续的。

## 6. 常见误判

| 现象 | 是否要改 |
|---|---|
| `commitsBehind` 变大，`missingForClients` 为空 | 否。上游动了实现，未动客户端契约 |
| `protocolFilesChanged` 有文件，但都是 `.test.ts` | 否。测试变动不影响协议 |
| 上游新增 procedure，锁定客户端不调用 | 否。可选实现 |
| 上游改了我们已实现 procedure 的 schema | **是**。需比对输入输出形状是否仍匹配 |
| 上游删了我们实现的 procedure | 否（对锁定客户端无影响），但考虑保留以免破坏自有 dashboard |
