import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authenticateApiKey, sha256Hex } from "../src/auth/api-key";
import { insertUser } from "../src/db/users";

const USER_ID = "user_auth";
const KEY_ID = "0123456789abcdef0123";
const SECRET = "0123456789abcdef0123456789abcdef";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Auth User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_1", USER_ID, KEY_ID, hash, "auth key", Date.now())
    .run();
}

describe("api-key auth", () => {
  it("有效 key 认证成功", async () => {
    await seed();
    const result = await authenticateApiKey(env.DB, VALID_KEY);
    expect(result).toMatchObject({ id: USER_ID });
  });

  it("错误 secret 返回 null", async () => {
    await seed();
    expect(await authenticateApiKey(env.DB, VALID_KEY + "x")).toBeNull();
  });

  it("错误格式返回 null", async () => {
    await seed();
    expect(await authenticateApiKey(env.DB, "not-a-key")).toBeNull();
    expect(await authenticateApiKey(env.DB, "ak1_k1_secret")).toBeNull();
  });

  it("已吊销 key 返回 null", async () => {
    await seed();
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ?").bind(Date.now(), KEY_ID).run();
    expect(await authenticateApiKey(env.DB, VALID_KEY)).toBeNull();
  });

  it("数据库不存明文 secret", async () => {
    await seed();
    const stored = await env.DB.prepare("SELECT secret_hash FROM api_keys WHERE key_id = ?").bind(KEY_ID).first<{ secret_hash: string }>();
    expect(stored?.secret_hash).not.toContain(SECRET);
    expect(stored?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sha256Hex 输出 64 位小写 hex", async () => {
    const hash = await sha256Hex("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
