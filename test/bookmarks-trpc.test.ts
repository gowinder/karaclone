import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { sha256Hex } from "../src/auth/api-key";
import { renderReaderHtml } from "../src/bookmarks/reader-html";

const USER_ID = "user_bm";
const KEY_ID = "112233445566778899aa";
const SECRET = "112233445566778899aabbccddeeff00";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Bm User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_bm", USER_ID, KEY_ID, hash, "bm key", Date.now())
    .run();
}

async function caller() {
  const req = new Request("https://example.com/trpc/", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

describe("bookmarks tRPC", () => {
  it("createBookmark 返回锁定响应", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/article?utm_source=x",
      title: "Example",
      source: "extension",
    });
    expect(created.alreadyExists).toBe(false);
    expect(created.content.type).toBe("link");
    if (created.content.type === "link") {
      expect(created.content.url).toBe("https://example.com/article?utm_source=x");
      expect(created.content.title).toBe("Example");
      expect(created.content.description).toBeNull();
      expect(created.content.htmlContent).toBeNull();
      expect(created.content.crawlStatus).toBe("pending");
    }
    expect(created.taggingStatus).toBe("pending");
    expect(created.summarizationStatus).toBeNull();
    expect(created.embeddingStatus).toBeNull();
    expect(created.summary).toBeNull();
    expect(created.tags).toEqual([]);
    expect(created.assets).toEqual([]);
    expect(created.archived).toBe(false);
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it("checkUrl 精确返回 { bookmarkId: string|null }", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/checkme?utm_source=x",
      source: "extension",
    });
    // canonicalize 保留 query：相同 URL 命中
    const hit = await c.bookmarks.checkUrl({ url: "https://example.com/checkme?utm_source=x" });
    expect(hit).toEqual({ bookmarkId: created.id });
    const miss = await c.bookmarks.checkUrl({ url: "https://example.com/nope" });
    expect(miss).toEqual({ bookmarkId: null });
  });

  it("getBookmarks 返回 bookmarks 与 nextCursor", async () => {
    await seed();
    const c = await caller();
    const res = await c.bookmarks.getBookmarks({
      archived: false,
      sortOrder: "desc",
      useCursorV2: true,
      includeContent: false,
      cursor: null,
    });
    expect(Array.isArray(res.bookmarks)).toBe(true);
    expect("nextCursor" in res).toBe(true);
  });

  it("getBookmark 详情含锁定 nullable 字段", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/detail",
      title: "Detail",
      source: "extension",
    });
    const detail = await c.bookmarks.getBookmark({ bookmarkId: created.id, includeContent: true });
    expect(detail.content.type).toBe("link");
    if (detail.content.type === "link") {
      expect(detail.content.htmlContent).toContain("<article>");
      expect(detail.content.htmlContent).toContain("Detail");
    }
    expect(detail.tags).toEqual([]);
    expect(detail.assets).toEqual([]);
    expect(detail.note).toBeNull();
    expect(detail.archived).toBe(false);
  });

  it("阅读进度读写精确往返", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/progress",
      source: "extension",
    });
    await c.bookmarks.updateReadingProgress({
      bookmarkId: created.id,
      readingProgressOffset: 42,
      readingProgressAnchor: null,
      readingProgressPercent: 42,
    });
    const progress = await c.bookmarks.getReadingProgress({ bookmarkId: created.id });
    expect(progress).toEqual({
      readingProgressOffset: 42,
      readingProgressAnchor: null,
      readingProgressPercent: 42,
    });
  });
});

describe("reader html", () => {
  it("标题/URL/摘要 HTML escape", () => {
    const html = renderReaderHtml({
      title: '<script>alert(1)</script>',
      url: 'https://example.com/"onclick="x',
      summary: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("javascript: URL 拒绝渲染", () => {
    expect(() => renderReaderHtml({ title: "x", url: "javascript:alert(1)", summary: null })).toThrow("READER_URL_INVALID");
  });
});

describe("bookmarks.updateTags（官方客户端添加/移除标签）", () => {
  it("attach 按 tagName 新建标签并关联，detach 移除", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/tags-test",
      title: "Tags Test",
      source: "extension",
    });

    // 新建标签（扩展 Create 流程：attach 只传 tagName）
    const res1 = await c.bookmarks.updateTags({
      bookmarkId: created.id,
      attach: [{ tagName: "  #新标签  " }],
      detach: [],
    });
    expect(res1.attached).toHaveLength(1);
    const tagRow = await env.DB.prepare("SELECT id, name FROM tags WHERE user_id = ? AND name = ?")
      .bind(USER_ID, "新标签")
      .first<{ id: string; name: string }>();
    expect(tagRow).toBeTruthy();
    expect(res1.attached[0]).toBe(tagRow!.id);

    // 已存在标签按 tagId 再 attach（幂等）
    const res2 = await c.bookmarks.updateTags({
      bookmarkId: created.id,
      attach: [{ tagId: tagRow!.id }],
      detach: [],
    });
    expect(res2.attached).toHaveLength(1);

    const links = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?",
    ).bind(created.id, tagRow!.id).first<{ n: number }>();
    expect(links?.n).toBe(1);

    // detach 移除
    const res3 = await c.bookmarks.updateTags({
      bookmarkId: created.id,
      attach: [],
      detach: [{ tagId: tagRow!.id }],
    });
    expect(res3.detached).toEqual([tagRow!.id]);
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?",
    ).bind(created.id, tagRow!.id).first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it("attachedBy 默认 human，可指定 ai", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/tags-ai",
      title: "Tags AI",
      source: "extension",
    });
    await c.bookmarks.updateTags({
      bookmarkId: created.id,
      attach: [{ tagName: "ai标签", attachedBy: "ai" }],
      detach: [],
    });
    const row = await env.DB.prepare(
      "SELECT bt.attached_by FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ? AND t.name = 'ai标签'",
    ).bind(created.id).first<{ attached_by: string }>();
    expect(row?.attached_by).toBe("ai");
  });

  it("书签不存在时报错", async () => {
    await seed();
    const c = await caller();
    await expect(
      c.bookmarks.updateTags({ bookmarkId: "no_such_bm", attach: [{ tagName: "x" }], detach: [] }),
    ).rejects.toThrow("BOOKMARK_NOT_FOUND");
  });
});

describe("getBookmarks 排序", () => {
  it("sortOrder desc 默认最新在前，asc 最旧在前", async () => {
    await seed();
    const c = await caller();
    // 建 3 个不同时间的书签（直接插库控制 created_at）
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO bookmarks (id, user_id, canonical_url, title, archived, favourited, source, crawl_status, tagging_status, created_at) VALUES (?, ?, ?, ?, 0, 0, 'extension', 'success', 'success', ?)"
      ).bind(id, USER_ID, "https://example.com/sort" + i, "Sort " + i, 1000 + i * 1000).run();
      ids.push(id);
    }
    const desc = await c.bookmarks.getBookmarks({ sortOrder: "desc", limit: 10 });
    const asc = await c.bookmarks.getBookmarks({ sortOrder: "asc", limit: 10 });
    const descTitles = desc.bookmarks.filter(b => ids.includes(b.id)).map(b => b.title);
    const ascTitles = asc.bookmarks.filter(b => ids.includes(b.id)).map(b => b.title);
    expect(descTitles).toEqual(["Sort 2", "Sort 1", "Sort 0"]);
    expect(ascTitles).toEqual(["Sort 0", "Sort 1", "Sort 2"]);
    // 清理
    await env.DB.prepare("DELETE FROM bookmarks WHERE id IN (?, ?, ?)").bind(...ids).run();
  });
});
