import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createBookmark,
  getBookmarks,
  getReadingProgress,
  updateReadingProgress,
} from "../src/bookmarks/service";

const USER_ID = "user_svc";
const sends: unknown[] = [];
const fakeQueue = {
  send: async (payload: unknown) => {
    sends.push(payload);
  },
};

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Svc User", null, Date.now())
    .run();
  // 测试间共享 D1：清空该用户残留数据保证计数精确
  await env.DB.prepare("DELETE FROM bookmarks WHERE user_id = ?").bind(USER_ID).run();
}

describe("bookmarks service", () => {
  it("创建 URL 入队一次", async () => {
    await seed();
    sends.length = 0;
    const first = await createBookmark(env.DB, fakeQueue, {
      userId: USER_ID,
      url: "https://example.com/a",
      title: "A",
      source: "extension",
    });
    expect(first.created).toBe(true);
    expect(sends).toHaveLength(1);
    const msg = sends[0] as Record<string, unknown>;
    expect(Object.keys(msg).sort()).toEqual(["bookmarkId", "jobId", "requestedAt", "urlSnapshot"]);
  });

  it("canonical 去重：同用户重复保存不重复入队", async () => {
    await seed();
    sends.length = 0;
    const first = await createBookmark(env.DB, fakeQueue, {
      userId: USER_ID,
      url: "https://example.com/dup#frag",
      title: "First",
      source: "extension",
    });
    const second = await createBookmark(env.DB, fakeQueue, {
      userId: USER_ID,
      url: "https://example.com/dup",
      title: "Second",
      source: "extension",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(sends).toHaveLength(1);
  });

  it("不同用户可保存同 URL", async () => {
    await seed();
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
      .bind("user_svc2", "U2", null, Date.now())
      .run();
    sends.length = 0;
    const a = await createBookmark(env.DB, fakeQueue, { userId: USER_ID, url: "https://example.com/shared", source: "extension" });
    const b = await createBookmark(env.DB, fakeQueue, { userId: "user_svc2", url: "https://example.com/shared", source: "extension" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(sends).toHaveLength(2);
  });

  it("分页稳定：limit+1 判定下一页", async () => {
    await seed();
    sends.length = 0;
    for (let i = 0; i < 25; i++) {
      await createBookmark(env.DB, fakeQueue, { userId: USER_ID, url: `https://example.com/p${i}`, source: "extension" });
    }
    const page1 = await getBookmarks(env.DB, USER_ID, { limit: 20, cursor: null, archived: false });
    expect(page1.bookmarks).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await getBookmarks(env.DB, USER_ID, { limit: 20, cursor: page1.nextCursor, archived: false });
    expect(page2.bookmarks).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    expect(page2.bookmarks[0]?.id).not.toBe(page1.bookmarks.at(-1)?.id);
  });

  it("归档过滤", async () => {
    await seed();
    sends.length = 0;
    const bm = await createBookmark(env.DB, fakeQueue, { userId: USER_ID, url: "https://example.com/arch", source: "extension" });
    await env.DB.prepare("UPDATE bookmarks SET archived = 1 WHERE id = ?").bind(bm.bookmark.id).run();
    const active = await getBookmarks(env.DB, USER_ID, { limit: 20, cursor: null, archived: false });
    expect(active.bookmarks.some((b) => b.id === bm.bookmark.id)).toBe(false);
    const archived = await getBookmarks(env.DB, USER_ID, { limit: 20, cursor: null, archived: true });
    expect(archived.bookmarks.some((b) => b.id === bm.bookmark.id)).toBe(true);
  });

  it("阅读进度 upsert", async () => {
    await seed();
    sends.length = 0;
    const bm = await createBookmark(env.DB, fakeQueue, { userId: USER_ID, url: "https://example.com/prog", source: "extension" });
    await updateReadingProgress(env.DB, {
      userId: USER_ID,
      bookmarkId: bm.bookmark.id,
      readingProgressOffset: 42,
      readingProgressAnchor: null,
      readingProgressPercent: 42,
    });
    const progress = await getReadingProgress(env.DB, USER_ID, bm.bookmark.id);
    expect(progress).toEqual({
      readingProgressOffset: 42,
      readingProgressAnchor: null,
      readingProgressPercent: 42,
    });
  });
});
