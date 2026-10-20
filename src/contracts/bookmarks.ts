import { z } from "zod";

export const MAX_BOOKMARK_TITLE_LENGTH = 1000;
export const MAX_NUM_BOOKMARKS_PER_PAGE = 100;

export const zCursorV2 = z.object({
  createdAt: z.date(),
  id: z.string(),
});
export type CursorV2 = z.infer<typeof zCursorV2>;

export const zBookmarkUrlSchema = z
  .string()
  .url()
  .refine((url) => {
    try {
      const proto = new URL(url).protocol;
      return proto === "http:" || proto === "https:";
    } catch {
      return false;
    }
  }, { message: "Only http and https URLs are allowed" });

export const zBookmarkTypesSchema = z.enum(["link", "text", "asset", "unknown"]);

export const zReaderViewStatusSchema = z.enum([
  "readable",
  "not_readable",
  "uncertain",
  "unavailable",
]);

export const zPreferredLinkPreviewSchema = z.enum([
  "reader_view",
  "screenshot",
  "overview",
]);

export const zAssetTypesSchema = z.enum([
  "linkHtmlContent",
  "screenshot",
  "pdf",
  "assetScreenshot",
  "bannerImage",
  "fullPageArchive",
  "video",
  "bookmarkAsset",
  "precrawledArchive",
  "userUploaded",
  "avatar",
  "unknown",
]);

export const zAssetSchema = z.object({
  id: z.string(),
  assetType: zAssetTypesSchema,
  fileName: z.string().nullish(),
});

export const zBookmarkedLinkSchema = z.object({
  type: z.literal("link"),
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  imageUrl: z.string().nullish(),
  imageAssetId: z.string().nullish(),
  screenshotAssetId: z.string().nullish(),
  pdfAssetId: z.string().nullish(),
  fullPageArchiveAssetId: z.string().nullish(),
  precrawledArchiveAssetId: z.string().nullish(),
  videoAssetId: z.string().nullish(),
  favicon: z.string().nullish(),
  htmlContent: z.string().nullish(),
  contentAssetId: z.string().nullish(),
  readerViewStatus: zReaderViewStatusSchema.nullish(),
  readerViewScore: z.number().int().min(0).max(100).nullish(),
  preferredPreview: zPreferredLinkPreviewSchema.nullish(),
  crawledAt: z.date().nullish(),
  crawlStatus: z.enum(["success", "failure", "pending"]).nullish(),
  author: z.string().nullish(),
  publisher: z.string().nullish(),
  datePublished: z.date().nullish(),
  dateModified: z.date().nullish(),
});

export const zBookmarkedTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  sourceUrl: z.string().nullish(),
});

export const zBookmarkedAssetSchema = z.object({
  type: z.literal("asset"),
  assetType: z.enum(["image", "pdf"]),
  assetId: z.string(),
  fileName: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  size: z.number().nullish(),
  content: z.string().nullish(),
});

export const zBookmarkContentSchema = z.discriminatedUnion("type", [
  zBookmarkedLinkSchema,
  zBookmarkedTextSchema,
  zBookmarkedAssetSchema,
  z.object({ type: z.literal("unknown") }),
]);

export const zBookmarkSourceSchema = z.enum([
  "api",
  "web",
  "cli",
  "mobile",
  "extension",
  "singlefile",
  "rss",
  "import",
]);

export const zBookmarkTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  attachedBy: z.enum(["ai", "human"]),
});

export const zBareBookmarkSchema = z.object({
  id: z.string(),
  firstCreatedAt: z.date().optional(),
  createdAt: z.date(),
  modifiedAt: z.date().nullable(),
  title: z.string().nullish(),
  archived: z.boolean(),
  favourited: z.boolean(),
  taggingStatus: z.enum(["success", "failure", "pending"]).nullable(),
  summarizationStatus: z.enum(["success", "failure", "pending"]).nullable(),
  embeddingStatus: z.enum(["success", "failure", "pending"]).nullable(),
  note: z.string().nullish(),
  summary: z.string().nullish(),
  source: zBookmarkSourceSchema.nullish(),
  userId: z.string(),
});

export const zBookmarkSchema = zBareBookmarkSchema.extend({
  tags: z.array(zBookmarkTagSchema),
  content: zBookmarkContentSchema,
  assets: z.array(zAssetSchema),
});
export type Bookmark = z.infer<typeof zBookmarkSchema>;
export const bookmarkSchema = zBookmarkSchema;

export const zNewBookmarkRequestSchema = z.intersection(
  z.object({
    title: z.string().max(MAX_BOOKMARK_TITLE_LENGTH).nullish(),
    archived: z.boolean().optional(),
    favourited: z.boolean().optional(),
    note: z.string().optional(),
    summary: z.string().optional(),
    createdAt: z.coerce.date().optional(),
    crawlPriority: z.enum(["low", "normal"]).optional(),
    source: zBookmarkSourceSchema.optional(),
  }),
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("link"),
      url: zBookmarkUrlSchema,
      precrawledArchiveId: z.string().optional(),
    }),
    z.object({
      type: z.literal("text"),
      text: z.string(),
      sourceUrl: z.string().optional(),
    }),
    z.object({
      type: z.literal("asset"),
      assetType: z.enum(["image", "pdf"]),
      assetId: z.string(),
      fileName: z.string().optional(),
      sourceUrl: z.string().optional(),
    }),
  ]),
);
export type NewBookmarkRequest = z.infer<typeof zNewBookmarkRequestSchema>;

export const zGetBookmarksRequestSchema = z.object({
  archived: z.boolean().optional(),
  favourited: z.boolean().optional(),
  tagId: z.string().optional(),
  listId: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_NUM_BOOKMARKS_PER_PAGE).optional(),
  cursor: zCursorV2.nullish(),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  includeContent: z.boolean().optional().default(false),
  useCursorV2: z.boolean().optional(),
  // karaclone 扩展：仪表盘搜索框直传的查询串（支持 is:/tag:/url:/title: 等 qualifier）
  q: z.string().optional(),
  // karaclone 扩展：仪表盘分页器按 offset 翻页（与 cursor 互斥，传了 offset 就走 offset 分支）
  offset: z.number().int().min(0).optional(),
});

// 上游：packages/shared/types/bookmarks.ts:353-368
export const zSearchBookmarksCursor = z.discriminatedUnion("ver", [
  z.object({ ver: z.literal(1), offset: z.number() }),
]);

export const zBookmarkSearchMode = z.enum(["fts", "semantic", "hybrid"]);

export const zSearchBookmarksRequestSchema = z.object({
  text: z.string(),
  limit: z.number().int().min(1).max(MAX_NUM_BOOKMARKS_PER_PAGE).optional(),
  cursor: zSearchBookmarksCursor.nullish(),
  sortOrder: z.enum(["asc", "desc", "relevance"]).optional().default("relevance"),
  searchMode: zBookmarkSearchMode.optional().default("fts"),
  includeContent: z.boolean().optional().default(false),
});

export const zGetBookmarksResponseSchema = z.object({
  bookmarks: z.array(zBookmarkSchema),
  nextCursor: zCursorV2.nullable(),
  // karaclone 给仪表盘分页器加的扩展字段（匹配当前过滤条件的总条数）。
  // 上游契约没有它，故为 optional：test/contracts.test.ts 会按上游形态 parse 本 schema。
  total: z.number().int().min(0).optional(),
});
export type GetBookmarksResponse = z.infer<typeof zGetBookmarksResponseSchema>;
export const getBookmarksResponseSchema = zGetBookmarksResponseSchema;

export const zCreateBookmarkResponseSchema = zBookmarkSchema.merge(
  z.object({
    alreadyExists: z.boolean().optional().default(false),
  }),
);
export type CreateBookmarkResponse = z.infer<typeof zCreateBookmarkResponseSchema>;
