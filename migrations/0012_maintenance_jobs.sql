-- 维护任务扩展：
-- 1) tags 物化计数列 num_bookmarks（触发器自动维护，tags.list 排序不再依赖实时 JOIN）
-- 2) import_jobs.kind 扩展：import / fix / retag（重新统计标签数量）/ translate（标签翻译中文）
--    kind 列无 CHECK 约束（0011 为 TEXT NOT NULL DEFAULT 'import'），可直接写入新值。

ALTER TABLE tags ADD COLUMN num_bookmarks INTEGER NOT NULL DEFAULT 0;

-- 触发器：bookmark_tags 增删改时自动维护 tags.num_bookmarks。
-- 注意：大写 BEGIN/END + LF 行尾（规避 wrangler 远程迁移语句分割器对触发器体的解析 bug）。

CREATE TRIGGER IF NOT EXISTS bookmark_tags_ai
AFTER INSERT ON bookmark_tags
FOR EACH ROW
BEGIN
  UPDATE tags SET num_bookmarks = (SELECT COUNT(*) FROM bookmark_tags WHERE tag_id = NEW.tag_id) WHERE id = NEW.tag_id;
END;

CREATE TRIGGER IF NOT EXISTS bookmark_tags_ad
AFTER DELETE ON bookmark_tags
FOR EACH ROW
BEGIN
  UPDATE tags SET num_bookmarks = (SELECT COUNT(*) FROM bookmark_tags WHERE tag_id = OLD.tag_id) WHERE id = OLD.tag_id;
END;

CREATE TRIGGER IF NOT EXISTS bookmark_tags_au
AFTER UPDATE OF tag_id ON bookmark_tags
FOR EACH ROW
BEGIN
  UPDATE tags SET num_bookmarks = (SELECT COUNT(*) FROM bookmark_tags WHERE tag_id = OLD.tag_id) WHERE id = OLD.tag_id;
  UPDATE tags SET num_bookmarks = (SELECT COUNT(*) FROM bookmark_tags WHERE tag_id = NEW.tag_id) WHERE id = NEW.tag_id;
END;

-- 回填存量数据
UPDATE tags SET num_bookmarks = (SELECT COUNT(*) FROM bookmark_tags WHERE tag_id = tags.id);
