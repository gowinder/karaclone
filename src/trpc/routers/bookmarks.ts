import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import {
  zBookmarkSchema,
  zGetBookmarksRequestSchema,
  zGetBookmarksResponseSchema,
  zNewBookmarkRequestSchema,
  zSearchBookmarksCursor,
  zSearchBookmarksRequestSchema,
} from "../../contracts/bookmarks.js";
import {
  createBookmark as serviceCreate,
  getBookmarks as serviceList,
  getReadingProgress,
  updateReadingProgress,
  type ServiceBookmark,
} from "../../bookmarks/service.js";
import { renderReaderHtml } from "../../bookmarks/reader-html.js";
import { requeueFailedTagging } from "../../bookmarks/retag.js";
import { buildSearchConditions, parseSearchQuery } from "../../bookmarks/search-query.js";

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

type BookmarkRow = {
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
};

/** bookmarks 行 → ServiceBookmark（不含 tags）。 */
function rowToServiceBookmark(row: BookmarkRow): ServiceBookmark {
  return {
    id: row.id,
    userId: row.user_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    note: row.note,
    summary: row.summary,
    archived: row.archived === 1,
    favourited: row.favourited === 1,
    source: row.source as ServiceBookmark["source"],
    crawlStatus: row.crawl_status as ServiceBookmark["crawlStatus"],
    taggingStatus: row.tagging_status as ServiceBookmark["taggingStatus"],
    tags: [],
    createdAt: new Date(row.created_at),
    modifiedAt: row.modified_at === null ? null : new Date(row.modified_at),
    description: null,
    favicon: null,
  };
}

/** 批量补全 tags（避免逐行 N+1）。 */
async function attachTags(
  db: D1Database,
  bookmarks: ServiceBookmark[],
): Promise<ServiceBookmark[]> {
  if (bookmarks.length === 0) return bookmarks;
  const placeholders = bookmarks.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT bt.bookmark_id, t.id, t.name, bt.attached_by
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.bookmark_id IN (${placeholders})
       ORDER BY bt.attached_at ASC, t.name ASC`,
    )
    .bind(...bookmarks.map((b) => b.id))
    .all<{ bookmark_id: string; id: string; name: string; attached_by: string }>();
  const byBookmark: Record<string, ServiceBookmark["tags"]> = {};
  for (const r of rows.results ?? []) {
    (byBookmark[r.bookmark_id] ??= []).push({
      id: r.id,
      name: r.name,
      attachedBy: r.attached_by as "ai" | "human",
    });
  }
  for (const bm of bookmarks) bm.tags = byBookmark[bm.id] ?? [];
  return bookmarks;
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
        favourited: input.favourited ?? null,
        tagId: input.tagId ?? null,
        q: input.q ?? null,
        offset: input.offset ?? null,
      });
      return {
        bookmarks: result.bookmarks.map(toContractBookmark),
        nextCursor: result.nextCursor,
        total: result.total,
      };
    }),

  // 上游：packages/trpc/routers/bookmarks.ts 的 searchBookmarks。
  // 客户端搜索框把原始查询串交给服务端解析（见 apps/mobile/lib/useBookmarkSearchState.ts）。
  // 本实现覆盖解析器的常用子集，语义为 ILIKE 匹配（无 FTS 索引）。
  searchBookmarks: protectedProcedure
    .input(zSearchBookmarksRequestSchema)
    .output(
      z.object({
        bookmarks: z.array(zBookmarkSchema),
        nextCursor: zSearchBookmarksCursor.nullable(),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (input.searchMode !== "fts") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Semantic search is not enabled",
        });
      }
      const parsed = parseSearchQuery(input.text);
      const { clauses, params } = buildSearchConditions(parsed);
      const limit = input.limit ?? 20;
      const offset = input.cursor?.offset ?? 0;

      const where = ["b.user_id = ?", ...clauses].join(" AND ");
      const rows = await ctx.env.DB.prepare(
        `SELECT b.* FROM bookmarks b WHERE ${where}
         ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`,
      )
        .bind(ctx.user.id, ...params, limit + 1, offset)
        .all<BookmarkRow>();

      const hasMore = rows.results.length > limit;
      const page = hasMore ? rows.results.slice(0, limit) : rows.results;
      const hydrated = await attachTags(ctx.env.DB, page.map(rowToServiceBookmark));

      return {
        bookmarks: hydrated.map(toContractBookmark),
        nextCursor: hasMore ? { ver: 1 as const, offset: offset + limit } : null,
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

  // 单条重试失败标签：仅对 tagging_status='failure' 的书签生效，
  // 重新入队到 enrichment 队列（执行时读取用户当前保存的模型配置）。
  retryTagging: protectedProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const row = await ctx.env.DB.prepare(
        "SELECT id, canonical_url, tagging_status FROM bookmarks WHERE id = ? AND user_id = ?",
      )
        .bind(input.bookmarkId, ctx.user.id)
        .first<{ id: string; canonical_url: string; tagging_status: string | null }>();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "BOOKMARK_NOT_FOUND" });
      // 可重试：失败 / 从未打过标签(NULL) / 卡在生成中（是否真卡死由 helper 的
      // NOT EXISTS 守卫判断，仍有活跃 job 会返回 skipped，不会重复入队）
      const retryable =
        row.tagging_status === "failure" ||
        row.tagging_status === "pending" ||
        row.tagging_status === null;
      if (!retryable) {
        // 正常情况：已经生成好了。文案要说人话，别让用户以为功能坏了。
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            row.tagging_status === "success"
              ? "这条书签的标签已经生成好了，无需重试"
              : "这条书签的标签状态不支持重试",
        });
      }

      const outcome = await requeueFailedTagging(ctx.env.DB, ctx.env.ENRICHMENT_QUEUE, ctx.user.id, {
        id: row.id,
        canonicalUrl: row.canonical_url,
      });
      if (!outcome.requeued && !outcome.skipped) {
        // 入队失败（helper 已回滚 job 并保留 failure），让面板弹出真实错误
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "BOOKMARK_TAGGING_ENQUEUE_FAILED",
        });
      }
      // skipped = 已有活跃 job，视为已在处理中
      return { success: true };
    }),
});
