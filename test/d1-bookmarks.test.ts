import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../src/url/canonicalize";
import { createBookmark, getBookmarkByUrl } from "../src/db/bookmarks";
import { insertUser, insertApiKey } from "../src/db/users";
import { insertJob } from "../src/db/jobs";

const USER_ID = "user_1";
const API_KEY_ID = "ak_1";

async function seedUser() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Test User", "user@example.com", Date.now())
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(API_KEY_ID, USER_ID, "k1", "deadbeef", "test key", "fullaccess", Date.now())
    .run();
}

describe("canonicalizeUrl", () => {
  it("fragment 删除", () => {
    expect(canonicalizeUrl("HTTPS://ExAmPle.com:443/a/#x")).toBe("https://example.com/a");
  });

  it("默认端口删除", () => {
    expect(canonicalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(canonicalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
  });

  it("query 顺序保留", () => {
    expect(canonicalizeUrl("https://example.com/?b=2&a=1")).toBe("https://example.com/?b=2&a=1");
  });

  it("非 http/https 拒绝", () => {
    expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow("URL_VALIDATION_FAILED");
  });

  it("尾部斜杠删除（非根路径）", () => {
    expect(canonicalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });
});

describe("D1 bookmark 契约", () => {
  it("用户/key 插入", async () => {
    await seedUser();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(USER_ID).first();
    expect(user?.email).toBe("user@example.com");
    const key = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(API_KEY_ID).first();
    expect(key?.scope).toBe("fullaccess");
  });

  it("bookmark/link/job 单 batch 创建，epoch ms → Date", async () => {
    await seedUser();
    const created = await createBookmark(env.DB, {
      userId: USER_ID,
      url: "https://example.com/docs",
      title: "Docs",
      source: "extension",
    });
    expect(created.alreadyExists).toBe(false);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.modifiedAt).toBeInstanceOf(Date);

    const link = await env.DB.prepare("SELECT * FROM bookmark_links WHERE id = ?").bind(created.id).first();
    expect(link?.url).toBe("https://example.com/docs");

    const job = await env.DB.prepare("SELECT * FROM enrichment_jobs WHERE bookmark_id = ?").bind(created.id).first();
    expect(job?.status).toBe("pending");
    expect(job?.url_snapshot).toBe("https://example.com/docs");
  });

  it("canonical URL 唯一约束：相同 URL 返回同一 bookmark", async () => {
    await seedUser();
    const first = await createBookmark(env.DB, {
      userId: USER_ID,
      url: "https://example.com/dup#frag",
      title: "First",
      source: "extension",
    });
    const second = await createBookmark(env.DB, {
      userId: USER_ID,
      url: "https://example.com/dup",
      title: "Second",
      source: "extension",
    });
    expect(first.id).toBe(second.id);
    expect(second.alreadyExists).toBe(true);
    expect(second.title).toBe("First");
  });

  it("不同用户相同 URL 各自独立", async () => {
    await seedUser();
    await insertUser(env.DB, { id: "user_2", name: "Other", email: "other@example.com" });
    const a = await createBookmark(env.DB, { userId: USER_ID, url: "https://example.com/shared", source: "extension" });
    const b = await createBookmark(env.DB, { userId: "user_2", url: "https://example.com/shared", source: "extension" });
    expect(a.id).not.toBe(b.id);
    expect(b.alreadyExists).toBe(false);
  });

  it("getBookmarkByUrl 返回 Date 字段", async () => {
    await seedUser();
    await createBookmark(env.DB, { userId: USER_ID, url: "https://example.com/lookup", source: "api" });
    const found = await getBookmarkByUrl(env.DB, USER_ID, "https://example.com/lookup");
    expect(found).not.toBeNull();
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it("insertJob 幂等：同 bookmark 只允许一个活跃 job", async () => {
    await seedUser();
    const bm = await createBookmark(env.DB, { userId: USER_ID, url: "https://example.com/job", source: "api" });
    // createBookmark 已自动建 job；再手动插入同 bookmark 的活跃 job 必须失败
    await expect(
      insertJob(env.DB, {
        id: "job_2",
        bookmarkId: bm.id,
        userId: USER_ID,
        urlSnapshot: "https://example.com/job",
      }),
    ).rejects.toThrow();
  });
});
