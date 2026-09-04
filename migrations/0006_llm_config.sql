-- LLM provider 配置：每用户一行，api_key 用 AES-GCM 加密存储
CREATE TABLE user_llm_config (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('workers-ai', 'openrouter', 'ollama-cloud')),
  base_url TEXT,
  api_key_enc TEXT,
  model TEXT,
  updated_at INTEGER NOT NULL
);
