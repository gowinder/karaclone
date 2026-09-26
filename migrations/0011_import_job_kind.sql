-- 导入任务类型：import = 数据导入；fix = 修复导入数据（补标题 + 标签翻译中文）
ALTER TABLE import_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'import';
