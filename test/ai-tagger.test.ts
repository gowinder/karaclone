// T10：Workers AI JSON Mode 运行时闸门——响应解析、二次验证、模型锁定。
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTags, parseTagResult, tagResultSchema } from "../src/ai/tag-schema";
import { runLockedTextModel } from "../src/ai/cloudflare-ai";
import { tagBookmark } from "../src/ai/tagger";
import { sha256Hex } from "../src/auth/api-key";

const ADMIN_USER_ID = "user_ai_admin";
const ADMIN_KEY_ID = "cafebabe1234567890ac";
const ADMIN_SECRET = "cafebabe1234567890abcdef12345679";
const ADMIN_KEY = `ak2_${ADMIN_KEY_ID}_${ADMIN_SECRET}`;

async function seedAdmin() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(ADMIN_USER_ID, "AI Admin", null, Date.now())
    .run();
  const hash = await sha256Hex(ADMIN_SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'fullaccess', ?)")
    .bind("ak_row_ai_admin", ADMIN_USER_ID, ADMIN_KEY_ID, hash, "ai admin", Date.now())
    .run();
}

const LOCKED_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

describe("tagResultSchema", () => {
  it("接受合法 object", () => {
    const parsed = tagResultSchema.safeParse({ tags: ["ai", "读书"], description: "笔记" });
    expect(parsed.success).toBe(true);
  });

  it("description 可为 null", () => {
    const parsed = tagResultSchema.safeParse({ tags: ["ai"], description: null });
    expect(parsed.success).toBe(true);
  });

  it("tags 1-8 个，trim 后 1-40 字符", () => {
    expect(tagResultSchema.safeParse({ tags: [], description: null }).success).toBe(false);
    expect(tagResultSchema.safeParse({ tags: ["a".repeat(41)], description: null }).success).toBe(false);
    expect(tagResultSchema.safeParse({ tags: ["  "], description: null }).success).toBe(false);
    expect(tagResultSchema.safeParse({ tags: Array.from({ length: 9 }, () => "x"), description: null }).success).toBe(false);
    expect(tagResultSchema.safeParse({ tags: ["  ai  "], description: null }).success).toBe(true);
  });

  it("description 超 300 失败", () => {
    expect(tagResultSchema.safeParse({ tags: ["ai"], description: "x".repeat(301) }).success).toBe(false);
  });

  it("缺失 tags 或 description 失败", () => {
    expect(tagResultSchema.safeParse({ tags: ["ai"] }).success).toBe(false);
    expect(tagResultSchema.safeParse({ description: null }).success).toBe(false);
  });
});

describe("parseTagResult", () => {
  it("接受 object", () => {
    const r = parseTagResult({ tags: ["ai", "读书"], description: "笔记" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tags).toEqual(["ai", "读书"]);
  });

  it("接受纯 JSON string", () => {
    const r = parseTagResult(JSON.stringify({ tags: ["ai"], description: null }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tags).toEqual(["ai"]);
  });

  it("markdown fence 必须失败", () => {
    const r = parseTagResult("```json\n{\"tags\":[\"ai\"]}\n```");
    expect(r.ok).toBe(false);
  });

  it("非 JSON 文本失败", () => {
    const r = parseTagResult("just some text");
    expect(r.ok).toBe(false);
  });

  it("缺失 tags 失败", () => {
    const r = parseTagResult({ description: "x" });
    expect(r.ok).toBe(false);
  });

  it("超长 tag 失败", () => {
    const r = parseTagResult({ tags: ["a".repeat(41)], description: null });
    expect(r.ok).toBe(false);
  });

  it("非法字符 tag 经 normalize 剔除后仍合法", () => {
    const r = parseTagResult({ tags: ["bad<tag>"], description: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(normalizeTags(r.value.tags)).toEqual(["badtag"]);
  });
});

describe("normalizeTags", () => {
  it("移除 # 前缀与首尾空白", () => {
    expect(normalizeTags(["#ai", " 读书 "])).toEqual(["ai", "读书"]);
  });

  it("仅允许文字/数字/空格/-/_，非法字符剔除", () => {
    expect(normalizeTags(["a!b", "c@d"])).toEqual(["ab", "cd"]);
  });

  it("小写去空格/-/_ 后去重（保留首个原样）", () => {
    expect(normalizeTags(["AI", "ai", "a-i", "a i", "a_i"])).toEqual(["AI"]);
  });

  it("空结果失败", () => {
    expect(normalizeTags(["###", "!!!"])).toEqual([]);
  });
});

describe("runLockedTextModel", () => {
  it("模型锁定：非锁定模型抛错", async () => {
    await expect(runLockedTextModel(env.AI, "not-the-locked-model", { messages: [] })).rejects.toThrow(
      "Unexpected AI model",
    );
  });

  it("返回 unknown 双重转换结果", async () => {
    // 原实现依赖远程 AI binding（remoteBindings）才能跑；这里用 stub 直接
    // 验证 double-cast 解析路径：binding.run 返回 { response } 时应取出该字段。
    const stubAi = { run: async () => ({ response: '{"ok":true}' }) };
    const out = await runLockedTextModel(stubAi, LOCKED_MODEL, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toBe('{"ok":true}');
  });
});

describe("tagBookmark", () => {
  it("模型锁定：env.AI_MODEL 非锁定值抛错", async () => {
    const env2 = { ...env, AI_MODEL: "other/model" } as unknown as Env;
    await expect(tagBookmark(env2, "标题", "描述")).rejects.toThrow("Unexpected AI model");
  });
});

describe("POST /__phase0/ai-json 探针", () => {
  beforeEach(async () => {
    await seedAdmin();
  });

  it("无 Bearer 拒绝", async () => {
    const res = await SELF.fetch("https://example.com/__phase0/ai-json", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("错误 key 拒绝", async () => {
    const res = await SELF.fetch("https://example.com/__phase0/ai-json", {
      method: "POST",
      headers: { Authorization: "Bearer ak2_00000000000000000000_00000000000000000000000000000000" },
    });
    expect(res.status).toBe(401);
  });

  it("返回 model/validated/tags/errorType/passed 结构", async () => {
    const res = await SELF.fetch("https://example.com/__phase0/ai-json", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.model).toBe(LOCKED_MODEL);
    expect(typeof body.validated).toBe("boolean");
    expect(Array.isArray(body.tags)).toBe(true);
    expect("errorType" in body).toBe(true);
    expect(typeof body.passed).toBe("boolean");
  });

  it("GET 方法拒绝", async () => {
    const res = await SELF.fetch("https://example.com/__phase0/ai-json", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(405);
  });
});
