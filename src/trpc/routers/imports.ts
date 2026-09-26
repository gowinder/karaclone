import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { canonicalizeUrl } from "../../url/canonicalize.js";
import { encryptSecret, decryptSecret } from "../../auth/secret-box.js";
import { runOpenAiCompatible } from "../../ai/openai-compatible.js";
import { fetchPageMeta } from "../../bookmarks/page-meta.js";

// 从其他 Karakeep 实例导入书签与标签（后台任务）。
// 流程：startImportJob 同步 exchange 换 key（立即验证凭据）→ 建 import_jobs 记录 →
// 入队 IMPORT_QUEUE → queue consumer 异步分页拉取并导入，逐条更新进度。
// 密码不落库；API key 加密存库供后台任务使用，任务完成后保留（可重试）。

const MAX_IMPORT_BOOKMARKS = 500;
const PAGE_SIZE = 100;
const CONCURRENCY = 5;

const zImportRequestSchema = z.object({
  sourceUrl: z.string().url().refine((u) => {
    try {
      const proto = new URL(u).protocol;
      return proto === "http:" || proto === "https:";
    } catch {
      return false;
    }
  }, { message: "Only http and https URLs are allowed" }),
  email: z.string().email(),
  password: z.string().min(1),
});

const zImportJobSchema = z.object({
  id: z.string(),
  sourceUrl: z.string(),
  email: z.string(),
  kind: z.enum(["import", "fix", "retag", "translate"]),
  status: z.enum(["pending", "running", "success", "failed"]),
  total: z.number(),
  imported: z.number(),
  skipped: z.number(),
  failed: z.number(),
  error: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

interface SourceTag {
  id: string;
  name: string;
  attachedBy: "ai" | "human";
}

interface SourceBookmark {
  id: string;
  title: string | null;
  url: string;
  note: string | null;
  summary: string | null;
  archived: boolean;
  favourited: boolean;
  createdAt: Date;
  crawlStatus: string | null;
  taggingStatus: string | null;
  tags: SourceTag[];
}

function serializeSuperjson(input: unknown): { json: unknown; meta: { values: Record<string, string[]> } } {
  const values: Record<string, string[]> = {};
  function walk(v: unknown, path: string): unknown {
    if (v instanceof Date) {
      values[path] = ["Date"];
      return v.toISOString();
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        o[k] = walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return o;
    }
    return v;
  }
  return { json: walk(input, ""), meta: { values } };
}

function deserializeSuperjson(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("json" in payload)) return payload;
  const json = (payload as { json: unknown }).json;
  const meta = (payload as { meta?: { values?: Record<string, string[]> } }).meta;
  if (!meta || !meta.values) return json;
  const values = meta.values;
  function walk(v: unknown, path: string): unknown {
    const types = values[path];
    if (types && types.includes("Date")) {
      return new Date(v as string | number);
    }
    if (Array.isArray(v)) {
      return v.map((x, i) => walk(x, `${path}.${i}`));
    }
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        o[k] = walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return o;
    }
    return v;
  }
  return walk(json, "");
}

export async function sourceTrpc(
  base: string,
  path: string,
  input: unknown,
  method: "GET" | "POST",
  apiKey: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  const serialized = serializeSuperjson(input || {});
  let url = `${base}/api/trpc/${path}?batch=1`;
  let body: string | undefined;
  if (method === "GET") {
    url += "&input=" + encodeURIComponent(JSON.stringify({ "0": serialized }));
  } else {
    body = JSON.stringify({ "0": serialized });
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("源服务器连接超时，请检查地址与网络");
    }
    throw new Error("无法连接源服务器");
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`源服务器响应异常（HTTP ${res.status}）：${bodyText.slice(0, 200)}`);
  }
  const data = (await res.json()) as Array<{
    error?: { json?: { message?: string }; message?: string };
    result?: { data?: { json?: unknown } };
  }>;
  const item = data[0];
  if (!item) throw new Error("源服务器响应格式异常");
  if (item.error) {
    const msg = item.error.json?.message || item.error.message || "源服务器请求失败";
    throw new Error(msg);
  }
  return deserializeSuperjson(item.result?.data);
}

export async function exchangeKey(
  base: string,
  email: string,
  password: string,
): Promise<string> {
  const result = (await sourceTrpc(
    base,
    "apiKeys.exchange",
    {
      keyName: `Import: (${Math.random().toString(36).slice(2, 8)})`,
      email,
      password,
    },
    "POST",
    null,
  )) as { key?: string };
  if (!result.key) throw new Error("源服务器登录失败");
  return result.key;
}

export async function fetchAllBookmarks(
  base: string,
  apiKey: string,
  opts: { includeContent?: boolean } = {},
): Promise<SourceBookmark[]> {
  const all = new Map<string, SourceBookmark>();
  for (const archived of [false, true]) {
    let cursor: unknown = null;
    for (let page = 0; page < 20; page++) {
      const input: Record<string, unknown> = {
        limit: PAGE_SIZE,
        includeContent: opts.includeContent ?? false,
        archived,
      };
      if (cursor) input.cursor = cursor;
      const data = (await sourceTrpc(
        base,
        "bookmarks.getBookmarks",
        input,
        "GET",
        apiKey,
        { timeoutMs: 20000 },
      )) as { bookmarks?: SourceBookmark[]; nextCursor?: unknown };
      const bookmarks = data.bookmarks ?? [];
      for (const bm of bookmarks) {
        const content = (bm as unknown as { content?: { url?: string } }).content;
        const url = content?.url || bm.url;
        if (url) all.set(url, { ...bm, url });
      }
      if (!data.nextCursor || bookmarks.length < PAGE_SIZE) break;
      cursor = data.nextCursor;
    }
  }
  return [...all.values()];
}

// 后台执行导入：更新 import_jobs 进度。由 queue consumer 调用。
// 断点续传：processed 记录已处理条数，网络失败重试时从断点继续。
export async function runImportJob(
  db: D1Database,
  jobId: string,
  userId: string,
  sourceUrl: string,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const base = sourceUrl.replace(/\/$/, "");
  const now = Date.now();
  await db
    .prepare("UPDATE import_jobs SET status = 'running', updated_at = ? WHERE id = ?")
    .bind(now, jobId)
    .run();

  let sourceBookmarks: SourceBookmark[];
  try {
    sourceBookmarks = await fetchAllBookmarks(base, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "拉取源书签失败";
    await db
      .prepare("UPDATE import_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(msg, Date.now(), jobId)
      .run();
    throw err;
  }

  const toImport = sourceBookmarks.slice(0, MAX_IMPORT_BOOKMARKS);
  await db
    .prepare("UPDATE import_jobs SET total = ?, updated_at = ? WHERE id = ?")
    .bind(toImport.length, Date.now(), jobId)
    .run();

  // 断点：跳过已处理条数（processed 在每批完成后更新），计数从断点前累计值继续
  const jobRow = await db
    .prepare("SELECT processed, imported, skipped, failed FROM import_jobs WHERE id = ?")
    .bind(jobId)
    .first<{ processed: number; imported: number; skipped: number; failed: number }>();
  const processed = Math.min(jobRow?.processed ?? 0, toImport.length);

  // 预取本用户已有 tag（按名查 id）
  const tagNameToId = new Map<string, string>();
  const existingTags = await db
    .prepare("SELECT id, name FROM tags WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; name: string }>();
  for (const t of existingTags.results ?? []) tagNameToId.set(t.name, t.id);

  let imported = jobRow?.imported ?? 0;
  let skipped = jobRow?.skipped ?? 0;
  let failed = jobRow?.failed ?? 0;

  const importOne = async (bm: SourceBookmark): Promise<void> => {
    const canonical = canonicalizeUrl(bm.url);
    const existing = await db
      .prepare("SELECT id FROM bookmarks WHERE user_id = ? AND canonical_url = ?")
      .bind(userId, canonical)
      .first<{ id: string }>();
    if (existing) {
      skipped++;
      return;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const createdAt = bm.createdAt instanceof Date && !isNaN(bm.createdAt.getTime())
      ? bm.createdAt.getTime()
      : now;
    const hasTags = (bm.tags ?? []).length > 0;
    const taggingStatus = hasTags ? "success" : null;
    const crawlStatus = bm.crawlStatus === "success" || bm.crawlStatus === "failure"
      ? bm.crawlStatus
      : null;

    const ops: D1PreparedStatement[] = [
      db.prepare(
        "INSERT INTO bookmarks (id, user_id, canonical_url, title, note, summary, archived, favourited, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        userId,
        canonical,
        bm.title ?? null,
        bm.note ?? null,
        bm.summary ?? null,
        bm.archived ? 1 : 0,
        bm.favourited ? 1 : 0,
        "import",
        crawlStatus,
        taggingStatus,
        createdAt,
        now,
      ),
      db.prepare(
        "INSERT INTO bookmark_links (id, url, title, description, favicon, crawled_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      ).bind(id, canonical, bm.title ?? null, createdAt),
    ];

    // 标签：查已有或新建，再关联
    for (const tag of bm.tags ?? []) {
      const name = tag.name.trim();
      if (!name) continue;
      let tagId = tagNameToId.get(name);
      if (!tagId) {
        tagId = crypto.randomUUID();
        tagNameToId.set(name, tagId);
        ops.push(
          db.prepare(
            "INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
          ).bind(tagId, userId, name, now),
        );
      }
      ops.push(
        db.prepare(
          "INSERT INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, ?, ?)",
        ).bind(id, tagId, tag.attachedBy === "human" ? "human" : "ai", now),
      );
    }

    await db.batch(ops);
    imported++;
  };

  // 分批并发导入，每批后更新进度（processed 记录断点）
  for (let i = processed; i < toImport.length; i += CONCURRENCY) {
    const batch = toImport.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(importOne));
    for (const r of results) {
      if (r.status === "rejected") failed++;
    }
    const done = Math.min(i + CONCURRENCY, toImport.length);
    await db
      .prepare("UPDATE import_jobs SET imported = ?, skipped = ?, failed = ?, processed = ?, updated_at = ? WHERE id = ?")
      .bind(imported, skipped, failed, done, Date.now(), jobId)
      .run();
  }

  await db
    .prepare("UPDATE import_jobs SET status = 'success', imported = ?, skipped = ?, failed = ?, processed = ?, updated_at = ? WHERE id = ?")
    .bind(imported, skipped, failed, toImport.length, Date.now(), jobId)
    .run();
}

// ---- 修复导入数据：补标题 + 标签翻译中文 ----

const zTagTranslationSchema = z.object({
  tags: z.array(z.object({ en: z.string(), zh: z.string() })).min(1).max(100),
});

const TRANSLATE_BATCH = 50;
const TRANSLATE_CONCURRENCY = 3;

// 判断标签是否含中文字符（含中文 → 视为已翻译，跳过）
function isChinese(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s);
}

function mapJobRow(row: {
  id: string;
  source_url: string;
  email: string;
  kind: string;
  status: string;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}) {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    email: row.email,
    kind: row.kind as "import" | "fix" | "retag" | "translate",
    status: row.status as "pending" | "running" | "success" | "failed",
    total: row.total,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    error: row.error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export const importsRouter = router({
  startImportJob: protectedProcedure
    .input(zImportRequestSchema)
    .output(zImportJobSchema)
    .mutation(async ({ input, ctx }) => {
      const secret = ctx.env.LLM_CONFIG_KEY;
      if (!secret) throw new Error("LLM_CONFIG_KEY not configured");

      const base = input.sourceUrl.replace(/\/$/, "");
      // 同步换 key：立即验证凭据与源可达性，失败则不入队
      const apiKey = await exchangeKey(base, input.email, input.password);
      const apiKeyEnc = await encryptSecret(apiKey, secret);

      const id = crypto.randomUUID();
      const now = Date.now();
      await ctx.env.DB.prepare(
        "INSERT INTO import_jobs (id, user_id, source_url, email, api_key_enc, kind, status, total, imported, skipped, failed, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'import', 'pending', 0, 0, 0, 0, NULL, ?, ?)",
      )
        .bind(id, ctx.user.id, base, input.email, apiKeyEnc, now, now)
        .run();

      await ctx.env.IMPORT_QUEUE.send({ jobId: id, userId: ctx.user.id, sourceUrl: base, apiKeyEnc });

      return mapJobRow({
        id,
        source_url: base,
        email: input.email,
        kind: "import",
        status: "pending",
        total: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        error: null,
        created_at: now,
        updated_at: now,
      });
    }),

  listImportJobs: protectedProcedure
    .output(z.array(zImportJobSchema))
    .query(async ({ ctx }) => {
      const rows = await ctx.env.DB.prepare(
        "SELECT id, source_url, email, kind, status, total, imported, skipped, failed, error, created_at, updated_at FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
      )
        .bind(ctx.user.id)
        .all<{
          id: string;
          source_url: string;
          email: string;
          kind: string;
          status: string;
          total: number;
          imported: number;
          skipped: number;
          failed: number;
          error: string | null;
          created_at: number;
          updated_at: number;
        }>();
      return (rows.results ?? []).map(mapJobRow);
    }),

  retryImportJob: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .output(zImportJobSchema)
    .mutation(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare(
        "SELECT id, user_id, source_url, email, api_key_enc, kind, status, total, imported, skipped, failed, error, created_at, updated_at FROM import_jobs WHERE id = ? AND user_id = ?",
      )
        .bind(input.jobId, ctx.user.id)
        .first<{
          id: string;
          user_id: string;
          source_url: string;
          email: string;
          api_key_enc: string;
          kind: string;
          status: string;
          total: number;
          imported: number;
          skipped: number;
          failed: number;
          error: string | null;
          created_at: number;
          updated_at: number;
        }>();
      if (!row) throw new Error("IMPORT_JOB_NOT_FOUND");
      if (row.status === "running" || row.status === "pending") {
        throw new Error("IMPORT_JOB_ALREADY_RUNNING");
      }
      const now = Date.now();
      await ctx.env.DB.prepare(
        "UPDATE import_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
      )
        .bind(now, row.id)
        .run();
      await ctx.env.IMPORT_QUEUE.send({
        jobId: row.id,
        userId: row.user_id,
        sourceUrl: row.source_url,
        apiKeyEnc: row.api_key_enc,
      });
      return mapJobRow({ ...row, status: "pending", error: null, updated_at: now });
    }),

  getImportJob: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .output(zImportJobSchema)
    .query(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare(
        "SELECT id, source_url, email, kind, status, total, imported, skipped, failed, error, created_at, updated_at FROM import_jobs WHERE id = ? AND user_id = ?",
      )
        .bind(input.jobId, ctx.user.id)
        .first<{
          id: string;
          source_url: string;
          email: string;
          kind: string;
          status: string;
          total: number;
          imported: number;
          skipped: number;
          failed: number;
          error: string | null;
          created_at: number;
          updated_at: number;
        }>();
      if (!row) throw new Error("IMPORT_JOB_NOT_FOUND");
      return mapJobRow(row);
    }),

  fixImportedData: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .output(zImportJobSchema)
    .mutation(async ({ input, ctx }) => {
      const secret = ctx.env.LLM_CONFIG_KEY;
      if (!secret) throw new Error("LLM_CONFIG_KEY not configured");

      const row = await ctx.env.DB.prepare(
        "SELECT id, user_id, source_url, email, api_key_enc, kind, status, total, imported, skipped, failed, error, created_at, updated_at FROM import_jobs WHERE id = ? AND user_id = ?",
      )
        .bind(input.jobId, ctx.user.id)
        .first<{
          id: string;
          user_id: string;
          source_url: string;
          email: string;
          api_key_enc: string;
          kind: string;
          status: string;
          total: number;
          imported: number;
          skipped: number;
          failed: number;
          error: string | null;
          created_at: number;
          updated_at: number;
        }>();
      if (!row) throw new Error("IMPORT_JOB_NOT_FOUND");
      if (row.status === "running" || row.status === "pending") {
        throw new Error("IMPORT_JOB_ALREADY_RUNNING");
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      await ctx.env.DB.prepare(
        "INSERT INTO import_jobs (id, user_id, source_url, email, api_key_enc, kind, status, total, imported, skipped, failed, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'fix', 'pending', 0, 0, 0, 0, NULL, ?, ?)",
      )
        .bind(id, ctx.user.id, row.source_url, row.email, row.api_key_enc, now, now)
        .run();

      await ctx.env.IMPORT_QUEUE.send({ jobId: id, userId: ctx.user.id, sourceUrl: row.source_url, apiKeyEnc: row.api_key_enc, kind: "fix" });

      return mapJobRow({
        id,
        source_url: row.source_url,
        email: row.email,
        kind: "fix",
        status: "pending",
        total: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        error: null,
        created_at: now,
        updated_at: now,
      });
    }),

  startMaintenanceJob: protectedProcedure
    .input(z.object({ kind: z.enum(["retag", "translate"]) }))
    .output(zImportJobSchema)
    .mutation(async ({ input, ctx }) => {
      // 维护任务不依赖源实例：复用最近一次终态导入任务的占位字段（无则空串）。
      // retag/translate 在 consumer 中不解密 api_key_enc，空串安全。
      const last = await ctx.env.DB.prepare(
        "SELECT source_url, email, api_key_enc FROM import_jobs WHERE user_id = ? AND kind = 'import' AND status IN ('success', 'failed') ORDER BY created_at DESC LIMIT 1",
      )
        .bind(ctx.user.id)
        .first<{ source_url: string; email: string; api_key_enc: string }>();

      const id = crypto.randomUUID();
      const now = Date.now();
      await ctx.env.DB.prepare(
        "INSERT INTO import_jobs (id, user_id, source_url, email, api_key_enc, kind, status, total, imported, skipped, failed, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, 0, NULL, ?, ?)",
      )
        .bind(id, ctx.user.id, last?.source_url ?? "", last?.email ?? "", last?.api_key_enc ?? "", input.kind, now, now)
        .run();

      await ctx.env.IMPORT_QUEUE.send({ jobId: id, userId: ctx.user.id, sourceUrl: last?.source_url ?? "", apiKeyEnc: last?.api_key_enc ?? "", kind: input.kind });

      return mapJobRow({
        id,
        source_url: last?.source_url ?? "",
        email: last?.email ?? "",
        kind: input.kind,
        status: "pending",
        total: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        error: null,
        created_at: now,
        updated_at: now,
      });
    }),
});
