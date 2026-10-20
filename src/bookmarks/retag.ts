// 重试标签：把「打标签失败」或「从未打过标签」的书签重新入队到 enrichment 队列。
// 执行时由 queue consumer 读取用户当前保存的 LLM 配置（user_llm_selection +
// user_llm_config），因此换模型后重试即用新模型处理，无需回填任何模型字段。
import { parseQueueMessage } from "../queue/contracts.js";

// 与 src/queue/cron.ts 保持一致的发送方视图，便于测试注入 mock。
export interface EnrichmentSender {
  send: (payload: unknown, options?: { delaySeconds?: number }) => Promise<unknown>;
}

export interface RetryableTaggingBookmark {
  id: string;
  canonicalUrl: string;
}

export interface RequeueOutcome {
  /** 已创建新 job 并成功入队（tagging_status 置回 pending）。 */
  requeued: boolean;
  /** 该书签已有活跃 job（pending/running/retry_wait），无需重复入队。 */
  skipped: boolean;
}

export interface RetryableTaggingCount {
  total: number;
  /** tagging_status='failure'：尝试过且失败。 */
  failed: number;
  /** tagging_status IS NULL：从来没有进过打标签流程（例如导入时源站就没有标签）。 */
  neverTagged: number;
  /** tagging_status='pending' 但没有任何活跃 job：卡死状态，没人会再处理它，面板会一直转圈。 */
  stuck: number;
}

// 可重试范围：
// 1) failure —— 尝试过且失败；
// 2) NULL —— 从未打过标签（面板上连徽标都没有，也没用 enrichment_jobs 记录）；
// 3) pending 但无活跃 job —— job 已终态（success/dead）而书签状态没跟上，卡在「标签生成中」。
// 三种都是「本该有标签却拿不到」的状态；pending 那类必须排除有活跃 job 的，否则会重复入队。
const RETRYABLE_WHERE = `user_id = ?
  AND (
    tagging_status = 'failure'
    OR tagging_status IS NULL
    OR (
      tagging_status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM enrichment_jobs j
        WHERE j.bookmark_id = bookmarks.id AND j.status IN ('pending', 'running', 'retry_wait')
      )
    )
  )`;

/** 统计当前用户可重试的书签数量与构成（面板按钮徽标用）。 */
export async function countRetryableTagging(
  db: D1Database,
  userId: string,
): Promise<RetryableTaggingCount> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN tagging_status = 'failure' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN tagging_status IS NULL THEN 1 ELSE 0 END) AS never_tagged,
        SUM(CASE WHEN tagging_status = 'pending' THEN 1 ELSE 0 END) AS stuck
       FROM bookmarks WHERE ${RETRYABLE_WHERE}`,
    )
    .bind(userId)
    .first<{ total: number; failed: number | null; never_tagged: number | null; stuck: number | null }>();
  return {
    total: row?.total ?? 0,
    failed: row?.failed ?? 0,
    neverTagged: row?.never_tagged ?? 0,
    stuck: row?.stuck ?? 0,
  };
}

/** 列出当前用户可重试的书签（快照，按创建时间稳定排序）。 */
export async function listRetryableTagging(
  db: D1Database,
  userId: string,
): Promise<RetryableTaggingBookmark[]> {
  const rows = await db
    .prepare(`SELECT id, canonical_url FROM bookmarks WHERE ${RETRYABLE_WHERE} ORDER BY created_at ASC, id ASC`)
    .bind(userId)
    .all<{ id: string; canonical_url: string }>();
  return (rows.results ?? []).map((r) => ({ id: r.id, canonicalUrl: r.canonical_url }));
}

export interface TaggingFailure {
  code: string | null;
  message: string;
  at: Date;
}

/** 最近一次打标签失败的原因（面板上直接展示，避免只有「标签失败」四个字无从排查）。 */
export async function latestTaggingFailure(
  db: D1Database,
  userId: string,
): Promise<TaggingFailure | null> {
  const row = await db
    .prepare(
      `SELECT j.last_error_code, j.last_error_message, j.updated_at
       FROM enrichment_jobs j JOIN bookmarks b ON b.id = j.bookmark_id
       WHERE j.user_id = ? AND b.tagging_status = 'failure' AND j.last_error_message IS NOT NULL
       ORDER BY j.updated_at DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ last_error_code: string | null; last_error_message: string; updated_at: number }>();
  if (!row) return null;
  return {
    code: row.last_error_code,
    message: row.last_error_message,
    at: new Date(row.updated_at),
  };
}

/**
 * 单个书签重新入队：
 * 1) 插入新的 enrichment_jobs（attempt=0，status='pending'）；
 *    唯一索引 enrichment_jobs_one_active 只覆盖活跃状态，失败书签的旧 job 已是
 *    终态（success/dead），故用 NOT EXISTS 守卫防重复入队。
 * 2) 发送队列消息（schema 与大小校验复用 parseQueueMessage）。
 * 3) 入队成功后才把 tagging_status 置回 'pending'，让面板回到「标签生成中」。
 * 入队失败则删除刚插入的 job 并保留原状态，保证可再次重试。
 */
export async function requeueFailedTagging(
  db: D1Database,
  queue: EnrichmentSender,
  userId: string,
  bookmark: RetryableTaggingBookmark,
): Promise<RequeueOutcome> {
  const now = Date.now();
  const jobId = crypto.randomUUID();

  const insert = await db
    .prepare(
      `INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'pending', 0, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM enrichment_jobs
         WHERE bookmark_id = ? AND status IN ('pending', 'running', 'retry_wait')
       )`,
    )
    .bind(jobId, bookmark.id, userId, bookmark.canonicalUrl, now, now, bookmark.id)
    .run();

  if (insert.meta.changes === 0) return { requeued: false, skipped: true };

  const payload = parseQueueMessage({
    bookmarkId: bookmark.id,
    jobId,
    urlSnapshot: bookmark.canonicalUrl,
    requestedAt: new Date(now).toISOString(),
  });

  try {
    await queue.send(payload);
  } catch (err) {
    // 回滚：不留孤儿 job，tagging_status 保持 'failure' 以便用户再次重试
    await db.prepare("DELETE FROM enrichment_jobs WHERE id = ?").bind(jobId).run();
    console.error(
      JSON.stringify({
        event: "retry_tagging_enqueue_failed",
        bookmarkId: bookmark.id,
        jobId,
        error: String(err),
      }),
    );
    return { requeued: false, skipped: false };
  }

  await db
    .prepare(
      `UPDATE bookmarks SET tagging_status = 'pending'
       WHERE id = ? AND (tagging_status = 'failure' OR tagging_status = 'pending' OR tagging_status IS NULL)`,
    )
    .bind(bookmark.id)
    .run();

  return { requeued: true, skipped: false };
}
