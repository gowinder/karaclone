export interface NewJob {
  id: string;
  bookmarkId: string;
  userId: string;
  urlSnapshot: string;
}

export async function insertJob(db: D1Database, job: NewJob): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
    )
    .bind(job.id, job.bookmarkId, job.userId, job.urlSnapshot, now, now)
    .run();
}
