-- 双模型：LLM（chat）+ Embedding（语义搜索）
ALTER TABLE user_llm_config ADD COLUMN embedding_model TEXT;
