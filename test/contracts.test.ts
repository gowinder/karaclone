import { describe, expect, it } from "vitest";
import {
  aiTagResultSchema,
  apiKeySchema,
} from "../src/contracts/phase0";
import {
  bookmarkSchema,
  getBookmarksResponseSchema,
  zBookmarkUrlSchema,
  zNewBookmarkRequestSchema,
} from "../src/contracts/bookmarks";
import { clientConfigSchema } from "../src/contracts/client-config";
import {
  userSettingsSchema,
  whoAmISchema,
} from "../src/contracts/users";

const bookmarkFixture = {
  id: "bm_1",
  firstCreatedAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  modifiedAt: new Date("2026-09-01T01:00:00.000Z"),
  title: "Cloudflare Workers docs",
  archived: false,
  favourited: false,
  taggingStatus: "success",
  summarizationStatus: "pending",
  embeddingStatus: "pending",
  note: null,
  summary: null,
  source: "extension",
  userId: "user_1",
  tags: [{ id: "tag_1", name: "cloudflare", attachedBy: "human" }],
  content: {
    type: "link",
    url: "https://developers.cloudflare.com/workers/",
    title: "Cloudflare Workers docs",
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
    crawledAt: new Date("2026-09-01T00:05:00.000Z"),
    crawlStatus: "success",
    author: null,
    publisher: null,
    datePublished: null,
    dateModified: null,
  },
  assets: [],
};

const clientConfigFixture = {
  publicUrl: "https://karakeep.example.com",
  publicApiUrl: "https://karakeep.example.com",
  auth: {
    disableSignups: false,
    disablePasswordAuth: true,
    oauthAutoRedirect: false,
  },
  turnstile: null,
  inference: {
    isConfigured: true,
    inferredTagLang: "en",
    enableAutoTagging: true,
    enableAutoSummarization: false,
  },
  chat: { enabled: false },
  search: { semanticSearchEnabled: false },
  stripe: { isConfigured: false },
  legal: {},
  serverVersion: "0.1.0",
  disableNewReleaseCheck: true,
};

const whoAmIFixture = {
  id: "user_1",
  name: "Gowinder",
  email: "gowinder@example.com",
  image: null,
  localUser: true,
};

const userSettingsFixture = {
  bookmarkClickAction: "open_original_link",
  archiveDisplayBehaviour: "show",
  timezone: "Asia/Shanghai",
  backupsEnabled: false,
  backupsFrequency: "daily",
  backupsRetentionDays: 30,
  readerFontSize: 16,
  readerLineHeight: 1.6,
  readerFontFamily: "serif",
  autoTaggingEnabled: true,
  autoSummarizationEnabled: null,
  tagStyle: "lowercase-spaces",
  curatedTagIds: null,
  inferredTagLang: "en",
};

describe("phase0 契约", () => {
  it("API key 格式 ak2_<id>_<secret>", () => {
    expect(apiKeySchema.safeParse("ak2_k1_secret").success).toBe(true);
    expect(apiKeySchema.safeParse("ak2_k1").success).toBe(false);
    expect(apiKeySchema.safeParse("ak1_k1_secret").success).toBe(false);
    expect(apiKeySchema.safeParse("ak2_k1_secret_extra").success).toBe(true);
    expect(apiKeySchema.safeParse("ak2_k1 secret").success).toBe(false);
  });

  it("AI 输出：tags 1-8 个、每个 1-40 字符，description nullable", () => {
    expect(aiTagResultSchema.safeParse({ tags: ["cloudflare"], description: null }).success).toBe(true);
    expect(aiTagResultSchema.safeParse({ tags: [], description: null }).success).toBe(false);
    expect(aiTagResultSchema.safeParse({ tags: ["a".repeat(41)], description: null }).success).toBe(false);
    expect(aiTagResultSchema.safeParse({ tags: ["a".repeat(40)], description: null }).success).toBe(true);
    expect(aiTagResultSchema.safeParse({ tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], description: null }).success).toBe(false);
    expect(aiTagResultSchema.safeParse({ tags: ["a"], description: "x".repeat(301) }).success).toBe(false);
    expect(aiTagResultSchema.safeParse({ tags: ["a"], description: "x".repeat(300) }).success).toBe(true);
  });
});

describe("client-config 契约", () => {
  it("完整 clientConfig 解析", () => {
    const parsed = clientConfigSchema.parse(clientConfigFixture);
    expect(parsed.auth.disablePasswordAuth).toBe(true);
    expect(parsed.inference.isConfigured).toBe(true);
    expect(parsed.turnstile).toBeNull();
  });

  it("缺字段失败", () => {
    const { auth, ...rest } = clientConfigFixture;
    expect(clientConfigSchema.safeParse(rest).success).toBe(false);
    expect(clientConfigSchema.safeParse({ ...clientConfigFixture, auth: { ...auth, disablePasswordAuth: "yes" } }).success).toBe(false);
  });
});

describe("users 契约", () => {
  it("WhoAmI 解析", () => {
    const parsed = whoAmISchema.parse(whoAmIFixture);
    expect(parsed.id).toBe("user_1");
    expect(parsed.localUser).toBe(true);
  });

  it("settings 解析且 tagStyle 含 lowercase-spaces", () => {
    const parsed = userSettingsSchema.parse(userSettingsFixture);
    expect(parsed.tagStyle).toBe("lowercase-spaces");
    expect(parsed.readerFontSize).toBe(16);
  });

  it("非法 tagStyle 失败", () => {
    expect(userSettingsSchema.safeParse({ ...userSettingsFixture, tagStyle: "UPPERCASE" }).success).toBe(false);
  });
});

describe("bookmarks 契约", () => {
  it("createdAt 是 Date 实例", () => {
    const parsed = bookmarkSchema.parse(bookmarkFixture);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.content.type === "link" && parsed.content.crawledAt).toBeInstanceOf(Date);
  });

  it("link content 保留 nullable 资源 ID 与 reader 字段", () => {
    const parsed = bookmarkSchema.parse(bookmarkFixture);
    if (parsed.content.type !== "link") throw new Error("expected link");
    expect(parsed.content.screenshotAssetId).toBeNull();
    expect(parsed.content.pdfAssetId).toBeNull();
    expect(parsed.content.htmlContent).toBeNull();
    expect(parsed.content.readerViewStatus).toBeNull();
    expect(parsed.content.preferredPreview).toBeNull();
  });

  it("assets 为数组", () => {
    const parsed = bookmarkSchema.parse(bookmarkFixture);
    expect(Array.isArray(parsed.assets)).toBe(true);
  });

  it("cursor v2 响应", () => {
    const parsed = getBookmarksResponseSchema.parse({ bookmarks: [bookmarkFixture], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.bookmarks).toHaveLength(1);
    const withCursor = getBookmarksResponseSchema.parse({
      bookmarks: [],
      nextCursor: { createdAt: new Date("2026-09-01T00:00:00.000Z"), id: "bm_1" },
    });
    expect(withCursor.nextCursor?.id).toBe("bm_1");
  });

  it("URL 只允许 http/https", () => {
    expect(zBookmarkUrlSchema.safeParse("https://example.com").success).toBe(true);
    expect(zBookmarkUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(zBookmarkUrlSchema.safeParse("data:text/html,x").success).toBe(false);
  });

  it("create request 支持 link 类型", () => {
    const parsed = zNewBookmarkRequestSchema.parse({
      type: "link",
      url: "https://example.com",
      source: "extension",
    });
    expect(parsed.type).toBe("link");
  });
});
