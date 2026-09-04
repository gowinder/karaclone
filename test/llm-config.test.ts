import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { encryptSecret, decryptSecret } from "../src/auth/secret-box";
import { runOpenAiCompatible } from "../src/ai/openai-compatible";

async function caller(bearer?: string) {
  const req = new Request("https://example.com/trpc/x", {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

async function signupAndKey(email: string) {
  const c = await caller();
  await c.users.create({ name: "LLM User", email, password: "password123", confirmPassword: "password123" });
  const { key } = await c.apiKeys.exchange({ keyName: "K", email, password: "password123" });
  return key;
}

describe("secret-box AES-GCM 加密", () => {
  it("加密解密往返", async () => {
    const enc = await encryptSecret("sk-ollama-secret-key", "test-key");
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain("sk-ollama-secret-key");
    expect(await decryptSecret(enc, "test-key")).toBe("sk-ollama-secret-key");
  });

  it("错误 key 解密失败", async () => {
    const enc = await encryptSecret("secret", "key-a");
    await expect(decryptSecret(enc, "key-b")).rejects.toThrow();
  });
});

describe("llm.getConfigs / setProviderConfig / setSelection", () => {
  it("默认无 provider 配置，selection 回退 workers-ai", async () => {
    const key = await signupAndKey("llm-default@test.com");
    const c = await caller(key);
    const cfg = await c.llm.getConfigs();
    expect(cfg.providers).toEqual([]);
    expect(cfg.selection).toMatchObject({
      chatProvider: "workers-ai",
      chatModel: "@cf/meta/llama-3.1-8b-instruct-fast",
      embeddingProvider: null,
      embeddingModel: null,
    });
  });

  it("配置两个 provider 各自独立（key 不泄露）", async () => {
    const key = await signupAndKey("llm-multi@test.com");
    const c = await caller(key);
    await c.llm.setProviderConfig({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-test-secret",
    });
    await c.llm.setProviderConfig({
      provider: "ollama-cloud",
      baseUrl: "https://ollama.com",
      apiKey: "ollama-key-123",
    });
    const cfg = await c.llm.getConfigs();
    expect(cfg.providers).toHaveLength(2);
    const or = cfg.providers.find((p) => p.provider === "openrouter");
    const oc = cfg.providers.find((p) => p.provider === "ollama-cloud");
    expect(or).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", apiKeyConfigured: true });
    expect(oc).toMatchObject({ baseUrl: "https://ollama.com", apiKeyConfigured: true });
    expect(JSON.stringify(cfg)).not.toContain("sk-or-v1-test-secret");
    expect(JSON.stringify(cfg)).not.toContain("ollama-key-123");
  });

  it("setSelection 保存 chat + embedding 双模型", async () => {
    const key = await signupAndKey("llm-sel@test.com");
    const c = await caller(key);
    await c.llm.setSelection({
      chatProvider: "openrouter",
      chatModel: "anthropic/claude-3.5-sonnet",
      embeddingProvider: "openrouter",
      embeddingModel: "text-embedding-3-small",
    });
    const cfg = await c.llm.getConfigs();
    expect(cfg.selection).toMatchObject({
      chatProvider: "openrouter",
      chatModel: "anthropic/claude-3.5-sonnet",
      embeddingProvider: "openrouter",
      embeddingModel: "text-embedding-3-small",
    });
  });

  it("setSelection 可只配 chat 不配 embedding", async () => {
    const key = await signupAndKey("llm-sel2@test.com");
    const c = await caller(key);
    await c.llm.setSelection({ chatProvider: "ollama-cloud", chatModel: "gpt-oss:120b" });
    const cfg = await c.llm.getConfigs();
    expect(cfg.selection).toMatchObject({
      chatProvider: "ollama-cloud",
      chatModel: "gpt-oss:120b",
      embeddingProvider: null,
      embeddingModel: null,
    });
  });

  it("未认证 → UNAUTHORIZED", async () => {
    const c = await caller();
    await expect(c.llm.getConfigs()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("api_key 落库为密文", async () => {
    const key = await signupAndKey("llm-enc@test.com");
    const c = await caller(key);
    await c.llm.setProviderConfig({ provider: "ollama-cloud", baseUrl: "https://ollama.com/v1", apiKey: "plain-secret-xyz" });
    const row = await env.DB.prepare("SELECT api_key_enc FROM user_llm_config WHERE user_id = (SELECT id FROM users WHERE email = 'llm-enc@test.com') AND provider = 'ollama-cloud'")
      .first<{ api_key_enc: string }>();
    expect(row?.api_key_enc).toMatch(/^v1:/);
    expect(row?.api_key_enc).not.toContain("plain-secret-xyz");
  });

  it("listModels workers-ai 硬编码单模型", async () => {
    const key = await signupAndKey("llm-list@test.com");
    const c = await caller(key);
    const { models } = await c.llm.listModels({ provider: "workers-ai" });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "@cf/meta/llama-3.1-8b-instruct-fast", kind: "chat" });
  });

  it("listModels 未配置 key → 抛错", async () => {
    const key = await signupAndKey("llm-list2@test.com");
    const c = await caller(key);
    await expect(c.llm.listModels({ provider: "openrouter" })).rejects.toThrow("API key not configured");
  });

  it("testProvider 未配置 key → ok:false", async () => {
    const key = await signupAndKey("llm-test1@test.com");
    const c = await caller(key);
    const r = await c.llm.testProvider({ provider: "openrouter" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("尚未配置");
  });

  it("testProvider openrouter 成功 → ok:true", async () => {
    const key = await signupAndKey("llm-test2@test.com");
    const c = await caller(key);
    await c.llm.setProviderConfig({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-real" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-or-v1-real");
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      const r = await c.llm.testProvider({ provider: "openrouter" });
      expect(r.ok).toBe(true);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("testProvider ollama-cloud 走 /v1/chat/completions", async () => {
    const key = await signupAndKey("llm-test3@test.com");
    const c = await caller(key);
    await c.llm.setProviderConfig({ provider: "ollama-cloud", baseUrl: "https://ollama.com", apiKey: "ollama-key" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://ollama.com/v1/chat/completions");
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      const r = await c.llm.testProvider({ provider: "ollama-cloud" });
      expect(r.ok).toBe(true);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("testProvider 401 → ok:false + 错误信息", async () => {
    const key = await signupAndKey("llm-test4@test.com");
    const c = await caller(key);
    await c.llm.setProviderConfig({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-bad" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async () => new Response("Unauthorized", { status: 401 }));
    try {
      const r = await c.llm.testProvider({ provider: "openrouter" });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("401");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});

describe("openai-compatible 调用", () => {
  it("OpenAI 格式响应解析", async () => {
    const result = await runOpenAiCompatible({
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hello from openai" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(result).toBe("hello from openai");
  });

  it("Ollama 兼容响应解析（choices 数组）", async () => {
    const result = await runOpenAiCompatible({
      baseUrl: "https://ollama.com/v1",
      apiKey: "k",
      model: "gpt-oss:120b",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hi from ollama" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(result).toBe("hi from ollama");
  });

  it("非 2xx → 抛错", async () => {
    await expect(
      runOpenAiCompatible({
        baseUrl: "https://example.com/v1",
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
      }),
    ).rejects.toThrow();
  });

  it("请求体含 Authorization Bearer 与 model", async () => {
    let captured: { url: string; headers: Headers; body: unknown } | null = null;
    await runOpenAiCompatible({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test-123",
      model: "model-x",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async (url, init) => {
        captured = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
    });
    expect(captured?.url).toBe("https://example.com/v1/chat/completions");
    expect(captured?.headers.get("Authorization")).toBe("Bearer sk-test-123");
    expect(captured?.body).toMatchObject({ model: "model-x", messages: [{ role: "user", content: "hi" }] });
  });
});
