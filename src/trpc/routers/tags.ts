import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { listBookmarkUrls } from "../../bookmarks/service.js";
import { protectedProcedure, router } from "../base.js";

// 导出格式。目前只做 txt（一行一个 URL），json/yaml 需要多维信息（url/tags/title）
// 时再在此处扩展枚举与取值分支。
const zExportRequestSchema = z.object({
  tagId: z.string().optional(),
  // 与列表视图的过滤条件对齐：用户先搜索/筛选、点标签后看到的是交集，
  // 导出也必须是同一个交集，否则导出的条数会和列表对不上。
  q: z.string().optional(),
  favourited: z.boolean().optional(),
  format: z.enum(["txt"]).optional().default("txt"),
  // 与列表的筛选行为一致：false 只看未归档（默认），true 只看归档视图。
  archived: z.boolean().optional().default(false),
});

const zExportResponseSchema = z.object({
  urls: z.array(z.string()),
  count: z.number().int().min(0),
  content: z.string(),
  fileName: z.string(),
  contentType: z.string(),
});

/**
 * 把标签名转成安全的文件名片段：保留中日韩字符与字母数字，其余折叠成 "-"。
 * 用于导出文件命名，避免标签名里的 "/" ":" 等字符污染 Content-Disposition。
 */
export function tagNameToSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "tag";
}

/** 导出文件名：karaclone-<标签>-<YYYYMMDD>.txt（没有标签时用 bookmarks） */
export function buildExportFileName(tagName: string | null, format: "txt", now: Date): string {
  const ymd = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
  return `karaclone-${tagNameToSlug(tagName ?? "bookmarks")}-${ymd}.${format}`;
}

/** txt 导出内容：一行一个 URL，末尾带换行（符合 POSIX 文本文件约定）。 */
export function buildTxtExport(urls: string[]): string {
  return urls.length === 0 ? "" : `${urls.join("\n")}\n`;
}

const zTagListRequestSchema = z.object({
  nameContains: z.string().optional(),
  ids: z.array(z.string()).optional(),
  attachedBy: z.enum(["ai", "human", "none"]).optional(),
  sortBy: z.enum(["name", "usage", "relevance"]).optional().default("usage"),
  cursor: z.object({ page: z.number().int().min(0) }).nullish().default({ page: 0 }),
  limit: z.number().int().min(1).max(100).optional(),
});

const zGetTagResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  numBookmarks: z.number(),
  numBookmarksByAttachedType: z.record(z.enum(["ai", "human"]), z.number()),
});

export const tagsRouter = router({
  list: protectedProcedure
    .input(zTagListRequestSchema)
    .output(
      z.object({
        tags: z.array(zGetTagResponseSchema),
        nextCursor: z.object({ page: z.number().int().min(0) }).nullish(),
        // karaclone 扩展：仪表盘标签筛选器需要总数来显示「展开全部（共 N 个标签）」。
        // 上游契约没有它，故 optional。
        total: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.user.id;
      const params: unknown[] = [userId];
      let where = "WHERE t.user_id = ?";
      if (input.nameContains) {
        where += " AND t.name LIKE ?";
        params.push(`%${input.nameContains}%`);
      }
      if (input.ids && input.ids.length > 0) {
        where += ` AND t.id IN (${input.ids.map(() => "?").join(",")})`;
        params.push(...input.ids);
      }
      // 总条数用同一组 where 参数算，必须在 push limit/offset 之前
      const countRow = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM tags t ${where}`)
        .bind(...params)
        .first<{ n: number }>();
      const total = countRow?.n ?? 0;

      const limit = input.limit ?? 50;
      const offset = (input.cursor?.page ?? 0) * limit;
      params.push(limit, offset);

      const orderBy =
        input.sortBy === "usage"
          ? "num_bookmarks DESC, t.name ASC"
          : "t.name ASC";

      const rows = await ctx.env.DB.prepare(
        `SELECT t.id, t.name, t.num_bookmarks,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id AND bt.attached_by = 'ai') AS num_ai,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id AND bt.attached_by = 'human') AS num_human
        FROM tags t
        ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      )
        .bind(...params)
        .all<{ id: string; name: string; num_bookmarks: number; num_ai: number | null; num_human: number | null }>();

      const tags = rows.results.map((r) => ({
        id: r.id,
        name: r.name,
        numBookmarks: r.num_bookmarks,
        numBookmarksByAttachedType: { ai: r.num_ai ?? 0, human: r.num_human ?? 0 },
      }));

      const nextCursor = tags.length === limit ? { page: (input.cursor?.page ?? 0) + 1 } : null;
      return { tags, nextCursor, total };
    }),
  get: protectedProcedure
    .input(z.object({ tagId: z.string() }))
    .output(zGetTagResponseSchema)
    .query(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare(
        `SELECT t.id, t.name,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id) AS num_bookmarks,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id AND bt.attached_by = 'ai') AS num_ai,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id AND bt.attached_by = 'human') AS num_human
        FROM tags t
        WHERE t.id = ? AND t.user_id = ?`,
      )
        .bind(input.tagId, ctx.user.id)
        .first<{ id: string; name: string; num_bookmarks: number; num_ai: number | null; num_human: number | null }>();

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      }
      return {
        id: row.id,
        name: row.name,
        numBookmarks: row.num_bookmarks,
        numBookmarksByAttachedType: { ai: row.num_ai ?? 0, human: row.num_human ?? 0 },
      };
    }),
  // 导出书签 URL：一行一个 URL（txt）。
  //
  // 过滤条件与列表视图共用 bookmarks/service 的 buildListWhere，因此「搜索 + 点标签」
  // 后导出的是屏幕上那个交集，不会因为只认 tagId 而多导出。标签必须属于当前用户
  // ——否则任何人猜到 tagId 就能把别人的书签 URL 拉走。
  exportBookmarks: protectedProcedure
    .input(zExportRequestSchema)
    .output(zExportResponseSchema)
    .query(async ({ input, ctx }) => {
      const userId = ctx.user.id;

      let tagName: string | null = null;
      if (input.tagId) {
        const tag = await ctx.env.DB.prepare("SELECT id, name FROM tags WHERE id = ? AND user_id = ?")
          .bind(input.tagId, userId)
          .first<{ id: string; name: string }>();
        if (!tag) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
        }
        tagName = tag.name;
      }

      const urls = await listBookmarkUrls(ctx.env.DB, userId, {
        limit: 0,
        cursor: null,
        archived: input.archived === true,
        sortOrder: "desc",
        tagId: input.tagId ?? null,
        q: input.q ?? null,
        favourited: input.favourited ?? null,
      });

      return {
        urls,
        count: urls.length,
        content: buildTxtExport(urls),
        fileName: buildExportFileName(tagName, input.format, new Date()),
        contentType: "text/plain; charset=utf-8",
      };
    }),
});
