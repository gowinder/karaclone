// 重试失败标签：单条/批量把 tagging_status='failure' 的书签重新入队到 enrichment 队列。
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { importsRouter } from "../src/trpc/routers/imports";
import { runRetryTaggingJob } from "../src/trpc/routers/import-fix";
import { handleImportBatch } from "../src/queue/import-consumer";
import { handleEnrichmentBatch } from "../src/queue/consumer";
import { parseQueueMessage } from "../src/queue/contracts";
import { encryptSecret } from "../src/auth/secret-box";
import { sha256Hex } from "../src/auth/api-key";
import {
  countRetryableTagging,
  latestTaggingFailure,
  listRetryableTagging,
  requeueFailedTagging,
  type EnrichmentSender,
} from "../src/bookmarks/retag";

const USER_ID = "user_retry_tag";
const OTHER_USER_ID = "user_retry_other";
const KEY_ID = "retrytagkey000001";
const SECRET = "retrytagsecret00001";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Retry User", "retry@test.com", now)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(OTHER_USER_ID, "Other User", "other@test.com", now)
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)",
  )
    .bind("ak_row_retry_tag", USER_ID, KEY_ID, hash, "retry key", now)
    .run();
}

// 每个用例前清空本文件用户的全部数据，避免共享 D1 的跨用例污染
async function reset() {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM bookmark_tags WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id IN (?, ?))",
    ).bind(USER_ID, OTHER_USER_ID),
    env.DB.prepare("DELETE FROM enrichment_jobs WHERE user_id IN (?, ?)").bind(USER_ID, OTHER_USER_ID),
    env.DB.prepare("DELETE FROM bookmarks WHERE user_id IN (?, ?)").bind(USER_ID, OTHER_USER_ID),
    env.DB.prepare("DELETE FROM import_jobs WHERE user_id IN (?, ?)").bind(USER_ID, OTHER_USER_ID),
  ]);
}

async function seedBookmark(id: string, taggingStatus: string | null, userId = USER_ID) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, 'api', 'success', ?, ?, ?)",
  )
    .bind(id, userId, `https://retry.example.com/${id}`, "Retry " + id, taggingStatus, now, now)
    .run();
}

async function seedMaintenanceJob(jobId: string, status = "pending") {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO import_jobs (id, user_id, source_url, email, api_key_enc, kind, status, total, imported, skipped, failed, processed, error, created_at, updated_at) VALUES (?, ?, '', '', '', 'retry-tagging', ?, 0, 0, 0, 0, 0, NULL, ?, ?)",
  )
    .bind(jobId, USER_ID, status, now, now)
    .run();
}

// 给某条书签挂一个指定状态的 enrichment job（用于构造「卡死」与「在飞」两种情况）
async function seedStuckJob(bookmarkId: string, jobId: string, status: string) {
  const bm = await env.DB.prepare("SELECT canonical_url FROM bookmarks WHERE id = ?")
    .bind(bookmarkId)
    .first<{ canonical_url: string }>();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, probe_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
  )
    .bind(jobId, bookmarkId, USER_ID, bm?.canonical_url ?? "https://retry.example.com/x", status, now, now)
    .run();
}

function makeQueue(impl?: (payload: unknown) => Promise<void>) {
  const calls: unknown[] = [];
  const queue: EnrichmentSender = {
    send: async (payload: unknown) => {
      calls.push(payload);
      if (impl) await impl(payload);
    },
  };
  return { calls, queue };
}

async function caller(queue: EnrichmentSender | null = null) {
  const req = new Request("https://example.com/trpc/", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
  const ctx = await createContext({
    env: {
      ...env,
      LLM_CONFIG_KEY: "test-key",
      ...(queue ? { ENRICHMENT_QUEUE: queue } : {}),
    } as unknown as Env,
    req,
    executionCtx: {} as ExecutionContext,
  });
  return appRouter.createCaller(ctx);
}

describe("retag 助手：统计与列出可重试书签", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  it("范围 = failure + 从未打过标签(null) + 卡死 pending；success 与活跃 pending 不算", async () => {
    await seedBookmark("bm_rt_f1", "failure");
    await seedBookmark("bm_rt_f2", "failure");
    await seedBookmark("bm_rt_s1", "success");
    await seedBookmark("bm_rt_null", null);
    // 卡死：pending 但对应 job 早已终态（success）→ 永远没人再处理它
    await seedBookmark("bm_rt_stuck", "pending");
    await seedStuckJob("bm_rt_stuck", "job_rt_stuck_done", "success");
    // 正常在飞：pending 且仍有活跃 job → 不该被重复入队
    await seedBookmark("bm_rt_inflight", "pending");
    await seedStuckJob("bm_rt_inflight", "job_rt_inflight", "running");

    const counts = await countRetryableTagging(env.DB, USER_ID);
    expect(counts).toEqual({ total: 4, failed: 2, neverTagged: 1, stuck: 1 });
    const retryable = await listRetryableTagging(env.DB, USER_ID);
    expect(retryable.map((b) => b.id).sort()).toEqual([
      "bm_rt_f1",
      "bm_rt_f2",
      "bm_rt_null",
      "bm_rt_stuck",
    ]);
    expect(retryable[0]!.canonicalUrl).toContain("https://retry.example.com/");
  });

  it("不统计其他用户的可重试书签", async () => {
    await seedBookmark("bm_rt_other", "failure", OTHER_USER_ID);
    await seedBookmark("bm_rt_other_null", null, OTHER_USER_ID);
    expect((await countRetryableTagging(env.DB, USER_ID)).total).toBe(0);
  });
});

describe("requeueFailedTagging：重新入队", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  it("插入 pending job + 发送队列消息 + tagging_status 置回 pending", async () => {
    await seedBookmark("bm_rt_q1", "failure");
    const { calls, queue } = makeQueue();

    const outcome = await requeueFailedTagging(env.DB, queue, USER_ID, {
      id: "bm_rt_q1",
      canonicalUrl: "https://retry.example.com/bm_rt_q1",
    });
    expect(outcome).toEqual({ requeued: true, skipped: false });

    expect(calls).toHaveLength(1);
    const msg = calls[0] as Record<string, unknown>;
    expect(Object.keys(msg).sort()).toEqual(["bookmarkId", "jobId", "requestedAt", "urlSnapshot"]);
    expect(msg.bookmarkId).toBe("bm_rt_q1");
    expect(msg.urlSnapshot).toBe("https://retry.example.com/bm_rt_q1");

    const job = await env.DB.prepare(
      "SELECT status, attempt, probe_mode, url_snapshot FROM enrichment_jobs WHERE id = ?",
    )
      .bind(msg.jobId as string)
      .first<{ status: string; attempt: number; probe_mode: number; url_snapshot: string }>();
    expect(job?.status).toBe("pending");
    expect(job?.attempt).toBe(0);
    expect(job?.probe_mode).toBe(0); // 普通 job，不会走探针重试分支
    expect(job?.url_snapshot).toBe("https://retry.example.com/bm_rt_q1");

    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?")
      .bind("bm_rt_q1")
      .first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("pending");
  });

  it("neverTagged 的书签也能重新入队（不是只有 failure）", async () => {
    await seedBookmark("bm_rt_q4", null); // 从未打过标签：面板上连徽标都没有
    const { calls, queue } = makeQueue();

    const outcome = await requeueFailedTagging(env.DB, queue, USER_ID, {
      id: "bm_rt_q4",
      canonicalUrl: "https://retry.example.com/bm_rt_q4",
    });
    expect(outcome).toEqual({ requeued: true, skipped: false });
    expect(calls).toHaveLength(1);

    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?")
      .bind("bm_rt_q4")
      .first<{ tagging_status: string | null }>();
    expect(bm?.tagging_status).toBe("pending"); // NULL → pending，面板回到「标签生成中」
  });

  it("已有活跃 job 时跳过，不重复入队", async () => {
    await seedBookmark("bm_rt_q2", "failure");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, created_at, updated_at) VALUES ('job_rt_active', 'bm_rt_q2', ?, 'https://retry.example.com/bm_rt_q2', 'running', 0, ?, ?)",
    )
      .bind(USER_ID, now, now)
      .run();
    const { calls, queue } = makeQueue();

    const outcome = await requeueFailedTagging(env.DB, queue, USER_ID, {
      id: "bm_rt_q2",
      canonicalUrl: "https://retry.example.com/bm_rt_q2",
    });
    expect(outcome).toEqual({ requeued: false, skipped: true });
    expect(calls).toHaveLength(0);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_jobs WHERE bookmark_id = ?")
      .bind("bm_rt_q2")
      .first<{ n: number }>();
    expect(n?.n).toBe(1); // 只有原有的活跃 job
  });

  it("发送失败时回滚 job 并保留 failure，可再次重试", async () => {
    await seedBookmark("bm_rt_q3", "failure");
    const { queue } = makeQueue(async () => {
      throw new Error("QUEUE_SEND_FAILED");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await requeueFailedTagging(env.DB, queue, USER_ID, {
      id: "bm_rt_q3",
      canonicalUrl: "https://retry.example.com/bm_rt_q3",
    });
    errSpy.mockRestore();

    expect(outcome).toEqual({ requeued: false, skipped: false });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM enrichment_jobs WHERE bookmark_id = ?")
      .bind("bm_rt_q3")
      .first<{ n: number }>();
    expect(n?.n).toBe(0); // 无孤儿 job，否则唯一索引会挡住下一次重试
    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?")
      .bind("bm_rt_q3")
      .first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("failure");
  });
});

describe("runRetryTaggingJob：批量重试维护任务", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  it("把全部失败书签重新入队并更新任务进度", async () => {
    await seedBookmark("bm_rt_j1", "failure");
    await seedBookmark("bm_rt_j2", "failure");
    await seedBookmark("bm_rt_j3", "failure");
    await seedBookmark("bm_rt_j4", null); // 从未打过标签
    await seedBookmark("bm_rt_ok", "success");
    await seedMaintenanceJob("job_rt_batch");
    const { calls, queue } = makeQueue();

    await runRetryTaggingJob(env.DB, "job_rt_batch", USER_ID, queue);

    expect(calls).toHaveLength(4);
    const job = await env.DB.prepare(
      "SELECT status, total, imported, skipped, failed, processed, error FROM import_jobs WHERE id = ?",
    )
      .bind("job_rt_batch")
      .first<{
        status: string;
        total: number;
        imported: number;
        skipped: number;
        failed: number;
        processed: number;
        error: string | null;
      }>();
    expect(job?.status).toBe("success");
    expect(job?.total).toBe(4);
    expect(job?.imported).toBe(4);
    expect(job?.skipped).toBe(0);
    expect(job?.failed).toBe(0);
    expect(job?.processed).toBe(4);
    expect(job?.error).toBeNull();

    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND tagging_status = 'pending'",
    )
      .bind(USER_ID)
      .first<{ n: number }>();
    expect(pending?.n).toBe(4); // 3 条失败 + 1 条从未打过标签被置回 pending，success 的不动
  });

  it("全部入队失败时任务置 failed 并记录原因", async () => {
    await seedBookmark("bm_rt_jf1", "failure");
    await seedMaintenanceJob("job_rt_allfail");
    const { queue } = makeQueue(async () => {
      throw new Error("QUEUE_DOWN");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runRetryTaggingJob(env.DB, "job_rt_allfail", USER_ID, queue);
    errSpy.mockRestore();

    const job = await env.DB.prepare("SELECT status, failed, error FROM import_jobs WHERE id = ?")
      .bind("job_rt_allfail")
      .first<{ status: string; failed: number; error: string | null }>();
    expect(job?.status).toBe("failed");
    expect(job?.failed).toBe(1);
    expect(job?.error).toContain("重新入队失败");
  });

  it("没有失败书签时任务正常结束且计数为 0", async () => {
    await seedBookmark("bm_rt_none", "success");
    await seedMaintenanceJob("job_rt_empty");
    const { calls, queue } = makeQueue();

    await runRetryTaggingJob(env.DB, "job_rt_empty", USER_ID, queue);

    expect(calls).toHaveLength(0);
    const job = await env.DB.prepare("SELECT status, total, imported FROM import_jobs WHERE id = ?")
      .bind("job_rt_empty")
      .first<{ status: string; total: number; imported: number }>();
    expect(job?.status).toBe("success");
    expect(job?.total).toBe(0);
    expect(job?.imported).toBe(0);
  });
});

describe("handleImportBatch：retry-tagging 消息分发", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  it("retry-tagging 消息把失败书签重新入队（不解密 api_key_enc）", async () => {
    await seedBookmark("bm_rt_c1", "failure");
    await seedBookmark("bm_rt_c2", "failure");
    await seedMaintenanceJob("job_rt_consumer");
    // api_key_enc 故意填非法值：若 consumer 尝试解密会抛错
    await env.DB.prepare("UPDATE import_jobs SET api_key_enc = 'not-a-valid-encrypted' WHERE id = ?")
      .bind("job_rt_consumer")
      .run();

    const batch = {
      queue: "karaclone-phase0-import",
      messages: [
        {
          id: "msg_rt_consumer",
          attempts: 1,
          body: {
            jobId: "job_rt_consumer",
            userId: USER_ID,
            sourceUrl: "",
            apiKeyEnc: "not-a-valid-encrypted",
            kind: "retry-tagging",
          },
          ack: () => {},
          retry: () => {},
        },
      ],
    } as unknown as MessageBatch<unknown>;

    await handleImportBatch(env.DB, batch, { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env);

    const job = await env.DB.prepare("SELECT status, total, imported FROM import_jobs WHERE id = ?")
      .bind("job_rt_consumer")
      .first<{ status: string; total: number; imported: number }>();
    expect(job?.status).toBe("success");
    expect(job?.total).toBe(2);
    expect(job?.imported).toBe(2);

    const jobs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM enrichment_jobs WHERE user_id = ? AND status = 'pending'",
    )
      .bind(USER_ID)
      .first<{ n: number }>();
    expect(jobs?.n).toBe(2);
  });
});

describe("打标签失败必须留下原因", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  // 复刻真实事故：ollama-cloud 模型被下线返回 410，界面只有「标签失败」四个字，
  // 排查全靠猜。consumer 必须把状态码与原文落库（enrichment_jobs.last_error_*）。
  async function seedLlm(userId = USER_ID) {
    const now = Date.now();
    const apiKeyEnc = await encryptSecret("ollama-key-123", "test-key");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO user_llm_config (user_id, provider, base_url, api_key_enc, updated_at) VALUES (?, 'ollama-cloud', 'https://ollama.com', ?, ?)",
    )
      .bind(userId, apiKeyEnc, now)
      .run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO user_llm_selection (user_id, chat_provider, chat_model, embedding_provider, embedding_model, updated_at) VALUES (?, 'ollama-cloud', 'deepseek-v4.1-flash', NULL, NULL, ?)",
    )
      .bind(userId, now)
      .run();
  }

  async function seedEnrichmentJob(jobId: string, bookmarkId: string) {
    const bm = await env.DB.prepare("SELECT canonical_url FROM bookmarks WHERE id = ?")
      .bind(bookmarkId)
      .first<{ canonical_url: string }>();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, probe_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)",
    )
      .bind(jobId, bookmarkId, USER_ID, bm?.canonical_url ?? "https://retry.example.com/x", now, now)
      .run();
  }

  function enrichmentBatch(jobId: string, bookmarkId: string) {
    const body = parseQueueMessage({
      bookmarkId,
      jobId,
      urlSnapshot: "https://retry.example.com/" + bookmarkId,
      requestedAt: new Date().toISOString(),
    });
    return {
      queue: "karaclone-phase0-enrichment",
      messages: [{ id: `msg_${jobId}`, timestamp: new Date(), attempts: 1, body, ack: () => {}, retry: () => {} }],
    } as unknown as MessageBatch<unknown>;
  }

  it("模型 410 下线 → job 置 failure 并记录状态码与原文", async () => {
    await seedBookmark("bm_rt_e1", "pending");
    await seedLlm();
    await seedEnrichmentJob("job_rt_e1", "bm_rt_e1");

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: { message: "deepseek-v4-flash:0731 was retired at 2026-09-25" } }),
        { status: 410 },
      )) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleEnrichmentBatch(
      env.DB,
      enrichmentBatch("job_rt_e1", "bm_rt_e1"),
      { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env,
      { fetchImpl },
    );
    errSpy.mockRestore();

    const job = await env.DB.prepare(
      "SELECT status, last_error_code, last_error_message FROM enrichment_jobs WHERE id = ?",
    )
      .bind("job_rt_e1")
      .first<{ status: string; last_error_code: string | null; last_error_message: string | null }>();
    expect(job?.status).toBe("failure");
    expect(job?.last_error_code).toBe("410");
    expect(job?.last_error_message).toContain("retired");

    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?")
      .bind("bm_rt_e1")
      .first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("failure");

    // 面板据此展示原因
    const reason = await latestTaggingFailure(env.DB, USER_ID);
    expect(reason?.code).toBe("410");
    expect(reason?.message).toContain("retired");
  });

  it("解析失败（非纯 JSON）也会记录原因", async () => {
    await seedBookmark("bm_rt_e2", "pending");
    await seedLlm();
    await seedEnrichmentJob("job_rt_e2", "bm_rt_e2");

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "```json\n{\"tags\":[\"a\"],\"description\":null}\n```" } }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleEnrichmentBatch(
      env.DB,
      enrichmentBatch("job_rt_e2", "bm_rt_e2"),
      { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env,
      { fetchImpl },
    );
    errSpy.mockRestore();

    const job = await env.DB.prepare(
      "SELECT status, last_error_code, last_error_message FROM enrichment_jobs WHERE id = ?",
    )
      .bind("job_rt_e2")
      .first<{ status: string; last_error_code: string | null; last_error_message: string | null }>();
    expect(job?.status).toBe("failure");
    expect(job?.last_error_code).toBe("TAGGING_FAILED");
    expect(job?.last_error_message).toContain("not_pure_json_string");
  });

  it("成功后清空错误字段（重试成功不留旧原因）", async () => {
    await seedBookmark("bm_rt_e3", "pending");
    await seedLlm();
    await seedEnrichmentJob("job_rt_e3", "bm_rt_e3");
    await env.DB.prepare(
      "UPDATE enrichment_jobs SET last_error_code = '410', last_error_message = 'stale' WHERE id = ?",
    )
      .bind("job_rt_e3")
      .run();

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ tags: ["测试", "标签"], description: "描述" }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await handleEnrichmentBatch(
      env.DB,
      enrichmentBatch("job_rt_e3", "bm_rt_e3"),
      { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env,
      { fetchImpl },
    );

    const job = await env.DB.prepare(
      "SELECT status, last_error_code, last_error_message FROM enrichment_jobs WHERE id = ?",
    )
      .bind("job_rt_e3")
      .first<{ status: string; last_error_code: string | null; last_error_message: string | null }>();
    expect(job?.status).toBe("success");
    expect(job?.last_error_code).toBeNull();
    expect(job?.last_error_message).toBeNull();

    const bm = await env.DB.prepare("SELECT tagging_status, summary FROM bookmarks WHERE id = ?")
      .bind("bm_rt_e3")
      .first<{ tagging_status: string; summary: string | null }>();
    expect(bm?.tagging_status).toBe("success");
    expect(bm?.summary).toBe("描述");
  });
});

describe("imports.retryFailedTagging / failedTaggingCount", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  it("failedTaggingCount 返回失败数量与最近失败原因", async () => {
    await seedBookmark("bm_rt_api1", "failure");
    await seedBookmark("bm_rt_api2", "failure");
    await seedBookmark("bm_rt_api3", null);
    const c = await caller();
    const res = await c.imports.failedTaggingCount();
    expect(res.count).toBe(3);
    expect(res.failed).toBe(2);
    expect(res.neverTagged).toBe(1);
    expect(res.recentFailure).toBeNull(); // 没有 job 错误记录时为空
  });

  it("retryFailedTagging 建 kind=retry-tagging 任务并入队 IMPORT_QUEUE", async () => {
    await seedBookmark("bm_rt_api3", "failure");
    const sendMock = vi.fn(async () => {});
    const req = new Request("https://example.com/trpc/", {
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    const ctx = await createContext({
      env: { ...env, LLM_CONFIG_KEY: "test-key", IMPORT_QUEUE: { send: sendMock } } as unknown as Env,
      req,
      executionCtx: {} as ExecutionContext,
    });
    const c = importsRouter.createCaller(ctx);

    const job = await c.retryFailedTagging();
    expect(job.kind).toBe("retry-tagging");
    expect(job.status).toBe("pending");
    expect(job.total).toBe(1);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.kind).toBe("retry-tagging");
    expect(msg.jobId).toBe(job.id);

    const row = await env.DB.prepare("SELECT kind, status FROM import_jobs WHERE id = ?")
      .bind(job.id)
      .first<{ kind: string; status: string }>();
    expect(row?.kind).toBe("retry-tagging");
    expect(row?.status).toBe("pending");
  });

  it("没有可重试书签时拒绝创建任务", async () => {
    await seedBookmark("bm_rt_api4", "success");
    const c = await caller();
    await expect(c.imports.retryFailedTagging()).rejects.toThrow("当前没有需要重试标签的书签");
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM import_jobs WHERE user_id = ? AND kind = 'retry-tagging'",
    )
      .bind(USER_ID)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("bookmarks.retryTagging：单条重试", () => {
  beforeEach(async () => {
    await seed();
    await reset();
  });

  it("失败书签重新入队并把 taggingStatus 置为 pending", async () => {
    await seedBookmark("bm_rt_single", "failure");
    const { calls, queue } = makeQueue();
    const c = await caller(queue);

    expect(await c.bookmarks.retryTagging({ bookmarkId: "bm_rt_single" })).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    const msg = calls[0] as Record<string, unknown>;
    expect(msg.bookmarkId).toBe("bm_rt_single");

    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?")
      .bind("bm_rt_single")
      .first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("pending");

    const job = await env.DB.prepare("SELECT status FROM enrichment_jobs WHERE id = ?")
      .bind(msg.jobId as string)
      .first<{ status: string }>();
    expect(job?.status).toBe("pending");
  });

  it("卡死在生成中（job 已终态）的书签也能重试", async () => {
    await seedBookmark("bm_rt_stuck_api", "pending");
    await seedStuckJob("bm_rt_stuck_api", "job_rt_stuck_api", "success");
    const { calls, queue } = makeQueue();
    const c = await caller(queue);

    expect(await c.bookmarks.retryTagging({ bookmarkId: "bm_rt_stuck_api" })).toEqual({
      success: true,
    });
    expect(calls).toHaveLength(1);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM enrichment_jobs WHERE bookmark_id = ? AND status = 'pending'",
    )
      .bind("bm_rt_stuck_api")
      .first<{ n: number }>();
    expect(n?.n).toBe(1); // 新入队的 job
  });

  it("非失败状态的书签拒绝重试", async () => {
    await seedBookmark("bm_rt_notfailed", "success");
    const { calls, queue } = makeQueue();
    const c = await caller(queue);
    await expect(c.bookmarks.retryTagging({ bookmarkId: "bm_rt_notfailed" })).rejects.toThrow(
      "已经生成好了，无需重试",
    );
    expect(calls).toHaveLength(0);
  });

  it("其他用户的书签返回 NOT_FOUND", async () => {
    await seedBookmark("bm_rt_foreign", "failure", OTHER_USER_ID);
    const { queue } = makeQueue();
    const c = await caller(queue);
    await expect(c.bookmarks.retryTagging({ bookmarkId: "bm_rt_foreign" })).rejects.toThrow(
      "BOOKMARK_NOT_FOUND",
    );
  });

  it("入队失败时抛错且书签保持 failure", async () => {
    await seedBookmark("bm_rt_enqfail", "failure");
    const { queue } = makeQueue(async () => {
      throw new Error("QUEUE_DOWN");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await caller(queue);

    await expect(c.bookmarks.retryTagging({ bookmarkId: "bm_rt_enqfail" })).rejects.toThrow(
      "BOOKMARK_TAGGING_ENQUEUE_FAILED",
    );
    errSpy.mockRestore();

    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?")
      .bind("bm_rt_enqfail")
      .first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("failure");
  });
});
