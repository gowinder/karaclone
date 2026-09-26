import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import {
  zBookmarkSchema,
  zGetBookmarksRequestSchema,
  zGetBookmarksResponseSchema,
  zNewBookmarkRequestSchema,
} from "../../contracts/bookmarks.js";
import {
  createBookmark as serviceCreate,
  getBookmarks as serviceList,
  getReadingProgress,
  updateReadingProgress,
  type ServiceBookmark,
} from "../../bookmarks/service.js";
import { renderReaderHtml } from "../../bookmarks/reader-html.js";

function toContractBookmark(bm: ServiceBookmark): z.infer<typeof zBookmarkSchema> {
  return {
    id: bm.id,
    firstCreatedAt: bm.createdAt,
    createdAt: bm.createdAt,
    modifiedAt: bm.modifiedAt,
    title: bm.title,
    archived: bm.archived,
    favourited: bm.favourited,
    taggingStatus: bm.taggingStatus,
    summarizationStatus: null,
    embeddingStatus: null,
    note: bm.note,
    summary: bm.summary,
    source: bm.source,
    userId: bm.userId,
    tags: bm.tags,
    assets: [],
    content: {
      type: "link" as const,
      url: bm.canonicalUrl,
      title: bm.title ?? bm.canonicalUrl,
      description: bm.description,
      imageUrl: null,
      imageAssetId: null,
      screenshotAssetId: null,
      pdfAssetId: null,
      fullPageArchiveAssetId: null,
      precrawledArchiveAssetId: null,
      videoAssetId: null,
      favicon: bm.favicon,
      htmlContent: null,
      contentAssetId: null,
      readerViewStatus: null,
      readerViewScore: null,
      preferredPreview: null,
      crawledAt: null,
      crawlStatus: bm.crawlStatus,
      author: null,
      publisher: null,
      datePublished: null,
      dateModified: null,
    },
  };
}

export const bookmarksRouter = router({
  createBookmark: protectedProcedure
    .input(zNewBookmarkRequestSchema)
    .output(zBookmarkSchema.merge(z.object({ alreadyExists: z.boolean().optional().default(false) })))
    .mutation(async ({ input, ctx }) => {
      if (input.type !== "link") {
        throw new Error("UNSUPPORTED_BOOKMARK_TYPE");
      }
      const result = await serviceCreate(ctx.env.DB, ctx.env.ENRICHMENT_QUEUE, {
        userId: ctx.user.id,
        url: input.url,
        title: input.title ?? null,
        source: input.source ?? null,
      });
      return { ...toContractBookmark(result.bookmark), alreadyExists: !result.created };
    }),

  checkUrl: protectedProcedure
    .input(z.object({ url: z.string() }))
    .output(z.object({ bookmarkId: z.string().nullable() }))
    .query(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare(
        "SELECT id FROM bookmarks WHERE user_id = ? AND canonical_url = ?",
      )
        .bind(ctx.user.id, input.url)
        .first<{ id: string }>();
      return { bookmarkId: row?.id ?? null };
    }),

  getBookmarks: protectedProcedure
    .input(zGetBookmarksRequestSchema)
    .output(zGetBookmarksResponseSchema)
    .query(async ({ input, ctx }) => {
      const result = await serviceList(ctx.env.DB, ctx.user.id, {
        limit: input.limit ?? 20,
        cursor: input.cursor ?? null,
        archived: input.archived ?? false,
        sortOrder: input.sortOrder ?? "desc",
      });
      return {
        bookmarks: result.bookmarks.map(toContractBookmark),
        nextCursor: result.nextCursor,
      };
    }),

  getBookmark: protectedProcedure
    .input(z.object({ bookmarkId: z.string(), includeContent: z.boolean().optional().default(false) }))
    .output(zBookmarkSchema)
    .query(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare("SELECT * FROM bookmarks WHERE id = ? AND user_id = ?")
        .bind(input.bookmarkId, ctx.user.id)
        .first<{
          id: string;
          user_id: string;
          canonical_url: string;
          title: string | null;
          note: string | null;
          summary: string | null;
          archived: number;
          favourited: number;
          source: string | null;
          crawl_status: string | null;
          tagging_status: string | null;
          created_at: number;
          modified_at: number | null;
        }>();
      if (!row) throw new Error("BOOKMARK_NOT_FOUND");
      const bm: ServiceBookmark = {
        id: row.id,
        userId: row.user_id,
        canonicalUrl: row.canonical_url,
        title: row.title,
        note: row.note,
        summary: row.summary,
        archived: row.archived === 1,
        favourited: row.favourited === 1,
        source: row.source as "api" | "web" | "cli" | "mobile" | "extension" | "singlefile" | "rss" | "import" | null,
        crawlStatus: row.crawl_status as "pending" | "success" | "failure" | null,
        taggingStatus: row.tagging_status as "pending" | "success" | "failure" | null,
        tags: [],
        createdAt: new Date(row.created_at),
        modifiedAt: row.modified_at === null ? null : new Date(row.modified_at),
        description: null,
        favicon: null,
      };
      const tagRows = await ctx.env.DB.prepare(
        `SELECT t.id, t.name, bt.attached_by
         FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
         WHERE bt.bookmark_id = ?
         ORDER BY bt.attached_at ASC, t.name ASC`,
      )
        .bind(input.bookmarkId)
        .all<{ id: string; name: string; attached_by: string }>();
      bm.tags = (tagRows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        attachedBy: r.attached_by as "ai" | "human",
      }));
      const contract = toContractBookmark(bm);
      if (input.includeContent && contract.content.type === "link") {
        contract.content.htmlContent = renderReaderHtml({
          title: bm.title,
          url: bm.canonicalUrl,
          summary: bm.summary,
        });
      }
      return contract;
    }),

  deleteBookmark: protectedProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare("SELECT id FROM bookmarks WHERE id = ? AND user_id = ?")
        .bind(input.bookmarkId, ctx.user.id)
        .first<{ id: string }>();
      if (!row) throw new Error("BOOKMARK_NOT_FOUND");
      await ctx.env.DB.batch([
        ctx.env.DB.prepare("DELETE FROM bookmark_tags WHERE bookmark_id = ?").bind(input.bookmarkId),
        ctx.env.DB.prepare("DELETE FROM bookmark_links WHERE id = ?").bind(input.bookmarkId),
        ctx.env.DB.prepare("DELETE FROM enrichment_jobs WHERE bookmark_id = ?").bind(input.bookmarkId),
        ctx.env.DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(input.bookmarkId),
      ]);
      return { success: true };
    }),

  updateBookmark: protectedProcedure
    .input(
      z.object({
        bookmarkId: z.string(),
        favourited: z.boolean().optional(),
        archived: z.boolean().optional(),
        note: z.string().optional(),
      }),
    )
    .output(zBookmarkSchema)
    .mutation(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare("SELECT * FROM bookmarks WHERE id = ? AND user_id = ?")
        .bind(input.bookmarkId, ctx.user.id)
        .first<{
          id: string;
          user_id: string;
          canonical_url: string;
          title: string | null;
          note: string | null;
          summary: string | null;
          archived: number;
          favourited: number;
          source: string | null;
          crawl_status: string | null;
          tagging_status: string | null;
          created_at: number;
          modified_at: number | null;
        }>();
      if (!row) throw new Error("BOOKMARK_NOT_FOUND");

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.favourited !== undefined) {
        sets.push("favourited = ?");
        params.push(input.favourited ? 1 : 0);
      }
      if (input.archived !== undefined) {
        sets.push("archived = ?");
        params.push(input.archived ? 1 : 0);
      }
      if (input.note !== undefined) {
        sets.push("note = ?");
        params.push(input.note);
      }
      if (sets.length > 0) {
        sets.push("modified_at = ?");
        params.push(Date.now());
        params.push(input.bookmarkId, ctx.user.id);
        await ctx.env.DB.prepare(`UPDATE bookmarks SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
          .bind(...params)
          .run();
      }

      const updated = await ctx.env.DB.prepare("SELECT * FROM bookmarks WHERE id = ? AND user_id = ?")
        .bind(input.bookmarkId, ctx.user.id)
        .first<{
          id: string;
          user_id: string;
          canonical_url: string;
          title: string | null;
          note: string | null;
          summary: string | null;
          archived: number;
          favourited: number;
          source: string | null;
          crawl_status: string | null;
          tagging_status: string | null;
          created_at: number;
          modified_at: number | null;
        }>();
      if (!updated) throw new Error("BOOKMARK_NOT_FOUND");
      const bm: ServiceBookmark = {
        id: updated.id,
        userId: updated.user_id,
        canonicalUrl: updated.canonical_url,
        title: updated.title,
        note: updated.note,
        summary: updated.summary,
        archived: updated.archived === 1,
        favourited: updated.favourited === 1,
        source: updated.source as "api" | "web" | "cli" | "mobile" | "extension" | "singlefile" | "rss" | "import" | null,
        crawlStatus: updated.crawl_status as "pending" | "success" | "failure" | null,
        taggingStatus: updated.tagging_status as "pending" | "success" | "failure" | null,
        tags: [],
        createdAt: new Date(updated.created_at),
        modifiedAt: updated.modified_at === null ? null : new Date(updated.modified_at),
        description: null,
        favicon: null,
      };
      const tagRows = await ctx.env.DB.prepare(
        `SELECT t.id, t.name, bt.attached_by
         FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
         WHERE bt.bookmark_id = ?
         ORDER BY bt.attached_at ASC, t.name ASC`,
      )
        .bind(input.bookmarkId)
        .all<{ id: string; name: string; attached_by: string }>();
      bm.tags = (tagRows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        attachedBy: r.attached_by as "ai" | "human",
      }));
      return toContractBookmark(bm);
    }),

  updateReadingProgress: protectedProcedure
    .input(
      z.object({
        bookmarkId: z.string(),
        readingProgressOffset: z.number(),
        readingProgressAnchor: z.string().nullable(),
        readingProgressPercent: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await updateReadingProgress(ctx.env.DB, {
        userId: ctx.user.id,
        bookmarkId: input.bookmarkId,
        readingProgressOffset: input.readingProgressOffset,
        readingProgressAnchor: input.readingProgressAnchor,
        readingProgressPercent: input.readingProgressPercent,
      });
    }),

  getReadingProgress: protectedProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .output(
      z.object({
        readingProgressOffset: z.number(),
        readingProgressAnchor: z.string().nullable(),
        readingProgressPercent: z.number(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const progress = await getReadingProgress(ctx.env.DB, ctx.user.id, input.bookmarkId);
      if (!progress) {
        return { readingProgressOffset: 0, readingProgressAnchor: null, readingProgressPercent: 0 };
      }
      return progress;
    }),

  // 官方客户端（浏览器扩展/移动端）添加/移除标签：attach 支持 tagId 或 tagName（新建）。
  // 契约对齐上游 zManipulatedTagSchema：tagId/tagName 至少一个，attachedBy 默认 human。
  updateTags: protectedProcedure
    .input(
      z.object({
        bookmarkId: z.string(),
        attach: z.array(
          z
            .object({
              tagId: z.string().optional(),
              tagName: z.string().optional(),
              attachedBy: z.enum(["ai", "human"]).optional().default("human"),
            })
            .refine((v) => !!v.tagId || !!v.tagName, {
              message: "You must provide either a tagId or a tagName",
            }),
        ),
        detach: z.array(
          z
            .object({
              tagId: z.string().optional(),
              tagName: z.string().optional(),
              attachedBy: z.enum(["ai", "human"]).optional().default("human"),
            })
            .refine((v) => !!v.tagId || !!v.tagName, {
              message: "You must provide either a tagId or a tagName",
            }),
        ),
      }),
    )
    .output(z.object({ attached: z.array(z.string()), detached: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = ctx.env.DB;
      const userId = ctx.user.id;
      const now = Date.now();

      // 书签归属校验
      const bm = await db
        .prepare("SELECT id FROM bookmarks WHERE id = ? AND user_id = ?")
        .bind(input.bookmarkId, userId)
        .first<{ id: string }>();
      if (!bm) throw new Error("BOOKMARK_NOT_FOUND");

      // 归一化 tagName（对齐上游 normalizeTagName：trim + 去前导 #）
      const normalize = (raw: string): string => raw.trim().replace(/^#+/, "");

      // 解析 tagId/tagName → 真实 tag id（tagName 不存在则新建）
      const resolveTags = async (
        items: { tagId?: string; tagName?: string }[],
      ): Promise<{ id: string; name: string }[]> => {
        const out: { id: string; name: string }[] = [];
        const seen = new Set<string>();
        for (const item of items) {
          if (item.tagId) {
            const row = await db
              .prepare("SELECT id, name FROM tags WHERE id = ? AND user_id = ?")
              .bind(item.tagId, userId)
              .first<{ id: string; name: string }>();
            if (row && !seen.has(row.id)) {
              seen.add(row.id);
              out.push(row);
            }
          } else if (item.tagName) {
            const name = normalize(item.tagName);
            if (!name) continue;
            let row = await db
              .prepare("SELECT id, name FROM tags WHERE user_id = ? AND name = ?")
              .bind(userId, name)
              .first<{ id: string; name: string }>();
            if (!row) {
              const id = crypto.randomUUID();
              await db
                .prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
                .bind(id, userId, name, now)
                .run();
              row = { id, name };
            }
            if (!seen.has(row.id)) {
              seen.add(row.id);
              out.push(row);
            }
          }
        }
        return out;
      };

      const [attachTags, detachTags] = await Promise.all([
        resolveTags(input.attach),
        resolveTags(input.detach),
      ]);
      const attachIds = attachTags.map((t) => t.id);
      const detachIds = detachTags.map((t) => t.id);

      // attachedBy 映射（attach 项按 tagId/tagName 匹配）
      const attachedByMap = new Map<string, "ai" | "human">();
      for (const item of input.attach) {
        const target = item.tagId
          ? attachTags.find((t) => t.id === item.tagId)
          : attachTags.find((t) => t.name === normalize(item.tagName ?? ""));
        if (target) attachedByMap.set(target.id, item.attachedBy);
      }

      const ops: D1PreparedStatement[] = [];
      if (detachIds.length > 0) {
        ops.push(
          db
            .prepare("DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id IN (" + detachIds.map(() => "?").join(",") + ")")
            .bind(input.bookmarkId, ...detachIds),
        );
      }
      for (const id of attachIds) {
        ops.push(
          db
            .prepare("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, ?, ?)")
            .bind(input.bookmarkId, id, attachedByMap.get(id) ?? "human", now),
        );
      }
      if (ops.length > 0) {
        await db.batch(ops);
        await db
          .prepare("UPDATE bookmarks SET modified_at = ? WHERE id = ?")
          .bind(now, input.bookmarkId)
          .run();
      }

      return { attached: attachIds, detached: detachIds };
    }),
});
