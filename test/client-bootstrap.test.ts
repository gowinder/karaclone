import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { sha256Hex } from "../src/auth/api-key";

const USER_ID = "user_boot";
const KEY_ID = "aabbccddeeff00112233";
const SECRET = "aabbccddeeff00112233445566778899";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Boot User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_boot", USER_ID, KEY_ID, hash, "boot key", Date.now())
    .run();
}

async function caller(bearer?: string) {
  const req = new Request("https://example.com/trpc/", {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

describe("client bootstrap", () => {
  it("config.clientConfig 匿名可访问且字段锁定", async () => {
    const c = await caller();
    const clientConfig = await c.config.clientConfig();
    expect(clientConfig.serverVersion).toBe("0.1.0");
    expect(clientConfig.publicApiUrl).toBe("https://example.com");
    expect(clientConfig.inference).toMatchObject({ isConfigured: true, inferredTagLang: "zh-CN" });
    expect(clientConfig.auth).toMatchObject({ disableSignups: true, disablePasswordAuth: true });
    expect(clientConfig.disableNewReleaseCheck).toBe(true);
  });

  it("apiKeys.validate 接收 { apiKey }", async () => {
    await seed();
    const c = await caller();
    const validate = await c.apiKeys.validate({ apiKey: VALID_KEY });
    expect(validate).toEqual({ success: true });
  });

  it("apiKeys.validate 错误 key → UNAUTHORIZED", async () => {
    await seed();
    const c = await caller();
    await expect(c.apiKeys.validate({ apiKey: VALID_KEY + "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("users.whoami 需认证", async () => {
    await seed();
    const anon = await caller();
    await expect(anon.users.whoami()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const c = await caller(VALID_KEY);
    const whoami = await c.users.whoami();
    expect(whoami).toMatchObject({ id: USER_ID, email: null, image: null, localUser: true });
  });

  it("users.settings 需认证且返回完整设置", async () => {
    await seed();
    const anon = await caller();
    await expect(anon.users.settings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const c = await caller(VALID_KEY);
    const settings = await c.users.settings();
    expect(settings).toMatchObject({ archiveDisplayBehaviour: "show", bookmarkClickAction: "open_original_link" });
    expect(settings.tagStyle).toBe("lowercase-spaces");
    expect(settings.inferredTagLang).toBe("zh-CN");
  });

  it("apiKeys.exchange → FORBIDDEN 精确消息", async () => {
    const c = await caller();
    await expect(c.apiKeys.exchange({ keyName: "x", email: "a@b.c", password: "password123" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Password authentication is disabled",
    });
  });

  it("apiKeys.revoke 幂等无输出，吊销后鉴权失败", async () => {
    await seed();
    const c = await caller(VALID_KEY);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND user_id = ?").bind(USER_ID).first<{ n: number }>();
    expect(before?.n).toBe(1);

    // 正确 id 吊销
    const row = await env.DB.prepare("SELECT id FROM api_keys WHERE user_id = ?").bind(USER_ID).first<{ id: string }>();
    const result = await c.apiKeys.revoke({ id: row!.id });
    expect(result).toBeUndefined();

    // 重复吊销幂等
    await expect(c.apiKeys.revoke({ id: row!.id })).resolves.toBeUndefined();
    // 错误 id 幂等
    await expect(c.apiKeys.revoke({ id: "nonexistent" })).resolves.toBeUndefined();

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND user_id = ?").bind(USER_ID).first<{ n: number }>();
    expect(after?.n).toBe(0);

    // 吊销后原 key 鉴权失败
    const c2 = await caller(VALID_KEY);
    await expect(c2.users.whoami()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
