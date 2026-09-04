// Queue consumer：幂等、带租约条件更新拿执行权；探针 attempts 1-3 重试，
// attempt 4 置 dead 并抛错送 DLQ；普通 job 按用户 LLM 配置打标签/摘要。
import { parseQueueMessage } from "./contracts.js";
import { runOpenAiCompatible } from "../ai/openai-compatible.js";
import { decryptSecret } from "../auth/secret-box.js";
import { normalizeTags, parseTagResult } from "../ai/tag-schema.js";

const LEASE_MS = 20 * 60 * 1000;
const PROBE_DELAYS = [30, 300, 1800] as const;

export type QueueHandlerResult = {
  ackAll: boolean;
  retryMessages: { options?: { delaySeconds?: number } }[];
};

// 按用户 LLM 配置打标签/摘要：workers-ai 走 AI binding，openrouter/ollama-cloud 走 OpenAI 兼容。
// 未配置 LLM 或任何失败 → 抛错（调用方标记 failure，不阻塞队列）。
async function enrichBookmark(
  db: D1Database,
  env: Env | undefined,
  bookmarkId: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (!env) return;
  const bm = await db
    .prepare(
      "SELECT b.user_id, b.title, l.description FROM bookmarks b LEFT JOIN bookmark_links l ON l.id = b.id WHERE b.id = ?",
    )
    .bind(bookmarkId)
    .first<{ user_id: string; title: string | null; description: string | null }>();
  if (!bm) return;

  const sel = await db
    .prepare("SELECT chat_provider, chat_model FROM user_llm_selection WHERE user_id = ?")
    .bind(bm.user_id)
    .first<{ chat_provider: string; chat_model: string }>();
  if (!sel?.chat_model) return; // 未配置 LLM → 跳过
  const cfg = await db
    .prepare("SELECT base_url, api_key_enc FROM user_llm_config WHERE user_id = ? AND provider = ?")
    .bind(bm.user_id, sel.chat_provider)
    .first<{ base_url: string | null; api_key_enc: string | null }>();

  const title = bm.title ?? "";
  const description = bm.description ?? "";
  const systemPrompt =
    'Return 1-8 concise Chinese bookmark tags and a description or null. Respond with pure JSON: {"tags": [...], "description": ...}';

  let raw: unknown;
  if (sel.chat_provider === "workers-ai") {
    raw = await env.AI.run(sel.chat_model, {
      messages: [
        { role: "system", content: systemPrompt },
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
  } else {
    if (!cfg?.api_key_enc || !env.LLM_CONFIG_KEY) return;
    const apiKey = await decryptSecret(cfg.api_key_enc, env.LLM_CONFIG_KEY);
    const baseUrl =
      cfg.base_url ?? (sel.chat_provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ollama.com");
    raw = await runOpenAiCompatible({
      baseUrl,
      apiKey,
      model: sel.chat_model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${title}\n${description}` },
      ],
      fetchImpl,
    });
  }

  const parsed = parseTagResult(raw);
  if (!parsed.ok) throw new Error(`tag parse failed: ${parsed.error}`);
  const tags = normalizeTags(parsed.value.tags);
  if (tags.length === 0) throw new Error("no valid tags");

  const now = Date.now();
  // 第一步：确保 tags 存在（INSERT OR IGNORE 幂等）
  await db.batch(
    tags.map((t) =>
      db.prepare("INSERT OR IGNORE INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), bm.user_id, t, now),
    ),
  );
  // 第二步：按名查 tag id 并关联 bookmark_tags + 写 summary
  const ops: D1PreparedStatement[] = [];
  for (const t of tags) {
    const tag = await db
      .prepare("SELECT id FROM tags WHERE user_id = ? AND name = ?")
      .bind(bm.user_id, t)
      .first<{ id: string }>();
    if (tag) {
      ops.push(
        db.prepare("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, 'ai', ?)").bind(bookmarkId, tag.id, now),
      );
    }
  }
  ops.push(db.prepare("UPDATE bookmarks SET summary = ?, modified_at = ? WHERE id = ?").bind(parsed.value.description, now, bookmarkId));
  await db.batch(ops);
}

export async function handleEnrichmentBatch(
  db: D1Database,
  batch: MessageBatch<unknown>,
  env?: Env,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<QueueHandlerResult> {
  const retryMessages: { options?: { delaySeconds?: number } }[] = [];
  let ackAll = true;

  for (const message of batch.messages) {
    let msg: ReturnType<typeof parseQueueMessage>;
    try {
      msg = parseQueueMessage(message.body);
    } catch {
      // 无法解析的消息：ack 避免死循环（Phase 0 不重试坏消息）
      message.ack();
      continue;
    }

    const now = Date.now();
    const leaseExpiresAt = now + LEASE_MS;
    const jobId = msg.jobId;

    // 条件更新拿执行权
    const update = await db
      .prepare(
        `UPDATE enrichment_jobs
         SET status = 'running', attempt = ?, last_message_id = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND (
           status IN ('pending', 'retry_wait')
           OR (status = 'running' AND (
             (last_message_id = ? AND attempt < ?)
             OR lease_expires_at <= ?
           ))
         )`,
      )
      .bind(
        message.attempts,
        message.id,
        leaseExpiresAt,
        now,
        jobId,
        message.id,
        message.attempts,
        now,
      )
      .run();

    if (update.meta.changes === 0) {
      // 无执行权：job 已终态或仍持有有效租约 → 直接 ack
      message.ack();
      continue;
    }

    const job = await db
      .prepare("SELECT probe_mode, bookmark_id FROM enrichment_jobs WHERE id = ?")
      .bind(jobId)
      .first<{ probe_mode: number; bookmark_id: string }>();
    if (!job) {
      message.ack();
      continue;
    }

    if (job.probe_mode !== 1) {
      // 普通 job：按用户 LLM 配置打标签/摘要；失败不阻塞（标记 failure 继续 ack）
      let taggingStatus = "success";
      try {
        await enrichBookmark(db, env, job.bookmark_id, opts.fetchImpl);
      } catch {
        taggingStatus = "failure";
      }
      await db.batch([
        db
          .prepare(
            "UPDATE enrichment_jobs SET status = 'success', lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .bind(now, jobId),
        db
          .prepare("UPDATE bookmarks SET tagging_status = ? WHERE id = ?")
          .bind(taggingStatus, job.bookmark_id),
      ]);
      message.ack();
      continue;
    }

    // 探针 job
    if (message.attempts <= 3) {
      const delaySeconds = PROBE_DELAYS[message.attempts - 1]!;
      await db.batch([
        db
          .prepare(
            "UPDATE enrichment_jobs SET status = 'retry_wait', attempt = ?, next_retry_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .bind(message.attempts, now + delaySeconds * 1000, now, jobId),
        db
          .prepare(
            "INSERT INTO queue_probe_events (job_id, kind, attempt, requested_delay_seconds, occurred_at) VALUES (?, 'consumer_retry', ?, ?, ?)",
          )
          .bind(jobId, message.attempts, delaySeconds, new Date(now).toISOString()),
      ]);
      message.retry({ delaySeconds });
      retryMessages.push({ options: { delaySeconds } });
      ackAll = false;
    } else {
      // attempt 4：dead + tagging failure + 抛错送 DLQ
      await db.batch([
        db
          .prepare(
            "UPDATE enrichment_jobs SET status = 'dead', attempt = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .bind(message.attempts, now, jobId),
        db
          .prepare("UPDATE bookmarks SET tagging_status = 'failure' WHERE id = ?")
          .bind(job.bookmark_id),
        db
          .prepare(
            "INSERT INTO queue_probe_events (job_id, kind, attempt, occurred_at) VALUES (?, 'consumer_failed', ?, ?)",
          )
          .bind(jobId, message.attempts, new Date(now).toISOString()),
      ]);
      ackAll = false;
      throw new Error("PROBE_CONSUMER_FAILED");
    }
  }

  return { ackAll, retryMessages };
}
