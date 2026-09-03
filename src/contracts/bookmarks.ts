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
});

export const zGetBookmarksResponseSchema = z.object({
  bookmarks: z.array(zBookmarkSchema),
  nextCursor: zCursorV2.nullable(),
});
export type GetBookmarksResponse = z.infer<typeof zGetBookmarksResponseSchema>;
export const getBookmarksResponseSchema = zGetBookmarksResponseSchema;

export const zCreateBookmarkResponseSchema = zBookmarkSchema.merge(
  z.object({
    alreadyExists: z.boolean().optional().default(false),
  }),
);
export type CreateBookmarkResponse = z.infer<typeof zCreateBookmarkResponseSchema>;
