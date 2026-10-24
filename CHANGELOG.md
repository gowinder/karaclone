# Changelog

本文件记录 KaraClone 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.3] - 2026-10-24

### 新增

- **一键导出 URL**：列表被筛选后（标签、搜索词、收藏或归档视图）出现「导出 URL」按钮，把当前列表的全部结果下载为 `.txt`，一行一个 URL。导出与列表共用筛选逻辑，看到的和下载的一致。
- `tags.exportBookmarks` tRPC 端点，接受 `tagId` / `q` / `favourited` / `archived`，返回 `{ urls, count, content, fileName, contentType }`；文件名为 `karaclone-<标签>-<YYYYMMDD>.txt`（未选标签时为 `-bookmarks-`），标签名中的不安全字符折叠为 `-`。
- 导出格式预留扩展位：`format` 为单值枚举，后续可加入 `json` / `yaml` 以携带 url、tags、title 等多维信息，不破坏现有调用方。

### 修复

- 导出端点校验标签归属，避免凭 tagId 读取他人书签 URL。
- 导出范围由「该标签全部」改为「与列表一致的当前筛选结果」——原先搜索后再点标签导出，会拿到比屏幕上多出很多倍的 URL。
- 去重改由 `buildListWhere` 的 `EXISTS` 子查询保证，不再用 `SELECT DISTINCT` 掩盖重复行。
- README 中 `SERVER_VERSION` 长期停留在 `0.2.0`（实际已是 `0.2.2`），现已同步为 `0.2.3`。

### 测试

- 新增 `test/tags-export-trpc.test.ts`（12 个用例）：正常导出、归档视图、空列表、标签不存在、他人标签越权、搜索词+标签的交集、收藏视图、无标签导出、文件名/内容格式工具函数，以及走控制台实际使用的 HTTP + superjson 路径的端到端断言。
- `test/dashboard.test.ts` 增加导出入口渲染断言。
- 全套 403 个用例通过。
