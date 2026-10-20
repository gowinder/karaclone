import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { sha256Hex } from "../src/auth/api-key";

// 覆盖 karakeep-protocol-sync skill 检出的 3 个缺口端点：
//   tags.get、users.stats、bookmarks.searchBookmarks
const USER_ID = "user_gap";
const KEY_ID = "998877665544332211ff";
const SECRET = "ffeeddccbbaa99887766554433221100";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Gap User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)",
  )
    .bind("ak_row_gap", USER_ID, KEY_ID, hash, "gap key", Date.now())
    .run();
}

/** 测试共用同一用户，逐个清理其数据以保证计数断言独立。 */
async function reset() {
  await seed();
  await env.DB.prepare("DELETE FROM bookmark_tags WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)")
    .bind(USER_ID)
    .run();
  await env.DB.prepare("DELETE FROM bookmarks WHERE user_id = ?").bind(USER_ID).run();
  await env.DB.prepare("DELETE FROM tags WHERE user_id = ?").bind(USER_ID).run();
  await env.DB.prepare("DELETE FROM assets WHERE user_id = ?").bind(USER_ID).run();
}

async function caller() {
  const req = new Request("https://example.com/trpc/", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

beforeEach(reset);

describe("tags.get", () => {
  it("返回标签详情与 attached type 计数", async () => {
    await reset();
    const c = await caller();
    const bm = await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/tag-count", source: "api" });
    const updated = await c.bookmarks.updateTags({
      bookmarkId: bm.id,
      attach: [{ tagName: "统计标签", attachedBy: "human" }],
      detach: [],
    });
    const tagId = updated.attached[0]!;

    const detail = await c.tags.get({ tagId });
    expect(detail.name).toBe("统计标签");
    expect(detail.numBookmarks).toBe(1);
    expect(detail.numBookmarksByAttachedType).toEqual({ ai: 0, human: 1 });
  });

  it("标签不存在时 NOT_FOUND", async () => {
    await reset();
    const c = await caller();
    await expect(c.tags.get({ tagId: "no-such-tag" })).rejects.toThrow(/Tag not found/);
  });

  it("不返回他人标签", async () => {
    await seed();
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
      .bind("user_other", "Other", null, Date.now())
      .run();
    await env.DB.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("tag_other", "user_other", "别人的标签", Date.now())
      .run();
    const c = await caller();
    await expect(c.tags.get({ tagId: "tag_other" })).rejects.toThrow(/Tag not found/);
  });
});

describe("users.stats", () => {
  it("输出结构与上游 schema 对齐且计数反映真实数据", async () => {
    await reset();
    const c = await caller();
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/stats-1", source: "extension" });
    const bm2 = await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/stats-2", source: "api" });
    await c.bookmarks.updateTags({ bookmarkId: bm2.id, attach: [{ tagName: "stats tag" }], detach: [] });
    await c.bookmarks.updateBookmark({ bookmarkId: bm2.id, favourited: true });

    const stats = await c.users.stats();
    expect(stats.numBookmarks).toBe(2);
    expect(stats.numFavorites).toBe(1);
    expect(stats.numArchived).toBe(0);
    expect(stats.numTags).toBe(1);
    // 本仓库无 highlights/lists
    expect(stats.numLists).toBe(0);
    expect(stats.numHighlights).toBe(0);
    expect(stats.bookmarksByType).toEqual({ link: 2, text: 0, asset: 0 });
    expect(stats.bookmarkingActivity.byHour).toHaveLength(24);
    expect(stats.bookmarkingActivity.byDayOfWeek).toHaveLength(7);
    expect(stats.bookmarkingActivity.thisWeek).toBe(2);
    expect(stats.tagUsage).toEqual([{ name: "stats tag", count: 1 }]);
    expect(stats.bookmarksBySource).toEqual(
      expect.arrayContaining([
        { source: "api", count: 1 },
        { source: "extension", count: 1 },
      ]),
    );
    expect(stats.bookmarksBySource).toHaveLength(2);
    expect(stats.totalAssetSize).toBe(0);
    expect(stats.assetsByType).toEqual([]);
    expect(stats.topDomains).toEqual([{ domain: "example.com", count: 2 }]);
  });

  it("无书签时返回零值而非 null", async () => {
    const c = await caller();
    const stats = await c.users.stats();
    expect(stats.numBookmarks).toBe(0);
    expect(stats.numFavorites).toBe(0);
    expect(stats.bookmarkingActivity.thisWeek).toBe(0);
    expect(stats.topDomains).toEqual([]);
    expect(stats.tagUsage).toEqual([]);
  });
});

describe("bookmarks.searchBookmarks", () => {
  it("裸词匹配标题与 URL", async () => {
    await reset();
    const c = await caller();
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/alpha", title: "Alpha 文章" });
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/beta", title: "Beta 文章" });

    const byTitle = await c.bookmarks.searchBookmarks({ text: "Alpha" });
    expect(byTitle.bookmarks.map((b) => b.title)).toEqual(["Alpha 文章"]);

    const byUrl = await c.bookmarks.searchBookmarks({ text: "beta" });
    expect(byUrl.bookmarks).toHaveLength(1);
    expect(byUrl.bookmarks[0]!.content.type === "link" && byUrl.bookmarks[0]!.content.url).toBe(
      "https://example.com/beta",
    );
  });

  it("is:fav / is:archived 过滤", async () => {
    await reset();
    const c = await caller();
    const fav = await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/fav-one", title: "收藏项" });
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/plain", title: "普通项" });
    await c.bookmarks.updateBookmark({ bookmarkId: fav.id, favourited: true });

    const favs = await c.bookmarks.searchBookmarks({ text: "is:fav" });
    expect(favs.bookmarks.map((b) => b.id)).toEqual([fav.id]);
    expect(favs.bookmarks[0]!.favourited).toBe(true);

    const nonArchived = await c.bookmarks.searchBookmarks({ text: "is:archived" });
    expect(nonArchived.bookmarks).toEqual([]);
  });

  it("tag:/#tag 过滤，可与其他词组合", async () => {
    await reset();
    const c = await caller();
    const tagged = await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/tagged", title: "带标签的" });
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/untagged", title: "无标签的" });
    await c.bookmarks.updateTags({ bookmarkId: tagged.id, attach: [{ tagName: "searchable" }], detach: [] });

    const byHash = await c.bookmarks.searchBookmarks({ text: "#searchable" });
    expect(byHash.bookmarks.map((b) => b.id)).toEqual([tagged.id]);

    const byQualifier = await c.bookmarks.searchBookmarks({ text: "tag:searchable 带标签" });
    expect(byQualifier.bookmarks.map((b) => b.id)).toEqual([tagged.id]);

    // 标签命中但裸词不命中 -> 空
    const miss = await c.bookmarks.searchBookmarks({ text: "tag:searchable 无标签" });
    expect(miss.bookmarks).toEqual([]);
  });

  it("结果带 tags 且分页游标单调推进", async () => {
    await reset();
    const c = await caller();
    for (let i = 0; i < 3; i++) {
      const bm = await c.bookmarks.createBookmark({
        type: "link",
        url: `https://example.com/page-${i}`,
        title: `分页 ${i}`,
      });
      if (i === 0) {
        await c.bookmarks.updateTags({ bookmarkId: bm.id, attach: [{ tagName: "paged" }], detach: [] });
      }
    }

    const page1 = await c.bookmarks.searchBookmarks({ text: "分页", limit: 2 });
    expect(page1.bookmarks).toHaveLength(2);
    expect(page1.nextCursor).toEqual({ ver: 1, offset: 2 });

    const page2 = await c.bookmarks.searchBookmarks({ text: "分页", limit: 2, cursor: page1.nextCursor });
    expect(page2.bookmarks).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.bookmarks, ...page2.bookmarks].map((b) => b.id);
    expect(new Set(all).size).toBe(3);
  });

  it("url:/title:/source:/after:/before: 限定符", async () => {
    await reset();
    const c = await caller();
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/qual-a", title: "AAA", source: "api" });
    await c.bookmarks.createBookmark({ type: "link", url: "https://example.com/qual-b", title: "BBB", source: "web" });

    expect((await c.bookmarks.searchBookmarks({ text: "title:AAA" })).bookmarks).toHaveLength(1);
    expect((await c.bookmarks.searchBookmarks({ text: "url:qual-b" })).bookmarks).toHaveLength(1);
    expect((await c.bookmarks.searchBookmarks({ text: "source:web" })).bookmarks).toHaveLength(1);

    const after = await c.bookmarks.searchBookmarks({ text: "after:2000-01-01" });
    expect(after.bookmarks).toHaveLength(2);
    const before = await c.bookmarks.searchBookmarks({ text: "before:2000-01-01" });
    expect(before.bookmarks).toEqual([]);
  });

  it("语义搜索未启用时报 BAD_REQUEST", async () => {
    await reset();
    const c = await caller();
    await expect(c.bookmarks.searchBookmarks({ text: "x", searchMode: "semantic" })).rejects.toThrow(
      /Semantic search is not enabled/,
    );
  });
});
