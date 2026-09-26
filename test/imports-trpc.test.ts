import { env } from "cloudflare:workers";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createContext } from "../src/trpc/context";
import { importsRouter, runImportJob } from "../src/trpc/routers/imports";
import { runFixJob, runRetagJob, runTranslateJob } from "../src/trpc/routers/import-fix";
import { encryptSecret } from "../src/auth/secret-box";
import { handleImportBatch } from "../src/queue/import-consumer";
import { sha256Hex } from "../src/auth/api-key";

const USER_ID = "user_imports";
const KEY_ID = "importskeyid0001";
const SECRET = "importssecret0001";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

// 模拟源实例的 tRPC 响应（superjson 格式，含 Date 序列化）
function trpcOk(json: unknown, datePaths: string[] = []): string {
  const values: Record<string, string[]> = {};
  const walk = (v: unknown, path: string): unknown => {
    if (datePaths.includes(path)) {
      values[path] = ["Date"];
      return v;
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
  };
  const walked = walk(json, "");
  return JSON.stringify([{ result: { data: { json: walked, meta: { values } } } }]);
}

const SOURCE_BOOKMARKS = [
  {
    id: "src_bm_1",
    title: "Source Bookmark One",
    url: "https://example.com/one",
    content: { type: "link", url: "https://example.com/one", title: "Real Title One" },
    note: "note one",
    summary: "summary one",
    archived: false,
    favourited: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    crawlStatus: "success",
    taggingStatus: "success",
    tags: [
      { id: "src_tag_1", name: "alpha", attachedBy: "human" },
      { id: "src_tag_2", name: "beta", attachedBy: "ai" },
    ],
  },
  {
    id: "src_bm_2",
    title: "Source Bookmark Two",
    url: "https://example.com/two",
    note: null,
    summary: null,
    archived: true,
    favourited: false,
    createdAt: "2024-02-02T00:00:00.000Z",
    crawlStatus: "failure",
    taggingStatus: null,
    tags: [{ id: "src_tag_2", name: "beta", attachedBy: "ai" }],
  },
];

let exchangeCalls = 0;
let listCalls = 0;
let fetchMock: ReturnType<typeof vi.fn>;
let sendMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("apiKeys.exchange")) {
      exchangeCalls++;
      return new Response(trpcOk({ key: "src_api_key_123" }), { status: 200 });
    }
    if (url.pathname.endsWith("bookmarks.getBookmarks")) {
      listCalls++;
      const raw = url.searchParams.get("input") ?? "{}";
      const input = JSON.parse(decodeURIComponent(raw));
      const archived = input["0"]?.json?.archived;
      const bms = SOURCE_BOOKMARKS.filter((b) => b.archived === archived);
      return new Response(
        trpcOk(
          { bookmarks: bms, nextCursor: null },
          ["bookmarks.0.createdAt", "bookmarks.1.createdAt"],
        ),
        { status: 200 },
      );
    }
    if (url.hostname === "ollama.com" && url.pathname.endsWith("chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tags: [{ en: "gamma", zh: "伽马" }, { en: "delta", zh: "德尔塔" }] }) } }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify([{ error: { json: { message: "not found" } } }]), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  sendMock = vi.fn(async () => {});
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Import User", "import@test.com", Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_imports", USER_ID, KEY_ID, hash, "imports key", Date.now())
    .run();
}

async function caller() {
  const req = new Request("https://example.com/trpc/imports.startImportJob", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
  const ctx = await createContext({
    env: {
      ...env,
      LLM_CONFIG_KEY: "test-key",
      IMPORT_QUEUE: { send: sendMock },
    } as unknown as Env,
    req,
    executionCtx: {} as ExecutionContext,
  });
  return importsRouter.createCaller(ctx);
}

async function seedJob(jobId: string, status = "pending", processed = 0, imported = 0, skipped = 0) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO import_jobs (id, user_id, source_url, email, api_key_enc, status, total, imported, skipped, failed, processed, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, NULL, ?, ?)",
  )
    .bind(jobId, USER_ID, "https://source.example.com", "import@test.com", "enc:key", status, imported, skipped, processed, now, now)
    .run();
}

describe("imports.startImportJob", () => {
  it("同步换 key 后创建任务并入队", async () => {
    await seed();
    const c = await caller();
    const job = await c.startImportJob({
      sourceUrl: "https://source.example.com",
      email: "import@test.com",
      password: "secret",
    });
    expect(job.status).toBe("pending");
    expect(job.sourceUrl).toBe("https://source.example.com");
    expect(exchangeCalls).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.jobId).toBe(job.id);
    expect(msg.userId).toBe(USER_ID);
    expect(msg.sourceUrl).toBe("https://source.example.com");
    expect(typeof msg.apiKeyEnc).toBe("string");
    expect(msg.apiKeyEnc).not.toContain("src_api_key_123"); // 加密存储

    const row = await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(job.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("源服务器不可达时抛错且不建任务", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network connection lost"));
    const c = await caller();
    await expect(
      c.startImportJob({
        sourceUrl: "https://unreachable.example.com",
        email: "import@test.com",
        password: "secret",
      }),
    ).rejects.toThrow();
    const rows = await env.DB.prepare("SELECT COUNT(*) as n FROM import_jobs WHERE source_url = ?").bind("https://unreachable.example.com").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("imports.listImportJobs / retryImportJob", () => {
  it("列出任务并按状态过滤重试", async () => {
    await seedJob("job_list_1", "success");
    await seedJob("job_list_2", "failed");
    const c = await caller();

    const jobs = await c.listImportJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    const failed = jobs.find((j) => j.id === "job_list_2");
    expect(failed?.status).toBe("failed");

    const retried = await c.retryImportJob({ jobId: "job_list_2" });
    expect(retried.status).toBe("pending");
    expect(sendMock).toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT status FROM import_jobs WHERE id = ?").bind("job_list_2").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("running 任务不可重试", async () => {
    await seedJob("job_running_1", "running");
    const c = await caller();
    await expect(c.retryImportJob({ jobId: "job_running_1" })).rejects.toThrow("IMPORT_JOB_ALREADY_RUNNING");
  });
});

describe("imports.fixImportedData", () => {
  it("对成功导入任务建 kind=fix 任务并入队", async () => {
    await seed();
    await seedJob("job_fix_src", "success");
    sendMock.mockClear();
    const c = await caller();
    const job = await c.fixImportedData({ jobId: "job_fix_src" });
    expect(job.kind).toBe("fix");
    expect(job.status).toBe("pending");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.kind).toBe("fix");
    expect(msg.jobId).toBe(job.id);
    const row = await env.DB.prepare("SELECT kind, status FROM import_jobs WHERE id = ?").bind(job.id).first<{ kind: string; status: string }>();
    expect(row?.kind).toBe("fix");
    expect(row?.status).toBe("pending");
  });

  it("running 任务不可修复", async () => {
    await seed();
    await seedJob("job_fix_running", "running");
    const c = await caller();
    await expect(c.fixImportedData({ jobId: "job_fix_running" })).rejects.toThrow("IMPORT_JOB_ALREADY_RUNNING");
  });
});

describe("runImportJob（后台执行）", () => {
  it("导入书签与标签并更新进度，重复导入全部跳过", async () => {
    await seed();
    const jobId = "job_run_1";
    await seedJob(jobId, "pending");

    await runImportJob(env.DB, jobId, USER_ID, "https://source.example.com", "src_api_key_123");

    // 进度更新
    const job = await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId).first<{
      status: string;
      total: number;
      imported: number;
      skipped: number;
      failed: number;
    }>();
    expect(job?.status).toBe("success");
    expect(job?.total).toBe(2);
    expect(job?.imported).toBe(2);
    expect(job?.skipped).toBe(0);
    expect(job?.failed).toBe(0);

    // 书签落库
    const bms = await env.DB.prepare("SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at").bind(USER_ID).all();
    expect(bms.results).toHaveLength(2);
    const bm1 = bms.results[0] as Record<string, unknown>;
    expect(bm1.canonical_url).toBe("https://example.com/one");
    expect(bm1.source).toBe("import");
    expect(bm1.archived).toBe(0);
    expect(bm1.favourited).toBe(1);
    expect(bm1.crawl_status).toBe("success");
    expect(bm1.tagging_status).toBe("success");
    expect(bm1.created_at).toBe(new Date("2024-01-01T00:00:00.000Z").getTime());
    const bm2 = bms.results[1] as Record<string, unknown>;
    expect(bm2.archived).toBe(1);
    expect(bm2.crawl_status).toBe("failure");
    expect(bm2.tagging_status).toBe("success"); // 有 beta 标签

    // 标签落库：alpha(human) + beta(ai)，beta 关联两条书签
    const tags = await env.DB.prepare("SELECT * FROM tags WHERE user_id = ? ORDER BY name").bind(USER_ID).all();
    expect(tags.results).toHaveLength(2);
    const tagNames = (tags.results as { name: string }[]).map((t) => t.name);
    expect(tagNames).toEqual(["alpha", "beta"]);

    const links = await env.DB.prepare(
      `SELECT bt.bookmark_id, t.name, bt.attached_by
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)
       ORDER BY t.name`,
    ).bind(USER_ID).all();
    expect(links.results).toHaveLength(3);
    const alpha = (links.results as { name: string; attached_by: string }[]).find((l) => l.name === "alpha");
    expect(alpha?.attached_by).toBe("human");
    const betas = (links.results as { name: string }[]).filter((l) => l.name === "beta");
    expect(betas).toHaveLength(2);

    // 第二次导入：全部跳过
    const jobId2 = "job_run_2";
    await seedJob(jobId2, "pending");
    await runImportJob(env.DB, jobId2, USER_ID, "https://source.example.com", "src_api_key_123");
    const job2 = await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId2).first<{
      status: string;
      imported: number;
      skipped: number;
    }>();
    expect(job2?.status).toBe("success");
    expect(job2?.imported).toBe(0);
    expect(job2?.skipped).toBe(2);
  });

  it("拉取失败时任务置 failed 并记录错误", async () => {
    const jobId = "job_fail_1";
    await seedJob(jobId, "pending");
    fetchMock.mockRejectedValueOnce(new Error("Network connection lost"));
    await expect(
      runImportJob(env.DB, jobId, USER_ID, "https://source.example.com", "src_api_key_123"),
    ).rejects.toThrow();
    const job = await env.DB.prepare("SELECT status, error FROM import_jobs WHERE id = ?").bind(jobId).first<{ status: string; error: string | null }>();
    expect(job?.status).toBe("failed");
    expect(job?.error).toBeTruthy();
  });

  it("断点续传：processed 后重跑只处理剩余条数", async () => {
    await seed();
    // 预置断点：processed=1（第一条已导入），imported=1
    const jobId = "job_resume_1";
    await seedJob(jobId, "pending", 1, 1, 0);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, 'import', 'success', 'success', ?, ?)",
    )
      .bind("bm_resume_1", USER_ID, "https://example.com/one", "Source Bookmark One", Date.now(), Date.now())
      .run();

    await runImportJob(env.DB, jobId, USER_ID, "https://source.example.com", "src_api_key_123");

    const job = await env.DB.prepare("SELECT status, total, imported, skipped, processed FROM import_jobs WHERE id = ?").bind(jobId).first<{
      status: string;
      total: number;
      imported: number;
      skipped: number;
      processed: number;
    }>();
    expect(job?.status).toBe("success");
    expect(job?.total).toBe(2);
    expect(job?.imported).toBe(1); // 断点前 1 + 本次 0（第二条已存在则 skipped）
    expect(job?.skipped).toBe(1); // 第二条已存在 → skipped
    expect(job?.processed).toBe(2);
  });

  it("自动重试：attempt 1 失败 → retry 30s，attempt 4 失败 → 置 failed", async () => {
    await seed();
    const jobId = "job_retry_1";
    await seedJob(jobId, "pending");

    // attempt 1：网络失败 → retry 30s，任务保持 pending/running，error 记录
    fetchMock.mockRejectedValueOnce(new Error("Network connection lost"));
    const batch1 = {
      queue: "karaclone-phase0-import",
      messages: [
        {
          id: "msg_retry_1",
          attempts: 1,
          body: { jobId, userId: USER_ID, sourceUrl: "https://source.example.com", apiKeyEnc: "enc:key" },
          ack: () => {},
          retry: (opts: { delaySeconds?: number }) => { retryOpts = opts; },
        },
      ],
    } as unknown as MessageBatch<unknown>;
    let retryOpts: { delaySeconds?: number } | undefined;
    await handleImportBatch(env.DB, batch1, { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env);
    expect(retryOpts?.delaySeconds).toBe(30);
    let job = await env.DB.prepare("SELECT status, error FROM import_jobs WHERE id = ?").bind(jobId).first<{ status: string; error: string | null }>();
    expect(job?.status).toBe("pending"); // 未置 failed，可续传
    expect(job?.error).toBeTruthy();

    // attempt 4：网络失败 → 置 failed
    fetchMock.mockRejectedValueOnce(new Error("Network connection lost"));
    const batch4 = {
      queue: "karaclone-phase0-import",
      messages: [
        {
          id: "msg_retry_4",
          attempts: 4,
          body: { jobId, userId: USER_ID, sourceUrl: "https://source.example.com", apiKeyEnc: "enc:key" },
          ack: () => {},
          retry: () => {},
        },
      ],
    } as unknown as MessageBatch<unknown>;
    await handleImportBatch(env.DB, batch4, { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env);
    job = await env.DB.prepare("SELECT status FROM import_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe("failed");
  });
});

describe("runFixJob（补标题 + 标签翻译）", () => {
  it("补标题：源 content.title 优先，fetchPageMeta 兜底；标签翻译成中文", async () => {
    await seed();
    // 预置：一条 title IS NULL 的导入书签（源有 content.title），一条无源标题（走 fetchPageMeta）
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, NULL, 'import', 'success', 'success', ?, ?)",
    )
      .bind("bm_fix_1", USER_ID, "https://fix.example.com/one", now, now)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, NULL, 'import', 'success', 'success', ?, ?)",
    )
      .bind("bm_fix_2", USER_ID, "https://fallback.example.com/page", now, now)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmark_links (id, url, title, description, favicon, crawled_at) VALUES (?, ?, NULL, NULL, NULL, ?)",
    )
      .bind("bm_fix_1", "https://fix.example.com/one", now)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmark_links (id, url, title, description, favicon, crawled_at) VALUES (?, ?, NULL, NULL, NULL, ?)",
    )
      .bind("bm_fix_2", "https://fallback.example.com/page", now)
      .run();

    // 预置英文标签 alpha/beta（alpha 关联 bm_fix_1）
    const tagAlpha = "tag_fix_gamma";
    const tagBeta = "tag_fix_delta";
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'gamma', ?)")
      .bind(tagAlpha, USER_ID, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'delta', ?)")
      .bind(tagBeta, USER_ID, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, 'ai', ?)")
      .bind("bm_fix_1", tagAlpha, now)
      .run();

    // LLM 配置（ollama-cloud）
    const apiKeyEnc = await encryptSecret("llm-key-123", "test-key");
    await env.DB.prepare("INSERT OR IGNORE INTO user_llm_config (user_id, provider, base_url, api_key_enc, updated_at) VALUES (?, 'ollama-cloud', 'https://ollama.com', ?, ?)")
      .bind(USER_ID, apiKeyEnc, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO user_llm_selection (user_id, chat_provider, chat_model, embedding_provider, embedding_model, updated_at) VALUES (?, 'ollama-cloud', 'deepseek-v4-flash:0731', NULL, NULL, ?)")
      .bind(USER_ID, now)
      .run();

    // fetchPageMeta 兜底：fallback 页面返回 HTML
    fetchMock.mockReset(); // 清空先前测试泄漏的 mockRejectedValueOnce
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("apiKeys.exchange")) {
        return new Response(trpcOk({ key: "src_api_key_123" }), { status: 200 });
      }
      if (url.pathname.endsWith("bookmarks.getBookmarks")) {
        const raw = url.searchParams.get("input") ?? "{}";
        const input2 = JSON.parse(decodeURIComponent(raw));
        const archived = input2["0"]?.json?.archived;
        const bms = SOURCE_BOOKMARKS.filter((b) => b.archived === archived);
        const fixBms = bms.map((b) =>
          b.url === "https://example.com/one"
            ? { ...b, url: "https://fix.example.com/one", content: { type: "link", url: "https://fix.example.com/one", title: "Real Title One" } }
            : b,
        );
        return new Response(
          trpcOk({ bookmarks: fixBms, nextCursor: null }, ["bookmarks.0.createdAt", "bookmarks.1.createdAt"]),
          { status: 200 },
        );
      }
      if (url.hostname === "ollama.com" && url.pathname.endsWith("chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ tags: [{ en: "gamma", zh: "伽马" }, { en: "delta", zh: "德尔塔" }] }) } }],
          }),
          { status: 200 },
        );
      }
      if (url.hostname === "fallback.example.com") {
        return new Response("<html><head><title>Fallback Title</title></head><body></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(JSON.stringify([{ error: { json: { message: "not found" } } }]), { status: 404 });
    });

    const jobId = "job_fix_1";
    await seedJob(jobId, "pending");
    await runFixJob(env.DB, jobId, USER_ID, "https://source.example.com", "src_api_key_123", {
      ...env,
      LLM_CONFIG_KEY: "test-key",
    } as unknown as Env);

    // 标题：bm_fix_1 用源 content.title，bm_fix_2 用 fetchPageMeta
    const jobDbg = await env.DB.prepare("SELECT status, imported, skipped, failed, error FROM import_jobs WHERE id = ?").bind(jobId).first<{ status: string; imported: number; skipped: number; failed: number; error: string | null }>();
    expect(jobDbg?.status).toBe("success");
    expect(jobDbg?.imported).toBe(2);
    const bm1 = await env.DB.prepare("SELECT title FROM bookmarks WHERE id = ?").bind("bm_fix_1").first<{ title: string | null }>();
    expect(bm1?.title).toBe("Real Title One");
    const bm2 = await env.DB.prepare("SELECT title FROM bookmarks WHERE id = ?").bind("bm_fix_2").first<{ title: string | null }>();
    expect(bm2?.title).toBe("Fallback Title");
    const link1 = await env.DB.prepare("SELECT title FROM bookmark_links WHERE id = ?").bind("bm_fix_1").first<{ title: string | null }>();
    expect(link1?.title).toBe("Real Title One");

    // 标签：alpha → 阿尔法，beta → 贝塔
    const tags = await env.DB.prepare("SELECT name FROM tags WHERE user_id = ? ORDER BY name").bind(USER_ID).all<{ name: string }>();
    const tagNames = tags.results?.map((t) => t.name) ?? [];
    expect(tagNames).toContain("伽马");
    expect(tagNames).toContain("德尔塔");
    expect(tagNames).not.toContain("gamma");
    expect(tagNames).not.toContain("delta");

    // 任务状态
    const job = await env.DB.prepare("SELECT status, imported, skipped, failed FROM import_jobs WHERE id = ?").bind(jobId).first<{
      status: string;
      imported: number;
      skipped: number;
      failed: number;
    }>();
    expect(job?.status).toBe("success");
    expect(job?.imported).toBe(2); // 补了 2 条标题
    expect(job?.skipped).toBe(2); // 翻译了 2 个标签
    expect(job?.failed).toBe(0);
  });

  it("LLM 未配置时跳过翻译，仅补标题", async () => {
    await seed();
    // 清掉前一个测试插入的 LLM 配置（共享 USER_ID）
    await env.DB.prepare("DELETE FROM user_llm_selection WHERE user_id = ?").bind(USER_ID).run();
    await env.DB.prepare("DELETE FROM user_llm_config WHERE user_id = ?").bind(USER_ID).run();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, NULL, 'import', 'success', 'success', ?, ?)",
    )
      .bind("bm_fix_3", USER_ID, "https://fix2.example.com/one", now, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'epsilon', ?)")
      .bind("tag_fix_3", USER_ID, now)
      .run();

    // fetchPageMeta 兜底：fix2 页面返回 HTML
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("bookmarks.getBookmarks")) {
        const raw = url.searchParams.get("input") ?? "{}";
        const input2 = JSON.parse(decodeURIComponent(raw));
        const archived = input2["0"]?.json?.archived;
        const bms = SOURCE_BOOKMARKS.filter((b) => b.archived === archived);
        const fixBms = bms.map((b) =>
          b.url === "https://example.com/one"
            ? { ...b, url: "https://fix2.example.com/one", content: { type: "link", url: "https://fix2.example.com/one", title: "Real Title One" } }
            : b,
        );
        return new Response(
          trpcOk({ bookmarks: fixBms, nextCursor: null }, ["bookmarks.0.createdAt", "bookmarks.1.createdAt"]),
          { status: 200 },
        );
      }
      if (url.hostname === "fix2.example.com") {
        return new Response("<html><head><title>Real Title One</title></head><body></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(JSON.stringify([{ error: { json: { message: "not found" } } }]), { status: 404 });
    });

    const jobId = "job_fix_2";
    await seedJob(jobId, "pending");
    // 无 LLM 配置（不插入 user_llm_selection）
    await runFixJob(env.DB, jobId, USER_ID, "https://source.example.com", "src_api_key_123", {
      ...env,
      LLM_CONFIG_KEY: "test-key",
    } as unknown as Env);

    const bm3 = await env.DB.prepare("SELECT title FROM bookmarks WHERE id = ?").bind("bm_fix_3").first<{ title: string | null }>();
    expect(bm3?.title).toBe("Real Title One");
    const tag = await env.DB.prepare("SELECT name FROM tags WHERE id = ?").bind("tag_fix_3").first<{ name: string }>();
    expect(tag?.name).toBe("epsilon"); // 未翻译
    const job = await env.DB.prepare("SELECT status, imported, skipped FROM import_jobs WHERE id = ?").bind(jobId).first<{
      status: string;
      imported: number;
      skipped: number;
    }>();
    expect(job?.status).toBe("success");
    expect(job?.imported).toBe(1);
    expect(job?.skipped).toBe(0);
  });
});

describe("imports.startMaintenanceJob", () => {
  it("retag：创建 kind=retag 任务并入队，复用最近导入任务占位字段", async () => {
    await seed();
    await seedJob("job_mtn_src", "success");
    sendMock.mockClear();
    const c = await caller();
    const job = await c.startMaintenanceJob({ kind: "retag" });
    expect(job.kind).toBe("retag");
    expect(job.status).toBe("pending");
    expect(job.sourceUrl).toBe("https://source.example.com");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.kind).toBe("retag");
    const row = await env.DB.prepare("SELECT kind, status FROM import_jobs WHERE id = ?").bind(job.id).first<{ kind: string; status: string }>();
    expect(row?.kind).toBe("retag");
    expect(row?.status).toBe("pending");
  });

  it("translate：创建 kind=translate 任务并入队", async () => {
    await seed();
    await seedJob("job_mtn_src2", "success");
    sendMock.mockClear();
    const c = await caller();
    const job = await c.startMaintenanceJob({ kind: "translate" });
    expect(job.kind).toBe("translate");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.kind).toBe("translate");
  });
});

describe("runRetagJob（重新统计标签数量）", () => {
  it("全量重算 tags.num_bookmarks 并更新进度", async () => {
    await seed();
    const now = Date.now();
    // 两个标签，各关联不同数量书签
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'retag_a', ?)")
      .bind("tag_retag_a", USER_ID, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'retag_b', ?)")
      .bind("tag_retag_b", USER_ID, now)
      .run();
    for (let i = 0; i < 3; i++) {
      const bmId = "bm_retag_" + i;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, NULL, 'import', 'success', 'success', ?, ?)",
      )
        .bind(bmId, USER_ID, "https://retag.example.com/" + i, now, now)
        .run();
      await env.DB.prepare("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, 'ai', ?)")
        .bind(bmId, "tag_retag_a", now)
        .run();
    }
    await env.DB.prepare("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, 'ai', ?)")
      .bind("bm_retag_0", "tag_retag_b", now)
      .run();

    // 人为制造漂移：把 num_bookmarks 改错
    await env.DB.prepare("UPDATE tags SET num_bookmarks = 99 WHERE id = 'tag_retag_a'").run();

    const jobId = "job_retag_1";
    await seedJob(jobId, "pending");
    await runRetagJob(env.DB, jobId, USER_ID);

    const a = await env.DB.prepare("SELECT num_bookmarks FROM tags WHERE id = ?").bind("tag_retag_a").first<{ num_bookmarks: number }>();
    expect(a?.num_bookmarks).toBe(3);
    const b = await env.DB.prepare("SELECT num_bookmarks FROM tags WHERE id = ?").bind("tag_retag_b").first<{ num_bookmarks: number }>();
    expect(b?.num_bookmarks).toBe(1);
    const job = await env.DB.prepare("SELECT status, imported, total, processed FROM import_jobs WHERE id = ?").bind(jobId).first<{
      status: string;
      imported: number;
      total: number;
      processed: number;
    }>();
    expect(job?.status).toBe("success");
    expect(job?.imported).toBeGreaterThanOrEqual(2); // 共享 USER_ID，含前序测试遗留标签
    expect(job?.total).toBe(job?.imported);
    expect(job?.processed).toBe(job?.imported);
  });
});

describe("runTranslateJob（标签翻译）", () => {
  it("仅翻译英文标签为中文，不补标题", async () => {
    await seed();
    const now = Date.now();
    // 清掉前序测试的 LLM 配置，重新插入
    await env.DB.prepare("DELETE FROM user_llm_selection WHERE user_id = ?").bind(USER_ID).run();
    await env.DB.prepare("DELETE FROM user_llm_config WHERE user_id = ?").bind(USER_ID).run();
    const apiKeyEnc = await encryptSecret("llm-key-123", "test-key");
    await env.DB.prepare("INSERT OR IGNORE INTO user_llm_config (user_id, provider, base_url, api_key_enc, updated_at) VALUES (?, 'ollama-cloud', 'https://ollama.com', ?, ?)")
      .bind(USER_ID, apiKeyEnc, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO user_llm_selection (user_id, chat_provider, chat_model, embedding_provider, embedding_model, updated_at) VALUES (?, 'ollama-cloud', 'deepseek-v4-flash:0731', NULL, NULL, ?)")
      .bind(USER_ID, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'gamma', ?)")
      .bind("tag_tr_1", USER_ID, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'delta', ?)")
      .bind("tag_tr_2", USER_ID, now)
      .run();

    // 翻译 mock：gamma → 伽马，delta → 德尔塔
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "ollama.com" && url.pathname.endsWith("chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ tags: [{ en: "gamma", zh: "伽马" }, { en: "delta", zh: "德尔塔" }] }) } }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([{ error: { json: { message: "not found" } } }]), { status: 404 });
    });

    const jobId = "job_tr_1";
    await seedJob(jobId, "pending");
    await runTranslateJob(env.DB, jobId, USER_ID, {
      ...env,
      LLM_CONFIG_KEY: "test-key",
    } as unknown as Env);

    const tags = await env.DB.prepare("SELECT name FROM tags WHERE user_id = ? ORDER BY name").bind(USER_ID).all<{ name: string }>();
    const names = tags.results?.map((t) => t.name) ?? [];
    expect(names).toContain("伽马");
    expect(names).toContain("德尔塔");
    expect(names).not.toContain("gamma");
    expect(names).not.toContain("delta");
    const job = await env.DB.prepare("SELECT status, imported, skipped, failed FROM import_jobs WHERE id = ?").bind(jobId).first<{
      status: string;
      imported: number;
      skipped: number;
      failed: number;
    }>();
    expect(job?.status).toBe("success");
    expect(job?.imported).toBe(0);
    expect(job?.skipped).toBe(2);
    expect(job?.failed).toBe(0);
  });
});

describe("handleImportBatch kind 分发", () => {
  it("retag 消息不解密 api_key_enc 直接执行", async () => {
    await seed();
    const now = Date.now();
    await env.DB.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, 'retag_c', ?)")
      .bind("tag_retag_c", USER_ID, now)
      .run();
    const jobId = "job_batch_retag";
    await seedJob(jobId, "pending");
    // api_key_enc 故意填非法值：若 consumer 尝试解密会抛错
    await env.DB.prepare("UPDATE import_jobs SET api_key_enc = 'not-a-valid-encrypted' WHERE id = ?").bind(jobId).run();

    const batch = {
      queue: "karaclone-phase0-import",
      messages: [
        {
          id: "msg_batch_retag",
          attempts: 1,
          body: { jobId, userId: USER_ID, sourceUrl: "", apiKeyEnc: "not-a-valid-encrypted", kind: "retag" },
          ack: () => {},
          retry: () => {},
        },
      ],
    } as unknown as MessageBatch<unknown>;
    await handleImportBatch(env.DB, batch, { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env);

    const job = await env.DB.prepare("SELECT status, imported FROM import_jobs WHERE id = ?").bind(jobId).first<{ status: string; imported: number }>();
    expect(job?.status).toBe("success");
    expect(job?.imported).toBeGreaterThanOrEqual(1); // 共享 USER_ID，含前序测试遗留标签
  });
});
