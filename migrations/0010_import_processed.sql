-- 导入任务断点续传：processed 记录已处理条数，网络失败重试时从断点继续
ALTER TABLE import_jobs ADD COLUMN processed INTEGER NOT NULL DEFAULT 0;
