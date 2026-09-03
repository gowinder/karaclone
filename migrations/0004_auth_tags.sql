-- 账户认证：users 增加密码哈希字段（PBKDF2，WebCrypto 实现，替代 upstream 的 bcrypt）
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;

-- 标签：扩展 TagsSelector 依赖 tags.list
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  attached_by TEXT NOT NULL CHECK (attached_by IN ('ai', 'human')),
  attached_at INTEGER NOT NULL,
  PRIMARY KEY(bookmark_id, tag_id)
);

CREATE INDEX tags_user_idx ON tags(user_id);
CREATE INDEX bookmark_tags_tag_idx ON bookmark_tags(tag_id);
