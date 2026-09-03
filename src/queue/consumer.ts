// Queue consumer：幂等、带租约条件更新拿执行权；探针 attempts 1-3 重试，
// attempt 4 置 dead 并抛错送 DLQ；普通 job 记录成功消费证据。
import { parseQueueMessage } from "./contracts.js";

const LEASE_MS = 20 * 60 * 1000;
const PROBE_DELAYS = [30, 300, 1800] as const;

export type QueueHandlerResult = {
  ackAll: boolean;
  retryMessages: { options?: { delaySeconds?: number } }[];
};

export async function handleEnrichmentBatch(
  db: D1Database,
  batch: MessageBatch<unknown>,
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
      // 普通 job：Phase 0 仅记录一次成功消费证据
      await db
        .prepare(
          "UPDATE enrichment_jobs SET status = 'success', lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(now, jobId)
        .run();
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
