// DLQ consumer：写入 queue_probe_events(kind='dlq_received') 后 ack。
export async function handleDlqBatch(db: D1Database, batch: MessageBatch<unknown>): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as { jobId?: unknown };
    const jobId = typeof body?.jobId === "string" ? body.jobId : null;
    if (jobId) {
      await db
        .prepare(
          "INSERT INTO queue_probe_events (job_id, kind, attempt, occurred_at) VALUES (?, 'dlq_received', ?, ?)",
        )
        .bind(jobId, message.attempts, new Date().toISOString())
        .run();
    }
    message.ack();
  }
}
