# Changelog

本文件记录 KaraClone 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.3] - 2026-10-24

### 新增

- **按标签一键导出 URL**：控制台选中标签后出现「导出 URL」按钮，把该标签下全部书签下载为 `.txt`，一行一个 URL。归档书签默认不导出，可用 `includeArchived` 一并导出。
- `tags.exportBookmarks` tRPC 端点，返回 `{ urls, count, content, fileName, contentType }`；文件名为 `karaclone-<标签>-<YYYYMMDD>.txt`，标签名中的不安全字符折叠为 `-`。
- 导出格式预留扩展位：`format` 为单值枚举，后续可加入 `json` / `yaml` 以携带 url、tags、title 等多维信息，不破坏现有调用方。

### 修复

- 导出端点校验标签归属，避免凭 tagId 读取他人书签 URL。
- 导出去重方式改为按 `bookmarks` 主键关联，不再依赖 `DISTINCT` 掩盖重复行。
- README 中 `SERVER_VERSION` 长期停留在 `0.2.0`（实际已是 `0.2.2`），现已同步为 `0.2.3`。

### 测试

- 新增 `test/tags-export-trpc.test.ts`（8 个用例）：正常导出、归档过滤、空标签、标签不存在、他人标签越权，以及文件名/内容格式工具函数。
- `test/dashboard.test.ts` 增加导出入口渲染断言。
- 全套 399 个用例通过。
