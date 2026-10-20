import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { sha256Hex } from "../src/auth/api-key";

const USER_ID = "user_compat";
const KEY_ID = "c0ffee1234567890abcd";
const SECRET = "c0ffee1234567890abcdef0011223344";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;
const EXT_ORIGIN = "chrome-extension://kgcjekpmcjjogibpjebkhaanilehneje";

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Compat User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_compat", USER_ID, KEY_ID, hash, "compat key", Date.now())
    .run();
}

async function caller() {
  const req = new Request("https://example.com/trpc/", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, init);
}

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchWorker(path, init);
  return res.json();
}

describe("compat 只读空能力", () => {
  it("lists.list / getListsOfBookmark / stats 空结果", async () => {
    await seed();
    const c = await caller();
    expect(await c.lists.list()).toEqual({ lists: [] });
    expect(await c.lists.getListsOfBookmark({ bookmarkId: "bm_1" })).toEqual({ lists: [] });
    const stats = await c.lists.stats();
    expect(stats.stats).toBeInstanceOf(Map);
    expect(stats.stats.size).toBe(0);
  });

  it("highlights.getAll / getForBookmark 空结果", async () => {
    await seed();
    const c = await caller();
    expect(await c.highlights.getForBookmark({ bookmarkId: "bm_1" })).toEqual({ highlights: [] });
    expect(await c.highlights.getAll({ cursor: null })).toEqual({ highlights: [], nextCursor: null });
  });

  it("rules.list / assets.list 空结果", async () => {
    await seed();
    const c = await caller();
    expect(await c.rules.list()).toEqual({ rules: [] });
    expect(await c.assets.list({ limit: 20, cursor: null })).toEqual({
      assets: [],
      nextCursor: null,
      totalCount: 0,
    });
  });
});

describe("compat mutation 拒绝", () => {
  it("lists/highlights/rules/assets mutation → BAD_REQUEST", async () => {
    await seed();
    const c = await caller();
    const badRequest = { code: "BAD_REQUEST" };
    await expect(c.lists.create({ name: "x" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.lists.edit({ listId: "l1", name: "x" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.lists.delete({ listId: "l1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.lists.addToList({ bookmarkId: "b1", listId: "l1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.lists.removeFromList({ bookmarkId: "b1", listId: "l1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.highlights.create({ bookmarkId: "b1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.highlights.delete({ highlightId: "h1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.highlights.update({ highlightId: "h1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.rules.create({} as never)).rejects.toMatchObject(badRequest);
    await expect(c.rules.update({ id: "r1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.rules.delete({ id: "r1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.assets.attachAsset({ bookmarkId: "b1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.assets.replaceAsset({ assetId: "a1" } as never)).rejects.toMatchObject(badRequest);
    await expect(c.assets.detachAsset({ assetId: "a1" } as never)).rejects.toMatchObject(badRequest);
  });

  it("users.create 校验失败 / deleteAccount / changePassword → 拒绝", async () => {
    await seed();
    const c = await caller();
    const forbidden = { code: "FORBIDDEN" };
    // create 已实现：缺字段 → 校验错误；deleteAccount/changePassword 仍 FORBIDDEN
    await expect(c.users.create({ name: "x" } as never)).rejects.toThrow();
    await expect(c.users.deleteAccount({ password: "x" } as never)).rejects.toMatchObject(forbidden);
    await expect(c.users.changePassword({ currentPassword: "a", newPassword: "b" } as never)).rejects.toMatchObject(forbidden);
  });
});

describe("compat HTTP 路由", () => {
  it("/api/health 与 /api/version", async () => {
    expect(await json("/api/health")).toEqual({ status: "ok", message: "Web app is working" });
    expect(await json("/api/version")).toEqual({ version: "0.2.2" });
  });

  it("/api/unknown → 404 JSON", async () => {
    const res = await fetchWorker("/api/unknown");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("/dashboard/preview/:id → text/html；不存在 → 404 HTML", async () => {
    await seed();
    const c = await caller();
    const created = await c.bookmarks.createBookmark({
      type: "link",
      url: "https://example.com/preview",
      title: "Preview",
      source: "extension",
    });
    const res = await fetchWorker(`/dashboard/preview/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const missing = await fetchWorker("/dashboard/preview/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/html");
  });
});

describe("compat CORS", () => {
  it("无 Origin 移动端请求正常", async () => {
    await seed();
    const res = await fetchWorker("/api/trpc/users.whoami", {
      method: "GET",
      headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("扩展 Origin OPTIONS 预检动态回显请求头", async () => {
    const res = await fetchWorker("/api/trpc/users.whoami", {
      method: "OPTIONS",
      headers: {
        Origin: EXT_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, x-kara-clone-phase0",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("x-kara-clone-phase0");
  });

  it("带 X-KaraClone-Phase0 头的真实 tRPC 请求成功", async () => {
    await seed();
    const res = await fetchWorker("/api/trpc/users.whoami", {
      method: "GET",
      headers: {
        Origin: EXT_ORIGIN,
        Authorization: `Bearer ${VALID_KEY}`,
        "X-KaraClone-Phase0": "1",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
  });

  it("非法 header name 不返回 CORS allow header", async () => {
    const res = await fetchWorker("/api/trpc/users.whoami", {
      method: "OPTIONS",
      headers: {
        Origin: EXT_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "bad header name",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("随机网页 Origin 不返回 CORS allow header", async () => {
    const res = await fetchWorker("/api/trpc/users.whoami", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
