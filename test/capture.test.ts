import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { shapeOf } from "../src/phase0/capture";
import { sha256Hex } from "../src/auth/api-key";

const ADMIN_USER_ID = "user_cap_admin";
const ADMIN_KEY_ID = "deadbeef1234567890ab";
const ADMIN_SECRET = "deadbeef1234567890abcdef12345678";
const ADMIN_KEY = `ak2_${ADMIN_KEY_ID}_${ADMIN_SECRET}`;

const RUN_ID = "test-run-001";
const CLIENT = "contract";

async function seedAdmin() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(ADMIN_USER_ID, "Cap Admin", null, Date.now())
    .run();
  const hash = await sha256Hex(ADMIN_SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_cap_admin", ADMIN_USER_ID, ADMIN_KEY_ID, hash, "cap admin", Date.now())
    .run();
}

async function captureStart(runId: string, client: string): Promise<Response> {
  return SELF.fetch("https://example.com/__phase0/capture/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ runId, client }),
  });
}

async function captureStop(): Promise<Response> {
  return SELF.fetch("https://example.com/__phase0/capture/stop", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
}

async function captureStatus(): Promise<{ enabled: boolean; runId: string | null; client: string | null; counts: Record<string, number>; unknownProcedures: number }> {
  const res = await SELF.fetch("https://example.com/__phase0/capture/status", {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  return res.json() as Promise<typeof captureStatus extends () => Promise<infer T> ? T : never>;
}

describe("shapeOf 脱敏", () => {
  it("值脱敏为类型名，URL 为 url", () => {
    expect(shapeOf({ url: "https://x.test/a?token=secret", title: "Private" })).toEqual({
      url: "url",
      title: "string",
    });
  });

  it("数组/Date/null/嵌套对象形状", () => {
    expect(shapeOf({ tags: ["a", "b"], at: new Date("2026-01-01T00:00:00Z"), n: null, nested: { a: 1 } })).toEqual({
      tags: { type: "array", item: "string" },
      at: "date",
      n: "null",
      nested: { a: "number" },
    });
  });

  it("对象 key 排序保证 diff 稳定", () => {
    const a = shapeOf({ z: 1, a: 2, m: 3 });
    expect(Object.keys(a)).toEqual(["a", "m", "z"]);
  });

  it("事件 JSON 不含敏感值", () => {
    const event = {
      input_shape: JSON.stringify(shapeOf({ url: "https://x.test/a?token=secret", title: "Private" })),
      output_shape: JSON.stringify(shapeOf({ bookmarkId: "bm_secret_1" })),
    };
    const s = JSON.stringify(event);
    expect(s).not.toContain("secret");
    expect(s).not.toContain("Private");
    expect(s).not.toContain("bm_secret_1");
  });
});

describe("capture 控制接口", () => {
  it("start 后 status 显示 enabled 与计数", async () => {
    await seedAdmin();
    await captureStart(RUN_ID, CLIENT);
    const status = await captureStatus();
    expect(status.enabled).toBe(true);
    expect(status.runId).toBe(RUN_ID);
    expect(status.client).toBe(CLIENT);
  });

  it("stop 后 enabled=false", async () => {
    await seedAdmin();
    await captureStart(RUN_ID, CLIENT);
    await captureStop();
    const status = await captureStatus();
    expect(status.enabled).toBe(false);
  });

  it("非法 runId 拒绝", async () => {
    await seedAdmin();
    const res = await captureStart("bad run id with spaces!", CLIENT);
    expect(res.status).toBe(400);
  });

  it("无 Bearer 拒绝", async () => {
    await seedAdmin();
    const res = await SELF.fetch("https://example.com/__phase0/capture/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: RUN_ID, client: CLIENT }),
    });
    expect(res.status).toBe(401);
  });
});

describe("capture 事件写入", () => {
  it("start 后 tRPC 调用写入 protocol_events 且无敏感值", async () => {
    await seedAdmin();
    await captureStart(RUN_ID, CLIENT);
    // 触发一次真实 tRPC 调用（匿名 config 即可）
    const res = await SELF.fetch("https://example.com/api/trpc/config.clientConfig", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    await captureStop();
    const rows = await env.DB.prepare(
      "SELECT procedure, procedure_type, input_shape, output_shape, error_code FROM protocol_events WHERE run_id = ?",
    )
      .bind(RUN_ID)
      .all<{ procedure: string; procedure_type: string; input_shape: string; output_shape: string | null; error_code: string | null }>();
    expect(rows.results.length).toBeGreaterThan(0);
    const joined = JSON.stringify(rows.results);
    expect(joined).not.toContain("Bearer");
    expect(joined).not.toContain(ADMIN_KEY);
  });

  it("stop 后 tRPC 调用不写事件（enabled=0 条件）", async () => {
    await seedAdmin();
    await captureStart(RUN_ID, CLIENT);
    await captureStop();
    const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_events WHERE run_id = ?")
      .bind(RUN_ID)
      .first<{ c: number }>();
    await SELF.fetch("https://example.com/api/trpc/config.clientConfig", { method: "GET" });
    const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_events WHERE run_id = ?")
      .bind(RUN_ID)
      .first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });

  it("runId 不匹配不写事件", async () => {
    await seedAdmin();
    await captureStart(RUN_ID, CLIENT);
    await SELF.fetch("https://example.com/api/trpc/config.clientConfig", { method: "GET" });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_events WHERE run_id = ?")
      .bind("other-run")
      .first<{ c: number }>();
    expect(rows!.c).toBe(0);
    await captureStop();
  });

  it("HTTP 事件记录 fixed_test_header_seen 与 CORS 布尔", async () => {
    await seedAdmin();
    await captureStart(RUN_ID, "extension");
    await SELF.fetch("https://example.com/api/trpc/config.clientConfig", {
      method: "GET",
      headers: {
        Origin: "chrome-extension://kgcjekpmcjjogibpjebkhaanilehneje",
        "X-KaraClone-Phase0": "1",
      },
    });
    await captureStop();
    const rows = await env.DB.prepare(
      "SELECT fixed_test_header_seen, cors_fixed_header_requested, cors_fixed_header_allowed, cors_origin_matched FROM protocol_http_events WHERE run_id = ?",
    )
      .bind(RUN_ID)
      .all<{ fixed_test_header_seen: number; cors_fixed_header_requested: number | null; cors_fixed_header_allowed: number | null; cors_origin_matched: number | null }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(rows.results[0]!.fixed_test_header_seen).toBe(1);
    expect(rows.results[0]!.cors_origin_matched).toBe(1);
  });
});
