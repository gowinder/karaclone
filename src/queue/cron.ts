// scheduled cron：选择创建超过 5 分钟、status='pending' 的最多 10 个 job，
// 逐条调用真实 Queue binding；payload 必须通过公共 schema 与大小校验。
import { parseQueueMessage } from "./contracts.js";

const MAX_JOBS_PER_INVOCATION = 10;
const MIN_AGE_MS = 5 * 60 * 1000;
const ILLEGAL_DELAY_SECONDS = 86401;

export type CronInvocationResult = {
  invocationId: string;
  selectedCount: number;
  sentCount: number;
  failedCount: number;
};

export async function runCronInvocation(
  db: D1Database,
  queue: { send: (payload: unknown, options?: { delaySeconds?: number }) => Promise<unknown> },
  captureEnabled: boolean,
): Promise<CronInvocationResult> {
  const invocationId = crypto.randomUUID();
  const now = Date.now();
  const cutoff = now - MIN_AGE_MS;

  const candidates = await db
    .prepare(
      `SELECT j.id, j.bookmark_id, j.url_snapshot, j.fail_next_cron_send, b.canonical_url
       FROM enrichment_jobs j
       JOIN bookmarks b ON b.id = j.bookmark_id
       WHERE j.status = 'pending' AND j.created_at <= ?
       ORDER BY j.created_at ASC, j.id ASC
       LIMIT ?`,
    )
    .bind(cutoff, MAX_JOBS_PER_INVOCATION)
    .all<{ id: string; bookmark_id: string; url_snapshot: string; fail_next_cron_send: number; canonical_url: string }>();

  const selected = candidates.results;
  await db
    .prepare(
      "INSERT INTO cron_invocations (invocation_id, scheduled_at, selected_count) VALUES (?, ?, ?)",
    )
    .bind(invocationId, new Date(now).toISOString(), selected.length)
    .run();

  let sentCount = 0;
  let failedCount = 0;

  for (const job of selected) {
    await db
      .prepare(
        "INSERT INTO cron_invocation_jobs (invocation_id, job_id, send_result) VALUES (?, ?, 'selected') ON CONFLICT(invocation_id, job_id) DO NOTHING",
      )
      .bind(invocationId, job.id)
      .run();

    const payload = parseQueueMessage({
      bookmarkId: job.bookmark_id,
      jobId: job.id,
      urlSnapshot: job.url_snapshot,
      requestedAt: new Date(now).toISOString(),
    });

    const useIllegalDelay = captureEnabled && job.fail_next_cron_send === 1;
    try {
      if (useIllegalDelay) {
        await queue.send(payload, { delaySeconds: ILLEGAL_DELAY_SECONDS });
        // 非法 option 意外成功 → fail-closed
        throw new Error("ILLEGAL_DELAY_ACCEPTED");
      }
      await queue.send(payload);
      await db
        .prepare(
          "UPDATE enrichment_jobs SET enqueued_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(new Date(now).toISOString(), now, job.id)
        .run();
      await db
        .prepare(
          "INSERT INTO cron_invocation_jobs (invocation_id, job_id, send_result, send_delay_seconds) VALUES (?, ?, 'sent', ?) ON CONFLICT(invocation_id, job_id) DO UPDATE SET send_result = 'sent', send_delay_seconds = excluded.send_delay_seconds, error_code = NULL",
        )
        .bind(invocationId, job.id, useIllegalDelay ? ILLEGAL_DELAY_SECONDS : null)
        .run();
      sentCount++;
    } catch (err) {
      const errorCode = err instanceof Error ? err.message : "UNKNOWN";
      await db
        .prepare(
          "UPDATE enrichment_jobs SET fail_next_cron_send = 0, updated_at = ? WHERE id = ?",
        )
        .bind(now, job.id)
        .run();
      await db
        .prepare(
          "INSERT INTO cron_invocation_jobs (invocation_id, job_id, send_result, send_delay_seconds, error_code) VALUES (?, ?, 'failed', ?, ?) ON CONFLICT(invocation_id, job_id) DO UPDATE SET send_result = 'failed', send_delay_seconds = excluded.send_delay_seconds, error_code = excluded.error_code",
        )
        .bind(invocationId, job.id, useIllegalDelay ? ILLEGAL_DELAY_SECONDS : null, errorCode)
        .run();
      failedCount++;
    }
  }

  await db
    .prepare(
      "UPDATE cron_invocations SET sent_count = ?, failed_count = ?, completed_at = ? WHERE invocation_id = ?",
    )
    .bind(sentCount, failedCount, new Date(now).toISOString(), invocationId)
    .run();

  return { invocationId, selectedCount: selected.length, sentCount, failedCount };
}
