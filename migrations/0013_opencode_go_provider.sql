-- 新增 provider：opencode-go（OpenCode Go 订阅制模型服务）。
-- 0008 的 CHECK 只允许 workers-ai / openrouter / ollama-cloud，SQLite 无法直接修改 CHECK，
-- 只能重建表：新建带新 CHECK 的表 → 复制数据 → 删旧表 → 改名。

CREATE TABLE user_llm_config_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('workers-ai', 'openrouter', 'ollama-cloud', 'opencode-go')),
  base_url TEXT,
  api_key_enc TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

INSERT INTO user_llm_config_new (user_id, provider, base_url, api_key_enc, updated_at)
  SELECT user_id, provider, base_url, api_key_enc, updated_at FROM user_llm_config;

DROP TABLE user_llm_config;
ALTER TABLE user_llm_config_new RENAME TO user_llm_config;
