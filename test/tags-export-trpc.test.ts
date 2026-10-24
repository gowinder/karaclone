import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { sha256Hex } from "../src/auth/api-key";
import { buildExportFileName, buildTxtExport, tagNameToSlug } from "../src/trpc/routers/tags";

// 按标签一键导出 URL（txt，一行一个）。
// 注意：api_keys.key_id 是 UNIQUE，测试 KEY_ID 必须全局唯一——与 client-bootstrap
// 撞号会让对方的 INSERT OR IGNORE 静默失败，报出与导出功能无关的 4 个连锁失败。
const USER_ID = "user_export";
const KEY_ID = "exp0rt5keyid000001";
const SECRET = "5ecretfor0export0tests0011223344";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Export User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)",
  )
    .bind("ak_row_export", USER_ID, KEY_ID, hash, "export key", Date.now())
    .run();
}

async function reset() {
  await seed();
  await env.DB.prepare(
    "DELETE FROM bookmark_tags WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?)",
  )
    .bind(USER_ID)
    .run();
  await env.DB.prepare("DELETE FROM bookmarks WHERE user_id = ?").bind(USER_ID).run();
  await env.DB.prepare("DELETE FROM tags WHERE user_id = ?").bind(USER_ID).run();
}

async function caller() {
  const req = new Request("https://example.com/trpc/", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

/** 建一条书签并打上指定标签，返回 { bookmarkId, tagId }。 */
async function bookmarkWithTag(
  c: Awaited<ReturnType<typeof caller>>,
  url: string,
  tagName: string,
) {
  const bm = await c.bookmarks.createBookmark({ type: "link", url, source: "api" });
  const updated = await c.bookmarks.updateTags({
    bookmarkId: bm.id,
    attach: [{ tagName, attachedBy: "human" }],
    detach: [],
  });
  return { bookmarkId: bm.id, tagId: updated.attached[0]! };
}

beforeEach(reset);

describe("tags.exportBookmarks", () => {
  it("导出该标签下全部 URL，一行一个并以换行结尾", async () => {
    const c = await caller();
    const a = await bookmarkWithTag(c, "https://example.com/one", "导出标签");
    await bookmarkWithTag(c, "https://example.com/two", "导出标签");
    // 另一个标签下的书签不应出现
    await bookmarkWithTag(c, "https://example.com/noise", "别的标签");

    const res = await c.tags.exportBookmarks({ tagId: a.tagId, format: "txt" });
    expect(res.count).toBe(2);
    expect(res.urls.sort()).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(res.content.split("\n").filter(Boolean)).toHaveLength(2);
    expect(res.content.endsWith("\n")).toBe(true);
    expect(res.content).not.toContain("noise");
    expect(res.contentType).toBe("text/plain; charset=utf-8");
    expect(res.fileName).toMatch(/^karaclone-导出标签-\d{8}\.txt$/);
  });

  it("默认不含归档书签，includeArchived 时可一并导出", async () => {
    const c = await caller();
    const a = await bookmarkWithTag(c, "https://example.com/kept", "归档标签");
    const b = await bookmarkWithTag(c, "https://example.com/gone", "归档标签");
    await c.bookmarks.updateBookmark({ bookmarkId: b.bookmarkId, archived: true });

    const active = await c.tags.exportBookmarks({ tagId: a.tagId });
    expect(active.urls).toEqual(["https://example.com/kept"]);

    const all = await c.tags.exportBookmarks({ tagId: a.tagId, includeArchived: true });
    expect(all.count).toBe(2);
    expect(all.urls.sort()).toEqual(["https://example.com/gone", "https://example.com/kept"]);
  });

  it("没有任何书签时返回空内容而不是报错", async () => {
    const c = await caller();
    // 先建标签再把书签删掉，制造「标签存在但无书签」
    const { bookmarkId, tagId } = await bookmarkWithTag(c, "https://example.com/temp", "空标签");
    await c.bookmarks.deleteBookmark({ bookmarkId });

    const res = await c.tags.exportBookmarks({ tagId });
    expect(res.count).toBe(0);
    expect(res.urls).toEqual([]);
    expect(res.content).toBe("");
  });

  it("标签不存在时 NOT_FOUND", async () => {
    const c = await caller();
    await expect(c.tags.exportBookmarks({ tagId: "no-such-tag" })).rejects.toThrow(/Tag not found/);
  });

  it("不导出他人标签下的书签", async () => {
    await seed();
    const now = Date.now();
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
      .bind("user_export_other", "Other", null, now)
      .run();
    await env.DB.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("tag_export_other", "user_export_other", "别人的标签", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO bookmarks (id, user_id, canonical_url, title, archived, favourited, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
    )
      .bind("bm_export_other", "user_export_other", "https://secret.example.com/", "secret", now)
      .run();
    await env.DB.prepare(
      "INSERT INTO bookmark_tags (bookmark_id, tag_id, attached_by, attached_at) VALUES (?, ?, 'human', ?)",
    )
      .bind("bm_export_other", "tag_export_other", now)
      .run();

    const c = await caller();
    await expect(c.tags.exportBookmarks({ tagId: "tag_export_other" })).rejects.toThrow(/Tag not found/);
  });
});

describe("tags.exportBookmarks 走 HTTP（控制台实际路径）", () => {
  it("GET + superjson input 返回可下载的 txt 内容", async () => {
    const c = await caller();
    const a = await bookmarkWithTag(c, "https://example.com/http-one", "HTTP标签");
    await bookmarkWithTag(c, "https://example.com/http-two", "HTTP标签");

    // 与 dashboard.ts 的 trpc() 助手一致的请求形状：?batch=1&input={"0":{"json":{...}}}
    const input = encodeURIComponent(JSON.stringify({ "0": { json: { tagId: a.tagId, format: "txt" } } }));
    const res = await SELF.fetch(
      `https://example.com/api/trpc/tags.exportBookmarks?batch=1&input=${input}`,
      { method: "GET", headers: { Authorization: `Bearer ${VALID_KEY}` } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as [{ result: { data: { json: Record<string, unknown> } } }];
    const data = body[0]!.result.data.json as {
      urls: string[];
      count: number;
      content: string;
      fileName: string;
      contentType: string;
    };
    expect(data.count).toBe(2);
    expect(data.urls).toHaveLength(2);
    expect(data.content.split("\n").filter(Boolean)).toHaveLength(2);
    expect(data.fileName).toMatch(/^karaclone-HTTP标签-\d{8}\.txt$/);
    expect(data.contentType).toBe("text/plain; charset=utf-8");
  });
});

describe("导出格式工具函数", () => {
  it("tagNameToSlug 保留中日韩字符并把不安全字符折叠成 -", () => {
    expect(tagNameToSlug("机器学习")).toBe("机器学习");
    expect(tagNameToSlug("Rust / Systems")).toBe("Rust-Systems");
    expect(tagNameToSlug("  a:b*c  ")).toBe("a-b-c");
    expect(tagNameToSlug("///")).toBe("tag");
    expect(tagNameToSlug("")).toBe("tag");
  });

  it("buildExportFileName 带标签名与 UTC 日期", () => {
    const name = buildExportFileName("前端", "txt", new Date("2026-10-24T06:00:00Z"));
    expect(name).toBe("karaclone-前端-20261024.txt");
  });

  it("buildTxtExport 一行为一个 URL，空列表为空串", () => {
    expect(buildTxtExport(["https://a.example.com/", "https://b.example.com/"])).toBe(
      "https://a.example.com/\nhttps://b.example.com/\n",
    );
    expect(buildTxtExport([])).toBe("");
  });
});
