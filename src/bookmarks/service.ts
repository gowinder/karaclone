import { canonicalizeUrl } from "../url/canonicalize.js";
import { parseQueueMessage } from "../queue/contracts.js";
import { fetchPageMeta } from "./page-meta.js";
import { buildSearchConditions, parseSearchQuery } from "./search-query.js";

export interface CreateBookmarkInput {
  userId: string;
  url: string;
  title?: string | null;
  source?: string | null;
  fetchImpl?: typeof fetch;
}

export interface ServiceBookmark {
  id: string;
  userId: string;
  canonicalUrl: string;
  title: string | null;
  note: string | null;
  summary: string | null;
  description: string | null;
  favicon: string | null;
  archived: boolean;
  favourited: boolean;
  source: "api" | "web" | "cli" | "mobile" | "extension" | "singlefile" | "rss" | "import" | null;
  crawlStatus: "pending" | "success" | "failure" | null;
  taggingStatus: "pending" | "success" | "failure" | null;
  tags: { id: string; name: string; attachedBy: "ai" | "human" }[];
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
  sortOrder: "asc" | "desc";
  favourited?: boolean | null;
  tagId?: string | null;
  /** 搜索串（支持 is:/tag:/url:/title:/source:/after:/before: 与裸词）。 */
  q?: string | null;
  /** 传了就按 offset 分页（仪表盘分页器）；否则走 keyset cursor。 */
  offset?: number | null;
}

export interface ListResult {
  bookmarks: ServiceBookmark[];
  nextCursor: Cursor | null;
  /** 与当前过滤条件（不含 cursor/offset）匹配的总条数。 */
  total: number;
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
  description: string | null;
  favicon: string | null;
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
    tags: [],
    createdAt: new Date(row.created_at),
    modifiedAt: row.modified_at === null ? null : new Date(row.modified_at),
    description: row.description ?? null,
    favicon: row.favicon ?? null,
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

  // 抓取网页简介（失败不阻塞创建）
  const meta = await fetchPageMeta(canonical, { fetchImpl: input.fetchImpl });
  const metaTitle = title ?? meta.title;

  await db.batch([
    db
      .prepare(
        "INSERT INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)",
      )
      .bind(id, input.userId, canonical, metaTitle, source, now, now),
    db
      .prepare("INSERT INTO bookmark_links (id, url, title, description, favicon, crawled_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, canonical, metaTitle, meta.description, meta.favicon, now),
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

/**
 * 分页查询与 COUNT 共用的 WHERE 构造器。
 * 返回的 where 不含前导 WHERE，参数顺序与 where 中的 ? 一一对应。
 */
function buildListWhere(userId: string, opts: ListOptions): { where: string; params: unknown[] } {
  const clauses = ["b.user_id = ?", "b.archived = ?"];
  const params: unknown[] = [userId, opts.archived ? 1 : 0];

  if (opts.favourited != null) {
    clauses.push("b.favourited = ?");
    params.push(opts.favourited ? 1 : 0);
  }
  if (opts.tagId) {
    clauses.push("EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id AND bt.tag_id = ?)");
    params.push(opts.tagId);
  }
  const q = opts.q?.trim();
  if (q) {
    const { clauses: searchClauses, params: searchParams } = buildSearchConditions(parseSearchQuery(q));
    clauses.push(...searchClauses);
    params.push(...searchParams);
  }
  return { where: clauses.join(" AND "), params };
}

export async function getBookmarks(
  db: D1Database,
  userId: string,
  opts: ListOptions,
): Promise<ListResult> {
  const { limit, cursor, sortOrder } = opts;
  const asc = sortOrder === "asc";
  const cmp = asc ? ">" : "<";
  const order = asc ? "ASC" : "DESC";

  const { where, params } = buildListWhere(userId, opts);

  const select = `SELECT b.*, l.description, l.favicon
    FROM bookmarks b LEFT JOIN bookmark_links l ON l.id = b.id`;
  let rows: BookmarkDbRow[];
  if (opts.offset != null) {
    rows = await db
      .prepare(`${select} WHERE ${where} ORDER BY b.created_at ${order}, b.id ${order} LIMIT ? OFFSET ?`)
      .bind(...params, limit + 1, opts.offset)
      .all<BookmarkDbRow>()
      .then((r) => (r.results ?? []) as BookmarkDbRow[]);
  } else if (cursor) {
    const cursorMs = cursor.createdAt.getTime();
    rows = await db
      .prepare(
        `${select} WHERE ${where} AND ((b.created_at ${cmp} ?) OR (b.created_at = ? AND b.id ${cmp} ?)) ORDER BY b.created_at ${order}, b.id ${order} LIMIT ?`,
      )
      .bind(...params, cursorMs, cursorMs, cursor.id, limit + 1)
      .all<BookmarkDbRow>()
      .then((r) => (r.results ?? []) as BookmarkDbRow[]);
  } else {
    rows = await db
      .prepare(`${select} WHERE ${where} ORDER BY b.created_at ${order}, b.id ${order} LIMIT ?`)
      .bind(...params, limit + 1)
      .all<BookmarkDbRow>()
      .then((r) => (r.results ?? []) as BookmarkDbRow[]);
  }

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks b WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  // 批量查本页书签的标签（bookmark_tags join tags）
  const bookmarks = page.map(mapRow);
  if (bookmarks.length > 0) {
    const placeholders = bookmarks.map(() => "?").join(",");
    const tagRows = await db
      .prepare(
        `SELECT bt.bookmark_id, t.id, t.name, bt.attached_by
         FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
         WHERE bt.bookmark_id IN (${placeholders})
         ORDER BY bt.attached_at ASC, t.name ASC`,
      )
      .bind(...bookmarks.map((b) => b.id))
      .all<{ bookmark_id: string; id: string; name: string; attached_by: string }>();
    const byBookmark = new Map<string, ServiceBookmark["tags"]>();
    for (const r of tagRows.results ?? []) {
      const list = byBookmark.get(r.bookmark_id) ?? [];
      list.push({ id: r.id, name: r.name, attachedBy: r.attached_by as "ai" | "human" });
      byBookmark.set(r.bookmark_id, list);
    }
    for (const b of bookmarks) {
      b.tags = byBookmark.get(b.id) ?? [];
    }
  }

  return {
    bookmarks,
    nextCursor: hasMore && last ? { createdAt: new Date(last.created_at), id: last.id } : null,
    total,
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
