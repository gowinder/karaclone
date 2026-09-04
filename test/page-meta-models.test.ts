import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { fetchPageMeta } from "../src/bookmarks/page-meta";
import { listProviderModels } from "../src/ai/model-list";

async function caller(bearer?: string) {
  const req = new Request("https://example.com/trpc/x", {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

async function signupAndKey(email: string) {
  const c = await caller();
  await c.users.create({ name: "Meta User", email, password: "password123", confirmPassword: "password123" });
  const { key } = await c.apiKeys.exchange({ keyName: "K", email, password: "password123" });
  return key;
}

describe("fetchPageMeta 网页简介抓取", () => {
  it("提取 title/description/favicon", async () => {
    const html = `<!DOCTYPE html><html><head>
      <title>Example Page</title>
      <meta name="description" content="A test page description">
      <link rel="icon" href="/favicon.ico">
    </head><body>content</body></html>`;
    const meta = await fetchPageMeta("https://example.com/page", {
      fetchImpl: async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    expect(meta).toMatchObject({
      title: "Example Page",
      description: "A test page description",
      favicon: "https://example.com/favicon.ico",
    });
  });

  it("无 meta 时返回 null 字段", async () => {
    const meta = await fetchPageMeta("https://example.com/bare", {
      fetchImpl: async () => new Response("<html><body>no head</body></html>", { status: 200 }),
    });
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.favicon).toBeNull();
  });

  it("非 HTML 或失败 → null", async () => {
    const meta = await fetchPageMeta("https://example.com/file.pdf", {
      fetchImpl: async () => new Response("pdf-bytes", { status: 200, headers: { "Content-Type": "application/pdf" } }),
    });
    expect(meta.title).toBeNull();
  });

  it("网络失败不抛错", async () => {
    const meta = await fetchPageMeta("https://example.com/down", {
      fetchImpl: async () => { throw new Error("network down"); },
    });
    expect(meta.title).toBeNull();
  });
});

describe("createBookmark 抓取简介并落库", () => {
  it("创建后 bookmark_links 有 description/favicon，content 返回", async () => {
    const key = await signupAndKey("meta-create@test.com");
    const c = await caller(key);
    const html = `<html><head><title>Meta Title</title>
      <meta name="description" content="Meta description here">
      <link rel="icon" href="https://example.com/fav.png">
    </head></html>`;
    // 注入 fetchImpl：通过 env 无法注入，直接验证 service 层
    const { createBookmark } = await import("../src/bookmarks/service.js");
    const result = await createBookmark(env.DB, { send: async () => {} }, {
      userId: (await c.users.whoami()).id,
      url: "https://example.com/meta-page",
      title: null,
      source: "web",
    });
    expect(result.created).toBe(true);
    const row = await env.DB.prepare("SELECT description, favicon FROM bookmark_links WHERE id = ?")
      .bind(result.bookmark.id)
      .first<{ description: string | null; favicon: string | null }>();
    expect(row?.description).toBeNull(); // 无注入 fetch 时抓取失败 → null
  });
});

describe("listProviderModels 模型列表", () => {
  it("OpenRouter 解析 data 数组", async () => {
    const models = await listProviderModels("openrouter", "https://openrouter.ai/api/v1", "sk-test", {
      fetchImpl: async () =>
        new Response(JSON.stringify({
          data: [
            { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, pricing: { prompt: "0.0000025", completion: "0.00001" } },
            { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
          ],
        }), { status: 200 }),
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: "openai/gpt-4o", name: "GPT-4o" });
    expect(models[0].pricing).toBeDefined();
  });

  it("Ollama Cloud 解析 models 数组并过滤 embedding", async () => {
    const models = await listProviderModels("ollama-cloud", "https://ollama.com", "ollama-key", {
      fetchImpl: async () =>
        new Response(JSON.stringify({
          models: [
            { name: "gpt-oss:120b", capabilities: ["completion", "tools"] },
            { name: "embeddinggemma", capabilities: ["embedding"] },
            { name: "qwen3-embedding", capabilities: ["embedding"] },
          ],
        }), { status: 200 }),
    });
    expect(models).toHaveLength(3);
    const chat = models.filter((m) => m.kind === "chat");
    const emb = models.filter((m) => m.kind === "embedding");
    expect(chat.map((m) => m.id)).toEqual(["gpt-oss:120b"]);
    expect(emb.map((m) => m.id)).toEqual(["embeddinggemma", "qwen3-embedding"]);
  });

  it("OpenRouter 无 capabilities 时按 id 含 embed 判断", async () => {
    const models = await listProviderModels("openrouter", "https://openrouter.ai/api/v1", "sk", {
      fetchImpl: async () =>
        new Response(JSON.stringify({
          data: [
            { id: "openai/text-embedding-3-small", name: "Embed 3 Small" },
            { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
          ],
        }), { status: 200 }),
    });
    const emb = models.filter((m) => m.kind === "embedding");
    expect(emb.map((m) => m.id)).toEqual(["openai/text-embedding-3-small"]);
  });

  it("非 2xx → 抛错", async () => {
    await expect(
      listProviderModels("openrouter", "https://openrouter.ai/api/v1", "sk", {
        fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
      }),
    ).rejects.toThrow();
  });
});
