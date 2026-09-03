import { canonicalizeUrl } from "../url/canonicalize.js";

export interface NewBookmark {
  userId: string;
  url: string;
  title?: string | null;
  source?: string | null;
}

export interface BookmarkRow {
  id: string;
  userId: string;
  canonicalUrl: string;
  title: string | null;
  note: string | null;
  summary: string | null;
  archived: boolean;
  favourited: boolean;
  source: string | null;
  crawlStatus: string | null;
  taggingStatus: string | null;
  createdAt: Date;
  modifiedAt: Date | null;
}

export interface CreateBookmarkResult extends BookmarkRow {
  alreadyExists: boolean;
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

function mapRow(row: BookmarkDbRow): BookmarkRow {
  return {
    id: row.id,
    userId: row.user_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    note: row.note,
    summary: row.summary,
    archived: row.archived === 1,
    favourited: row.favourited === 1,
    source: row.source,
    crawlStatus: row.crawl_status,
    taggingStatus: row.tagging_status,
    createdAt: new Date(row.created_at),
    modifiedAt: row.modified_at === null ? null : new Date(row.modified_at),
  };
}

export async function getBookmarkByUrl(
  db: D1Database,
  userId: string,
  url: string,
): Promise<BookmarkRow | null> {
  const canonical = canonicalizeUrl(url);
  const row = await db
    .prepare("SELECT * FROM bookmarks WHERE user_id = ? AND canonical_url = ?")
    .bind(userId, canonical)
    .first<BookmarkDbRow>();
  return row ? mapRow(row) : null;
}

export async function createBookmark(
  db: D1Database,
  input: NewBookmark,
): Promise<CreateBookmarkResult> {
  const canonical = canonicalizeUrl(input.url);
  const existing = await getBookmarkByUrl(db, input.userId, canonical);
  if (existing) {
    return { ...existing, alreadyExists: true };
  }

  const id = crypto.randomUUID();
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
      .bind(crypto.randomUUID(), id, input.userId, canonical, now, now),
  ]);

  const row = await db
    .prepare("SELECT * FROM bookmarks WHERE id = ?")
    .bind(id)
    .first<BookmarkDbRow>();
  if (!row) throw new Error("BOOKMARK_INSERT_FAILED");
  return { ...mapRow(row), alreadyExists: false };
}
