// Queue 探针控制接口：POST /__phase0/queue/start 创建专用 bookmark/job（probe_mode=1）
// 并 enqueue 同一四字段消息；GET /__phase0/queue/:jobId 返回 job 与事件。
import { authenticateApiKey } from "../auth/api-key.js";
import { parseQueueMessage } from "../queue/contracts.js";

export async function handleQueueProbe(req: Request, env: Env): Promise<Response | null> {
  if (env.PHASE0_CAPTURE !== "true") return null;
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/__phase0/queue/")) return null;

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
  const user = await authenticateApiKey(env.DB, auth.slice("Bearer ".length).trim());
  if (!user) return new Response("Unauthorized", { status: 401 });

  if (req.method === "POST" && url.pathname.endsWith("/start")) {
    const jobId = crypto.randomUUID();
    const bookmarkId = crypto.randomUUID();
    const now = Date.now();
    const urlSnapshot = "https://example.com/phase0-queue-probe";
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, 'Queue Probe', 'api', 'pending', 'pending', ?, ?)",
        )
        .bind(bookmarkId, user.id, urlSnapshot, now, now),
      env.DB
        .prepare(
          "INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, probe_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, 1, ?, ?)",
        )
        .bind(jobId, bookmarkId, user.id, urlSnapshot, now, now),
    ]);
    const payload = parseQueueMessage({
      bookmarkId,
      jobId,
      urlSnapshot,
      requestedAt: new Date(now).toISOString(),
    });
    await env.ENRICHMENT_QUEUE.send(payload);
    return Response.json({ jobId });
  }

  const match = url.pathname.match(/^\/__phase0\/queue\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const jobId = decodeURIComponent(match[1]!);
    const job = await env.DB
      .prepare("SELECT id, status, attempt, probe_mode, created_at, updated_at FROM enrichment_jobs WHERE id = ?")
      .bind(jobId)
      .first<{ id: string; status: string; attempt: number; probe_mode: number; created_at: number; updated_at: number }>();
    if (!job) return new Response("Not Found", { status: 404 });
    const events = await env.DB
      .prepare("SELECT kind, attempt, requested_delay_seconds, occurred_at FROM queue_probe_events WHERE job_id = ? ORDER BY id")
      .bind(jobId)
      .all<{ kind: string; attempt: number | null; requested_delay_seconds: number | null; occurred_at: string }>();
    return Response.json({
      jobId: job.id,
      status: job.status,
      attempt: job.attempt,
      probeMode: job.probe_mode,
      createdAt: new Date(job.created_at).toISOString(),
      updatedAt: new Date(job.updated_at).toISOString(),
      events: events.results,
    });
  }

  return new Response("Not Found", { status: 404 });
}
