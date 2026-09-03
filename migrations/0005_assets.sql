-- 资产存储：扩展 singlefile 归档上传（R2 + D1 元数据）
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  file_name TEXT,
  bookmark_id TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX assets_user_idx ON assets(user_id);
CREATE INDEX assets_bookmark_idx ON assets(bookmark_id);
