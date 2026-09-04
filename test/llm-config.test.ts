import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

describe("llm.getConfig / llm.setConfig", () => {
  it("默认返回 workers-ai", async () => {
    const key = await signupAndKey("llm-default@test.com");
    const c = await caller(key);
    const cfg = await c.llm.getConfig();
    expect(cfg).toMatchObject({ provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct-fast" });
    expect(cfg.apiKeyConfigured).toBe(false);
  });

  it("设置 openrouter 后读取回显（key 不泄露）", async () => {
    const key = await signupAndKey("llm-openrouter@test.com");
    const c = await caller(key);
    await c.llm.setConfig({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-test-secret",
      model: "anthropic/claude-3.5-sonnet",
      embeddingModel: "text-embedding-3-small",
    });
    const cfg = await c.llm.getConfig();
    expect(cfg).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      embeddingModel: "text-embedding-3-small",
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(cfg)).not.toContain("sk-or-v1-test-secret");
  });

  it("设置 ollama-cloud", async () => {
    const key = await signupAndKey("llm-ollama@test.com");
    const c = await caller(key);
    await c.llm.setConfig({
      provider: "ollama-cloud",
      baseUrl: "https://ollama.com/v1",
      apiKey: "ollama-key-123",
      model: "gpt-oss:120b",
    });
    const cfg = await c.llm.getConfig();
    expect(cfg).toMatchObject({ provider: "ollama-cloud", model: "gpt-oss:120b" });
  });

  it("未认证 → UNAUTHORIZED", async () => {
    const c = await caller();
    await expect(c.llm.getConfig()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("api_key 落库为密文", async () => {
    const key = await signupAndKey("llm-enc@test.com");
    const c = await caller(key);
    await c.llm.setConfig({ provider: "ollama-cloud", baseUrl: "https://ollama.com/v1", apiKey: "plain-secret-xyz", model: "m" });
    const row = await env.DB.prepare("SELECT api_key_enc FROM user_llm_config WHERE user_id = (SELECT id FROM users WHERE email = 'llm-enc@test.com')")
      .first<{ api_key_enc: string }>();
    expect(row?.api_key_enc).toMatch(/^v1:/);
    expect(row?.api_key_enc).not.toContain("plain-secret-xyz");
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
