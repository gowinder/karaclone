-- 多 provider 独立配置：user_llm_config 改为 (user_id, provider) 联合主键，
-- 每个 provider 各自存 base_url / api_key_enc；模型选择独立到 user_llm_selection。

CREATE TABLE user_llm_selection (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_provider TEXT NOT NULL,
  chat_model TEXT NOT NULL,
  embedding_provider TEXT,
  embedding_model TEXT,
  updated_at INTEGER NOT NULL
);

-- 旧单行配置迁移：model → chat 选择，embedding_model → embedding 选择
INSERT INTO user_llm_selection (user_id, chat_provider, chat_model, embedding_provider, embedding_model, updated_at)
  SELECT user_id, provider, COALESCE(model, '@cf/meta/llama-3.1-8b-instruct-fast'), provider, embedding_model, updated_at
  FROM user_llm_config;

CREATE TABLE user_llm_config_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('workers-ai', 'openrouter', 'ollama-cloud')),
  base_url TEXT,
  api_key_enc TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

INSERT INTO user_llm_config_new (user_id, provider, base_url, api_key_enc, updated_at)
  SELECT user_id, provider, base_url, api_key_enc, updated_at FROM user_llm_config;

DROP TABLE user_llm_config;
ALTER TABLE user_llm_config_new RENAME TO user_llm_config;
