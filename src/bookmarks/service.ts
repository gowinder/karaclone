import { canonicalizeUrl } from "../url/canonicalize.js";
import { parseQueueMessage } from "../queue/contracts.js";

export interface CreateBookmarkInput {
  userId: string;
  url: string;
  title?: string | null;
  source?: string | null;
}

export interface ServiceBookmark {
  id: string;
  userId: string;
  canonicalUrl: string;
  title: string | null;
  note: string | null;
  summary: string | null;
  archived: boolean;
  favourited: boolean;
  source: "api" | "web" | "cli" | "mobile" | "extension" | "singlefile" | "rss" | "import" | null;
  crawlStatus: "pending" | "success" | "failure" | null;
  taggingStatus: "pending" | "success" | "failure" | null;
  createdAt: Date;
  modifiedAt: Date | null;
}

export interface CreateBookmarkResult {
  bookmark: ServiceBookmark;
  created: boolean;
}

export interface Cursor {
  createdAt: Date;
  id: string;
}

export interface ListOptions {
  limit: number;
  cursor: Cursor | null;
  archived: boolean;
}

export interface ListResult {
  bookmarks: ServiceBookmark[];
  nextCursor: Cursor | null;
}

interface BookmarkDbRow {
  id: string;
  user_id: string;
  canonical_url: string;
  title: string | null;
  note: string | null;
  summary: string | null;
  archived: number;
  favourited: number;
  source: string | null;
  crawl_status: string | null;
  tagging_status: string | null;
  created_at: number;
  modified_at: number | null;
}

function mapRow(row: BookmarkDbRow): ServiceBookmark {
  return {
    id: row.id,
    userId: row.user_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    note: row.note,
    summary: row.summary,
    archived: row.archived === 1,
    favourited: row.favourited === 1,
    source: row.source as "api" | "web" | "cli" | "mobile" | "extension" | "singlefile" | "rss" | "import" | null,
    crawlStatus: row.crawl_status as "pending" | "success" | "failure" | null,
    taggingStatus: row.tagging_status as "pending" | "success" | "failure" | null,
    createdAt: new Date(row.created_at),
    modifiedAt: row.modified_at === null ? null : new Date(row.modified_at),
  };
}

export async function createBookmark(
  db: D1Database,
  queue: { send: (payload: unknown) => Promise<unknown> },
  input: CreateBookmarkInput,
): Promise<CreateBookmarkResult> {
  const canonical = canonicalizeUrl(input.url);
  const existing = await db
    .prepare("SELECT * FROM bookmarks WHERE user_id = ? AND canonical_url = ?")
    .bind(input.userId, canonical)
    .first<BookmarkDbRow>();
  if (existing) {
    return { bookmark: mapRow(existing), created: false };
  }

  const id = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const title = input.title ?? null;
  const source = input.source ?? null;

  await db.batch([
    db
      .prepare(
        "INSERT INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)",
      )
      .bind(id, input.userId, canonical, title, source, now, now),
    db
      .prepare("INSERT INTO bookmark_links (id, url, title) VALUES (?, ?, ?)")
      .bind(id, canonical, title),
    db
      .prepare(
        "INSERT INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
      )
      .bind(jobId, id, input.userId, canonical, now, now),
  ]);

  const payload = parseQueueMessage({
    bookmarkId: id,
    jobId,
    urlSnapshot: canonical,
    requestedAt: new Date().toISOString(),
  });
  try {
    await queue.send(payload);
  } catch (err) {
    // Queue send 失败不回滚已提交书签；job 保持 pending，写结构化 error log
    console.error(JSON.stringify({ event: "queue_send_failed", bookmarkId: id, jobId, error: String(err) }));
  }

  const row = await db.prepare("SELECT * FROM bookmarks WHERE id = ?").bind(id).first<BookmarkDbRow>();
  if (!row) throw new Error("BOOKMARK_INSERT_FAILED");
  return { bookmark: mapRow(row), created: true };
}

export async function getBookmarks(
  db: D1Database,
  userId: string,
  opts: ListOptions,
): Promise<ListResult> {
  const { limit, cursor, archived } = opts;
  const archivedInt = archived ? 1 : 0;

  let rows: BookmarkDbRow[];
  if (cursor) {
    const cursorMs = cursor.createdAt.getTime();
    rows = await db
      .prepare(
        "SELECT * FROM bookmarks WHERE user_id = ? AND archived = ? AND ((created_at < ?) OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .bind(userId, archivedInt, cursorMs, cursorMs, cursor.id, limit + 1)
      .all<BookmarkDbRow>()
      .then((r) => (r.results ?? []) as BookmarkDbRow[]);
  } else {
    rows = await db
      .prepare("SELECT * FROM bookmarks WHERE user_id = ? AND archived = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .bind(userId, archivedInt, limit + 1)
      .all<BookmarkDbRow>()
      .then((r) => (r.results ?? []) as BookmarkDbRow[]);
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    bookmarks: page.map(mapRow),
    nextCursor: hasMore && last ? { createdAt: new Date(last.created_at), id: last.id } : null,
  };
}

export async function updateReadingProgress(
  db: D1Database,
  input: {
    userId: string;
    bookmarkId: string;
    readingProgressOffset: number;
    readingProgressAnchor: string | null;
    readingProgressPercent: number;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO reading_progress (bookmark_id, user_id, offset, anchor, percent, modified_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bookmark_id, user_id) DO UPDATE SET offset = excluded.offset, anchor = excluded.anchor, percent = excluded.percent, modified_at = excluded.modified_at",
    )
    .bind(
      input.bookmarkId,
      input.userId,
      input.readingProgressOffset,
      input.readingProgressAnchor,
      input.readingProgressPercent,
      Date.now(),
    )
    .run();
}

export async function getReadingProgress(
  db: D1Database,
  userId: string,
  bookmarkId: string,
): Promise<{
  readingProgressOffset: number;
  readingProgressAnchor: string | null;
  readingProgressPercent: number;
} | null> {
  const row = await db
    .prepare("SELECT offset, anchor, percent FROM reading_progress WHERE bookmark_id = ? AND user_id = ?")
    .bind(bookmarkId, userId)
    .first<{ offset: number; anchor: string | null; percent: number }>();
  if (!row) return null;
  return {
    readingProgressOffset: row.offset,
    readingProgressAnchor: row.anchor,
    readingProgressPercent: row.percent,
  };
}
