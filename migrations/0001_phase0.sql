PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'fullaccess'),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  title TEXT,
  note TEXT,
  summary TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  favourited INTEGER NOT NULL DEFAULT 0 CHECK (favourited IN (0,1)),
  source TEXT,
  crawl_status TEXT CHECK (crawl_status IN ('pending','success','failure')),
  tagging_status TEXT CHECK (tagging_status IN ('pending','success','failure')),
  created_at INTEGER NOT NULL,
  modified_at INTEGER,
  UNIQUE(user_id, canonical_url)
);

CREATE TABLE bookmark_links (
  id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  favicon TEXT,
  crawled_at INTEGER
);

CREATE TABLE reading_progress (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offset INTEGER NOT NULL,
  anchor TEXT,
  percent INTEGER CHECK (percent BETWEEN 0 AND 100),
  modified_at INTEGER NOT NULL,
  PRIMARY KEY(bookmark_id, user_id)
);

CREATE TABLE enrichment_jobs (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','retry_wait','success','failure','dead','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  lease_expires_at INTEGER,
  last_message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX enrichment_jobs_one_active
ON enrichment_jobs(bookmark_id)
WHERE status IN ('pending','running','retry_wait');

CREATE INDEX enrichment_jobs_retry_idx
ON enrichment_jobs(status, next_retry_at, created_at);
