import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { hashPassword, verifyPassword } from "../src/auth/password";

async function caller(bearer?: string) {
  const req = new Request("https://example.com/trpc/x", {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

describe("password hashing (PBKDF2)", () => {
  it("hash/verify 往返成功", async () => {
    const { hash, salt } = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyPassword("correct horse battery staple", hash, salt)).toBe(true);
  });

  it("错误密码返回 false", async () => {
    const { hash, salt } = await hashPassword("password123");
    expect(await verifyPassword("password124", hash, salt)).toBe(false);
  });

  it("salt 随机：同密码两次哈希不同", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("空存储值返回 false", async () => {
    expect(await verifyPassword("x", "", "")).toBe(false);
  });
});

describe("users.create 注册", () => {
  it("注册成功返回 id/name/email/role", async () => {
    const c = await caller();
    const user = await c.users.create({
      name: "Test User",
      email: "signup@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    expect(user).toMatchObject({ name: "Test User", email: "signup@test.com", role: "user" });
    expect(user.id).toBeTruthy();
  });

  it("密码不落明文，存 PBKDF2 哈希", async () => {
    const c = await caller();
    await c.users.create({
      name: "Hash Check",
      email: "hashcheck@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    const row = await env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE email = ?")
      .bind("hashcheck@test.com")
      .first<{ password_hash: string; password_salt: string }>();
    expect(row?.password_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.password_hash).not.toContain("password123");
    expect(row?.password_salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("重复 email → CONFLICT", async () => {
    const c = await caller();
    await c.users.create({
      name: "Dup",
      email: "dup@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    await expect(
      c.users.create({
        name: "Dup2",
        email: "dup@test.com",
        password: "password123",
        confirmPassword: "password123",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("密码与确认不一致 → 校验错误", async () => {
    const c = await caller();
    await expect(
      c.users.create({
        name: "Mismatch",
        email: "mismatch@test.com",
        password: "password123",
        confirmPassword: "password124",
      }),
    ).rejects.toThrow();
  });

  it("密码过短 → 校验错误", async () => {
    const c = await caller();
    await expect(
      c.users.create({
        name: "Short",
        email: "short@test.com",
        password: "short",
        confirmPassword: "short",
      }),
    ).rejects.toThrow();
  });
});

describe("apiKeys.exchange 登录换 key", () => {
  it("正确凭据返回 ak2_ key，可立即用于 protected procedure", async () => {
    const c = await caller();
    await c.users.create({
      name: "Exchange User",
      email: "exchange@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    const key = await c.apiKeys.exchange({
      keyName: "Extension Key",
      email: "exchange@test.com",
      password: "password123",
    });
    expect(key.key).toMatch(/^ak2_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    expect(key.scopes).toEqual(["fullaccess"]);

    const authed = await caller(key.key);
    const whoami = await authed.users.whoami();
    expect(whoami).toMatchObject({ email: "exchange@test.com", localUser: true });
  });

  it("错误密码 → UNAUTHORIZED", async () => {
    const c = await caller();
    await c.users.create({
      name: "Wrong Pass",
      email: "wrongpass@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    await expect(
      c.apiKeys.exchange({
        keyName: "K",
        email: "wrongpass@test.com",
        password: "password124",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("未知用户 → UNAUTHORIZED", async () => {
    const c = await caller();
    await expect(
      c.apiKeys.exchange({ keyName: "K", email: "nobody@test.com", password: "password123" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("key 落库且 secret 不存明文", async () => {
    const c = await caller();
    await c.users.create({
      name: "Key Store",
      email: "keystore@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    const { key } = await c.apiKeys.exchange({ keyName: "K", email: "keystore@test.com", password: "password123" });
    const match = /^ak2_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)$/.exec(key)!;
    const row = await env.DB.prepare("SELECT secret_hash FROM api_keys WHERE key_id = ?")
      .bind(match[1])
      .first<{ secret_hash: string }>();
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secret_hash).not.toContain(match[2]);
  });
});

describe("tags.list", () => {
  it("无标签返回空数组", async () => {
    const c = await caller();
    const user = await c.users.create({
      name: "Empty Tags",
      email: "emptytags@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    const { key } = await c.apiKeys.exchange({ keyName: "K", email: "emptytags@test.com", password: "password123" });
    const authed = await caller(key);
    const res = await authed.tags.list({});
    // total 是 karaclone 给仪表盘标签筛选器加的扩展字段
    expect(res).toEqual({ tags: [], nextCursor: null, total: 0 });
  });

  it("返回用户标签及书签计数", async () => {
    const c = await caller();
    const user = await c.users.create({
      name: "Tag User",
      email: "tags@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    const { key } = await c.apiKeys.exchange({ keyName: "K", email: "tags@test.com", password: "password123" });
    const authed = await caller(key);

    await env.DB.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("tag_1", user.id, "work", Date.now())
      .run();
    await env.DB.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("tag_2", user.id, "personal", Date.now())
      .run();

    const res = await authed.tags.list({});
    expect(res.tags).toHaveLength(2);
    expect(res.tags.map((t) => t.name).sort()).toEqual(["personal", "work"]);
    expect(res.tags[0]).toMatchObject({ numBookmarks: 0, numBookmarksByAttachedType: { ai: 0, human: 0 } });
  });

  it("只返回当前用户的标签", async () => {
    const c = await caller();
    const userA = await c.users.create({
      name: "A",
      email: "tag-a@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    const userB = await c.users.create({
      name: "B",
      email: "tag-b@test.com",
      password: "password123",
      confirmPassword: "password123",
    });
    await env.DB.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("tag_a1", userA.id, "a-only", Date.now())
      .run();
    await env.DB.prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("tag_b1", userB.id, "b-only", Date.now())
      .run();

    const { key } = await c.apiKeys.exchange({ keyName: "K", email: "tag-a@test.com", password: "password123" });
    const authed = await caller(key);
    const res = await authed.tags.list({});
    expect(res.tags).toHaveLength(1);
    expect(res.tags[0].name).toBe("a-only");
  });
});
