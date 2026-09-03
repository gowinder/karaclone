import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import type { AppRouter } from "../src/trpc/router";
import { sha256Hex } from "../src/auth/api-key";

const USER_ID = "user_http";
const KEY_ID = "99887766554433221100";
const SECRET = "99887766554433221100aabbccddeeff";
const VALID_KEY = `ak2_${KEY_ID}_${SECRET}`;

async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(USER_ID, "Http User", null, Date.now())
    .run();
  const hash = await sha256Hex(SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_http", USER_ID, KEY_ID, hash, "http key", Date.now())
    .run();
}

describe("HTTP batch link", () => {
  it("同一批 query/mutation 经 httpBatchLink 成功", async () => {
    await seed();
    const client = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: "https://example.com/api/trpc",
          headers: { Authorization: `Bearer ${VALID_KEY}` },
          transformer: superjson,
          fetch: (input, init) => SELF.fetch(input, init),
        }),
      ],
    });

    const whoami = await client.users.whoami.query();
    expect(whoami).toMatchObject({ id: USER_ID, localUser: true });

    const created = await client.bookmarks.createBookmark.mutate({
      type: "link",
      url: "https://example.com/batch",
      title: "Batch",
      source: "extension",
    });
    expect(created.alreadyExists).toBe(false);
    expect(created.createdAt).toBeInstanceOf(Date);

    const list = await client.bookmarks.getBookmarks.query({
      archived: false,
      sortOrder: "desc",
      useCursorV2: true,
      includeContent: false,
      cursor: null,
    });
    expect(list.bookmarks.length).toBeGreaterThan(0);
  });

  it("单项错误 envelope：错误 key → UNAUTHORIZED", async () => {
    await seed();
    const client = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: "https://example.com/api/trpc",
          headers: { Authorization: `Bearer ${VALID_KEY}x` },
          transformer: superjson,
          fetch: (input, init) => SELF.fetch(input, init),
        }),
      ],
    });
    await expect(client.users.whoami.query()).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  });
});
