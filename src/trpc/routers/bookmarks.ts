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
    tags: [],
    assets: [],
    content: {
      type: "link" as const,
      url: bm.canonicalUrl,
      title: bm.title ?? bm.canonicalUrl,
      description: null,
      imageUrl: null,
      imageAssetId: null,
      screenshotAssetId: null,
      pdfAssetId: null,
      fullPageArchiveAssetId: null,
      precrawledArchiveAssetId: null,
      videoAssetId: null,
      favicon: null,
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
        createdAt: new Date(row.created_at),
        modifiedAt: row.modified_at === null ? null : new Date(row.modified_at),
      };
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
});
