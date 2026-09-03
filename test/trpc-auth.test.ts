import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { router, publicProcedure, protectedProcedure } from "../src/trpc/base";
import { sha256Hex } from "../src/auth/api-key";

const USER_ID = "user_trpc";
const KEY_ID = "fedcba9876543210fedc";
const SECRET = "fedcba9876543210fedcba9876543210";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Trpc User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_trpc", USER_ID, KEY_ID, hash, "trpc key", Date.now())
    .run();
}

const testRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ctx.user),
  ping: publicProcedure.query(() => "pong"),
});

async function call(path: string, bearer?: string) {
  const req = new Request("https://example.com/trpc/" + path, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return testRouter.createCaller(ctx);
}

describe("tRPC auth envelope", () => {
  it("公开 procedure 允许匿名", async () => {
    const caller = await call("ping");
    expect(await caller.ping()).toBe("pong");
  });

  it("protected procedure 无 Bearer → UNAUTHORIZED", async () => {
    const caller = await call("whoami");
    await expect(caller.whoami()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("protected procedure 有效 key 通过", async () => {
    await seed();
    const caller = await call("whoami", VALID_KEY);
    const user = await caller.whoami();
    expect(user).toMatchObject({ id: USER_ID });
  });

  it("protected procedure 错误 key → UNAUTHORIZED", async () => {
    await seed();
    const caller = await call("whoami", VALID_KEY + "x");
    await expect(caller.whoami()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
