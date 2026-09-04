import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseQueueMessage, type QueueMessage } from "../src/queue/contracts";
import { sha256Hex } from "../src/auth/api-key";
import { runCronInvocation } from "../src/queue/cron";
import { encryptSecret } from "../src/auth/secret-box";
import { handleEnrichmentBatch } from "../src/queue/consumer";
import worker from "../src/index";

const ADMIN_USER_ID = "user_q_admin";
const ADMIN_KEY_ID = "cafebabe1234567890ab";
const ADMIN_SECRET = "cafebabe1234567890abcdef12345678";
const ADMIN_KEY = `ak2_${ADMIN_KEY_ID}_${ADMIN_SECRET}`;

async function seedAdmin() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(ADMIN_USER_ID, "Q Admin", null, Date.now())
    .run();
  const hash = await sha256Hex(ADMIN_SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_q_admin", ADMIN_USER_ID, ADMIN_KEY_ID, hash, "q admin", Date.now())
    .run();
}

function makeMessage(jobId: string, bookmarkId: string, attempts: number) {
  const body = parseQueueMessage({
    bookmarkId,
    jobId,
    urlSnapshot: "https://example.com/probe",
    requestedAt: new Date().toISOString(),
  });
  return {
    id: `msg_${jobId}_${attempts}`,
    timestamp: new Date(),
    attempts,
    body,
  };
}

async function seedProbeJob(jobId: string, bookmarkId: string, probeMode = 1) {
  const url = `https://example.com/probe/${bookmarkId}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, 'api', 'pending', 'pending', ?, ?)",
  )
    .bind(bookmarkId, ADMIN_USER_ID, url, "Probe", Date.now(), Date.now())
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, probe_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
  )
    .bind(jobId, bookmarkId, ADMIN_USER_ID, url, probeMode, Date.now(), Date.now())
    .run();
}

async function dispatch(batch: ReturnType<typeof createMessageBatch>) {
  const ctx = createExecutionContext();
  await worker.queue(batch, env as unknown as Env);
  return { result: await getQueueResult(batch, ctx) };
}

describe("queue consumer 重试与状态迁移", () => {
  it("attempt 1 探针 → retry 30s + retry_wait", async () => {
    await seedAdmin();
    const jobId = "job_a1";
    const bookmarkId = "bm_a1";
    await seedProbeJob(jobId, bookmarkId);
    const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, 1)]);
    const { result } = await dispatch(batch);
    expect(result.retryMessages[0]?.msgId).toBe(`msg_${jobId}_1`);
    const ev = await env.DB.prepare("SELECT requested_delay_seconds FROM queue_probe_events WHERE job_id = ? AND kind = 'consumer_retry'").bind(jobId).first<{ requested_delay_seconds: number }>();
    expect(ev?.requested_delay_seconds).toBe(30);
    const job = await env.DB.prepare("SELECT status, attempt FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string; attempt: number }>();
    expect(job?.status).toBe("retry_wait");
    expect(job?.attempt).toBe(1);
  });

  it("attempt 2 → 300s，attempt 3 → 1800s", async () => {
    await seedAdmin();
    const delays: (number | undefined)[] = [];
    for (const [attempt, expected] of [
      [2, 300],
      [3, 1800],
    ] as const) {
      const jobId = `job_a${attempt}`;
      const bookmarkId = `bm_a${attempt}`;
      await seedProbeJob(jobId, bookmarkId);
      const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, attempt)]);
      const { result } = await dispatch(batch);
      const ev = await env.DB.prepare("SELECT requested_delay_seconds FROM queue_probe_events WHERE job_id = ? AND kind = 'consumer_retry'").bind(jobId).first<{ requested_delay_seconds: number }>();
      delays.push(ev?.requested_delay_seconds);
      expect(ev?.requested_delay_seconds).toBe(expected);
    }
    expect(delays).toEqual([300, 1800]);
  });

  it("attempt 4 → dead + tagging failure + DLQ（不 ack 不 retry）", async () => {
    await seedAdmin();
    const jobId = "job_a4";
    const bookmarkId = "bm_a4";
    await seedProbeJob(jobId, bookmarkId);
    const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, 4)]);
    await expect(worker.queue(batch, env as unknown as Env)).rejects.toThrow("PROBE_CONSUMER_FAILED");
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.ackAll).toBe(false);
    expect(result.retryMessages.length).toBe(0);
    const job = await env.DB.prepare("SELECT status, attempt FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string; attempt: number }>();
    expect(job?.status).toBe("dead");
    expect(job?.attempt).toBe(4);
    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?").bind(bookmarkId).first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("failure");
    const events = await env.DB.prepare("SELECT kind FROM queue_probe_events WHERE job_id = ?").bind(jobId).all<{ kind: string }>();
    expect(events.results.some((e) => e.kind === "consumer_failed")).toBe(true);
  });

  it("普通 job（probe_mode=0）成功消费 → success + 清空 lease", async () => {
    await seedAdmin();
    const jobId = "job_ok";
    const bookmarkId = "bm_ok";
    await seedProbeJob(jobId, bookmarkId, 0);
    const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, 1)]);
    const { result } = await dispatch(batch);
    expect(result.explicitAcks).toContain(`msg_${jobId}_1`);
    const job = await env.DB.prepare("SELECT status, lease_expires_at FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string; lease_expires_at: number | null }>();
    expect(job?.status).toBe("success");
    expect(job?.lease_expires_at).toBeNull();
  });

  it("幂等：已 success 的 job 直接 ack 不重复处理", async () => {
    await seedAdmin();
    const jobId = "job_idem";
    const bookmarkId = "bm_idem";
    await seedProbeJob(jobId, bookmarkId, 0);
    await env.DB.prepare("UPDATE enrichment_jobs SET status = 'success' WHERE id = ?").bind(jobId).run();
    const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, 1)]);
    const { result } = await dispatch(batch);
    expect(result.explicitAcks).toContain(`msg_${jobId}_1`);
    const job = await env.DB.prepare("SELECT status FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe("success");
  });

  it("普通 job + openrouter 配置 → 打标签写 tags/summary", async () => {
    await seedAdmin();
    const jobId = "job_llm";
    const bookmarkId = "bm_llm";
    await seedProbeJob(jobId, bookmarkId, 0);
    // 配置 openrouter LLM（真实加密 key）
    const encKey = await encryptSecret("sk-or-test", "test-key");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_llm_config (user_id, provider, base_url, api_key_enc, model, updated_at) VALUES (?, 'openrouter', 'https://openrouter.ai/api/v1', ?, 'anthropic/claude-3.5-sonnet', ?)",
    )
      .bind(ADMIN_USER_ID, encKey, Date.now())
      .run();
    // 注入 fake fetch 返回 OpenAI 格式
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tags: ["ai", "读书"], description: "测试摘要" }) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, 1)]);
    await handleEnrichmentBatch(env.DB, batch, { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env, { fetchImpl: fakeFetch });
    const job = await env.DB.prepare("SELECT status FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe("success");
    const bm = await env.DB.prepare("SELECT tagging_status, summary FROM bookmarks WHERE id = ?").bind(bookmarkId).first<{ tagging_status: string; summary: string | null }>();
    expect(bm?.tagging_status).toBe("success");
    expect(bm?.summary).toBe("测试摘要");
    const tags = await env.DB.prepare(
      "SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ?",
    )
      .bind(bookmarkId)
      .all<{ name: string }>();
    expect(tags.results.map((r) => r.name).sort()).toEqual(["ai", "读书"]);
  });

  it("普通 job + LLM 失败 → tagging failure 但 job success", async () => {
    await seedAdmin();
    const jobId = "job_llm_fail";
    const bookmarkId = "bm_llm_fail";
    await seedProbeJob(jobId, bookmarkId, 0);
    const encKey = await encryptSecret("sk-or-test", "test-key");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_llm_config (user_id, provider, base_url, api_key_enc, model, updated_at) VALUES (?, 'openrouter', 'https://openrouter.ai/api/v1', ?, 'anthropic/claude-3.5-sonnet', ?)",
    )
      .bind(ADMIN_USER_ID, encKey, Date.now())
      .run();
    const fakeFetch = async () => new Response("bad gateway", { status: 502 });
    const batch = createMessageBatch("karaclone-phase0-enrichment", [makeMessage(jobId, bookmarkId, 1)]);
    await handleEnrichmentBatch(env.DB, batch, { ...env, LLM_CONFIG_KEY: "test-key" } as unknown as Env, { fetchImpl: fakeFetch });
    const job = await env.DB.prepare("SELECT status FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe("success");
    const bm = await env.DB.prepare("SELECT tagging_status FROM bookmarks WHERE id = ?").bind(bookmarkId).first<{ tagging_status: string }>();
    expect(bm?.tagging_status).toBe("failure");
  });
});

describe("queue 探针接口", () => {
  it("POST /__phase0/queue/start 创建探针并返回 jobId", async () => {
    await seedAdmin();
    const res = await SELF.fetch("https://example.com/__phase0/queue/start", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(typeof body.jobId).toBe("string");
    const job = await env.DB.prepare("SELECT probe_mode FROM enrichment_jobs WHERE id = ?").bind(body.jobId).first<{ probe_mode: number }>();
    expect(job?.probe_mode).toBe(1);
  });

  it("GET /__phase0/queue/:jobId 返回事件与状态", async () => {
    await seedAdmin();
    const jobId = "job_status";
    const bookmarkId = "bm_status";
    await seedProbeJob(jobId, bookmarkId);
    const res = await SELF.fetch(`https://example.com/__phase0/queue/${jobId}`, {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string; status: string; events: unknown[] };
    expect(body.jobId).toBe(jobId);
    expect(body.status).toBe("pending");
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("无 Bearer 拒绝", async () => {
    const res = await SELF.fetch("https://example.com/__phase0/queue/start", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("scheduled cron", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM cron_invocation_jobs").run();
    await env.DB.prepare("DELETE FROM cron_invocations").run();
    await env.DB.prepare("DELETE FROM enrichment_jobs").run();
    await env.DB.prepare("DELETE FROM bookmarks").run();
  });

  async function seedPendingJob(jobId: string, bookmarkId: string, createdAt: number, failNext = 0) {
    const url = `https://example.com/cron/${bookmarkId}`;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, 'api', 'pending', 'pending', ?, ?)",
    )
      .bind(bookmarkId, ADMIN_USER_ID, url, "Cron", Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, probe_mode, fail_next_cron_send, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)",
    )
      .bind(jobId, bookmarkId, ADMIN_USER_ID, url, failNext, createdAt, createdAt)
      .run();
  }

  function fakeQueue() {
    const sent: { payload: unknown; options?: { delaySeconds?: number } }[] = [];
    return {
      sent,
      send: async (payload: unknown, options?: { delaySeconds?: number }) => {
        if (options && options.delaySeconds !== undefined && options.delaySeconds > 86400) {
          throw new Error("INVALID_DELAY_SECONDS");
        }
        sent.push({ payload, options });
      },
    };
  }

  it("少于 5 分钟的 pending job 不投", async () => {
    await seedAdmin();
    const jobId = "job_fresh";
    await seedPendingJob(jobId, "bm_fresh", Date.now());
    const q = fakeQueue();
    const result = await runCronInvocation(env.DB, q, true);
    expect(result.selectedCount).toBe(0);
    expect(q.sent.length).toBe(0);
  });

  it("12 条乱序候选按 created_at ASC, id ASC 选前 10", async () => {
    await seedAdmin();
    const base = Date.now() - 10 * 60 * 1000;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const jobId = `job_cron_${String(i).padStart(2, "0")}`;
      const bmId = `bm_cron_${String(i).padStart(2, "0")}`;
      // 乱序 created_at：i 为 0..11，created_at 用 (11-i) 制造逆序
      await seedPendingJob(jobId, bmId, base + (11 - i) * 1000);
      ids.push(jobId);
    }
    const q = fakeQueue();
    const result = await runCronInvocation(env.DB, q, true);
    expect(result.selectedCount).toBe(10);
    expect(result.sentCount).toBe(10);
    // 按 created_at ASC 应为 job_cron_11..job_cron_02
    const sentJobIds = q.sent.map((s) => {
      const p = s.payload;
      if (p && typeof p === "object" && "jobId" in p) return String(p.jobId);
      return "";
    });
    expect(sentJobIds).toEqual([
      "job_cron_11", "job_cron_10", "job_cron_09", "job_cron_08", "job_cron_07",
      "job_cron_06", "job_cron_05", "job_cron_04", "job_cron_03", "job_cron_02",
    ]);
  });

  it("payload 精确四字段且 < 2KB", async () => {
    await seedAdmin();
    const jobId = "job_payload";
    await seedPendingJob(jobId, "bm_payload", Date.now() - 10 * 60 * 1000);
    const q = fakeQueue();
    await runCronInvocation(env.DB, q, true);
    expect(q.sent.length).toBe(1);
    const payload = q.sent[0]!.payload;
    if (!payload || typeof payload !== "object") throw new Error("payload not object");
    expect(Object.keys(payload).sort()).toEqual(["bookmarkId", "jobId", "requestedAt", "urlSnapshot"]);
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(bytes).toBeLessThan(2048);
  });

  it("fail_next_cron_send=1 时第一次用非法 delay 86401 被拒 → pending + 标记清除", async () => {
    await seedAdmin();
    const jobId = "job_illegal";
    await seedPendingJob(jobId, "bm_illegal", Date.now() - 10 * 60 * 1000, 1);
    const q = fakeQueue();
    const result = await runCronInvocation(env.DB, q, true);
    expect(result.failedCount).toBe(1);
    expect(q.sent.length).toBe(0);
    const job = await env.DB.prepare("SELECT status, fail_next_cron_send, enqueued_at FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string; fail_next_cron_send: number; enqueued_at: string | null }>();
    expect(job?.status).toBe("pending");
    expect(job?.fail_next_cron_send).toBe(0);
    expect(job?.enqueued_at).toBeNull();
  });

  it("标记清除后下一次调用无 option 且成功", async () => {
    await seedAdmin();
    const jobId = "job_retry_ok";
    await seedPendingJob(jobId, "bm_retry_ok", Date.now() - 10 * 60 * 1000, 1);
    const q = fakeQueue();
    await runCronInvocation(env.DB, q, true);
    expect(q.sent.length).toBe(0);
    // 第二次：标记已清除，无 option 成功
    const result2 = await runCronInvocation(env.DB, q, true);
    expect(result2.sentCount).toBe(1);
    expect(q.sent[0]?.options).toBeUndefined();
  });

  it("非 capture 模式即使残留标记也不用非法 option", async () => {
    await seedAdmin();
    const jobId = "job_nocap";
    await seedPendingJob(jobId, "bm_nocap", Date.now() - 10 * 60 * 1000, 1);
    const q = fakeQueue();
    const result = await runCronInvocation(env.DB, q, false);
    expect(result.sentCount).toBe(1);
    expect(q.sent[0]?.options).toBeUndefined();
  });

  it("普通发送失败仍 pending，不写 enqueued_at", async () => {
    await seedAdmin();
    const jobId = "job_fail";
    await seedPendingJob(jobId, "bm_fail", Date.now() - 10 * 60 * 1000);
    const q = {
      sent: [] as unknown[],
      send: async () => {
        throw new Error("SEND_FAILED");
      },
    };
    const result = await runCronInvocation(env.DB, q, true);
    expect(result.failedCount).toBe(1);
    const job = await env.DB.prepare("SELECT status, enqueued_at FROM enrichment_jobs WHERE id = ?").bind(jobId).first<{ status: string; enqueued_at: string | null }>();
    expect(job?.status).toBe("pending");
    expect(job?.enqueued_at).toBeNull();
  });

  it("非 pending job 不投", async () => {
    await seedAdmin();
    const jobId = "job_running";
    await seedPendingJob(jobId, "bm_running", Date.now() - 10 * 60 * 1000);
    await env.DB.prepare("UPDATE enrichment_jobs SET status = 'running' WHERE id = ?").bind(jobId).run();
    const q = fakeQueue();
    const result = await runCronInvocation(env.DB, q, true);
    expect(result.selectedCount).toBe(0);
    expect(q.sent.length).toBe(0);
  });
});
