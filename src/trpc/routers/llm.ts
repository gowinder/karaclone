import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { encryptSecret, decryptSecret } from "../../auth/secret-box.js";
import { listProviderModels, type ProviderModel } from "../../ai/model-list.js";
import { runOpenAiCompatible } from "../../ai/openai-compatible.js";
import { LLM_PROVIDERS, resolveProviderRequest, type LlmProvider } from "../../ai/providers.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
// 未选择对话模型时测试连接用的兜底探针模型（Ollama Cloud 仍在线的通用模型）
const FALLBACK_TEST_MODEL = "gpt-oss:120b";

// Workers AI 可选模型（recommended 是「本项目推荐」，非 Cloudflare 官方推荐）。
// 默认仍是现有 8B fast；新增 70B fast 标为推荐备选，它在官方 JSON Mode 支持列表内
// https://developers.cloudflare.com/workers-ai/features/json-mode/ ，质量优先但更耗每日额度。
// 未加入非 fast 的 @cf/meta/llama-3.1-8b-instruct（Cloudflare 2026-05-08 有模型弃用公告）。
const WORKERS_AI_MODELS: ProviderModel[] = [
  {
    id: DEFAULT_MODEL,
    name: "Llama 3.1 8B Instruct (Fast) · 默认",
    kind: "chat",
    contextLength: null,
    pricing: null,
    // Workers AI 是「每日免费额度」而不是「免费」，不用免费标记（额度说明在 provider 描述里）
    free: false,
    recommended: false,
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B Instruct FP8 (Fast) · 质量优先，更耗每日额度",
    kind: "chat",
    contextLength: null,
    pricing: null,
    free: false,
    recommended: true,
  },
];

const zProviderSchema = z.enum(LLM_PROVIDERS);

// 兜底探针模型：用户还没在「模型选择」里选过该 provider 的模型时使用。
// 不能所有 provider 共用一个写死的模型（gpt-oss:120b 只存在于 Ollama Cloud），
// 否则别的 provider 的「测试连接」会拿一个不存在的模型去调 → 永远失败。
// 除 ollama-cloud 外，一律从该 provider 的真实模型列表里取 chat 模型（优先免费，省测试费用）。
async function fallbackProbeModel(
  provider: Exclude<LlmProvider, "workers-ai">,
  baseUrl: string,
  apiKey: string,
): Promise<string> {
  if (provider === "ollama-cloud") return FALLBACK_TEST_MODEL;
  const models = await listProviderModels(provider, baseUrl, apiKey);
  const chat = models.filter((m) => m.kind === "chat");
  if (chat.length === 0) throw new Error("该 provider 未返回可用的对话模型");
  return (chat.find((m) => m.free) ?? chat[0]!).id;
}

const zProviderConfigSchema = z.object({
  provider: zProviderSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
});

const zSetSelectionSchema = z.object({
  chatProvider: zProviderSchema,
  chatModel: z.string().min(1),
  embeddingProvider: zProviderSchema.optional(),
  embeddingModel: z.string().min(1).optional(),
});

const zModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["chat", "embedding"]),
  contextLength: z.number().nullable(),
  pricing: z.object({ prompt: z.string().nullable(), completion: z.string().nullable() }).nullable(),
  free: z.boolean(),
  recommended: z.boolean(),
});

export const llmRouter = router({
  getConfigs: protectedProcedure
    .output(
      z.object({
        providers: z.array(
          z.object({
            provider: zProviderSchema,
            baseUrl: z.string().nullable(),
            apiKeyConfigured: z.boolean(),
          }),
        ),
        selection: z.object({
          chatProvider: zProviderSchema,
          chatModel: z.string(),
          embeddingProvider: zProviderSchema.nullable(),
          embeddingModel: z.string().nullable(),
        }),
      }),
    )
    .query(async ({ ctx }) => {
      const rows = await ctx.env.DB.prepare("SELECT provider, base_url, api_key_enc FROM user_llm_config WHERE user_id = ?")
        .bind(ctx.user.id)
        .all<{ provider: string; base_url: string | null; api_key_enc: string | null }>();
      const providers = (rows.results ?? []).map((r) => ({
        provider: r.provider as "workers-ai" | "openrouter" | "ollama-cloud",
        baseUrl: r.base_url,
        apiKeyConfigured: !!r.api_key_enc,
      }));
      const sel = await ctx.env.DB.prepare("SELECT chat_provider, chat_model, embedding_provider, embedding_model FROM user_llm_selection WHERE user_id = ?")
        .bind(ctx.user.id)
        .first<{ chat_provider: string; chat_model: string; embedding_provider: string | null; embedding_model: string | null }>();
      return {
        providers,
        selection: {
          chatProvider: (sel?.chat_provider ?? "workers-ai") as "workers-ai" | "openrouter" | "ollama-cloud",
          chatModel: sel?.chat_model ?? DEFAULT_MODEL,
          embeddingProvider: (sel?.embedding_provider ?? null) as "workers-ai" | "openrouter" | "ollama-cloud" | null,
          embeddingModel: sel?.embedding_model ?? null,
        },
      };
    }),
  setProviderConfig: protectedProcedure
    .input(zProviderConfigSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const secret = ctx.env.LLM_CONFIG_KEY;
      if (!secret) throw new Error("LLM_CONFIG_KEY not configured");
      const apiKeyEnc = input.apiKey ? await encryptSecret(input.apiKey, secret) : null;
      const now = Date.now();
      await ctx.env.DB.prepare(
        `INSERT INTO user_llm_config (user_id, provider, base_url, api_key_enc, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           base_url = excluded.base_url,
           api_key_enc = COALESCE(excluded.api_key_enc, user_llm_config.api_key_enc),
           updated_at = excluded.updated_at`,
      )
        .bind(ctx.user.id, input.provider, input.baseUrl ?? null, apiKeyEnc, now)
        .run();
      return { success: true };
    }),
  setSelection: protectedProcedure
    .input(zSetSelectionSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const now = Date.now();
      await ctx.env.DB.prepare(
        `INSERT INTO user_llm_selection (user_id, chat_provider, chat_model, embedding_provider, embedding_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           chat_provider = excluded.chat_provider,
           chat_model = excluded.chat_model,
           embedding_provider = excluded.embedding_provider,
           embedding_model = excluded.embedding_model,
           updated_at = excluded.updated_at`,
      )
        .bind(
          ctx.user.id,
          input.chatProvider,
          input.chatModel,
          input.embeddingProvider ?? null,
          input.embeddingModel ?? null,
          now,
        )
        .run();
      return { success: true };
    }),
  listModels: protectedProcedure
    .input(z.object({ provider: zProviderSchema }))
    .output(z.object({ models: z.array(zModelSchema) }))
    .query(async ({ input, ctx }) => {
      if (input.provider === "workers-ai") {
        return { models: WORKERS_AI_MODELS };
      }
      const row = await ctx.env.DB.prepare("SELECT base_url, api_key_enc FROM user_llm_config WHERE user_id = ? AND provider = ?")
        .bind(ctx.user.id, input.provider)
        .first<{ base_url: string | null; api_key_enc: string | null }>();
      if (!row?.api_key_enc) {
        throw new Error("API key not configured for this provider");
      }
      const secret = ctx.env.LLM_CONFIG_KEY;
      if (!secret) throw new Error("LLM_CONFIG_KEY not configured");
      const apiKey = await decryptSecret(row.api_key_enc, secret);
      const { baseUrl } = resolveProviderRequest(input.provider, row.base_url, ctx.user.id);
      const models = await listProviderModels(input.provider, baseUrl, apiKey);
      return { models };
    }),

  testProvider: protectedProcedure
    .input(z.object({ provider: zProviderSchema }))
    .output(
      z.object({
        ok: z.boolean(),
        message: z.string(),
        latencyMs: z.number().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.provider === "workers-ai") {
        return { ok: true, message: "Workers AI 为 Cloudflare 内置绑定，无需测试", latencyMs: null };
      }
      const row = await ctx.env.DB.prepare("SELECT base_url, api_key_enc FROM user_llm_config WHERE user_id = ? AND provider = ?")
        .bind(ctx.user.id, input.provider)
        .first<{ base_url: string | null; api_key_enc: string | null }>();
      if (!row?.api_key_enc) {
        return { ok: false, message: "尚未配置 API Key", latencyMs: null };
      }
      const secret = ctx.env.LLM_CONFIG_KEY;
      if (!secret) {
        return { ok: false, message: "服务端 LLM_CONFIG_KEY 未配置", latencyMs: null };
      }
      const apiKey = await decryptSecret(row.api_key_enc, secret);
      const req = resolveProviderRequest(input.provider, row.base_url, ctx.user.id);
      // 测试必须打「模型选择」里当前保存的模型，否则会出现「连接成功但打标签全挂」
      // 的假绿：模型被下线（如 ollama-cloud 返回 410 retired）时，写死的探针模型照样通。
      const sel = await ctx.env.DB.prepare(
        "SELECT chat_provider, chat_model FROM user_llm_selection WHERE user_id = ?",
      )
        .bind(ctx.user.id)
        .first<{ chat_provider: string; chat_model: string }>();
      const started = Date.now();
      let model = sel?.chat_provider === input.provider && sel.chat_model ? sel.chat_model : "";
      try {
        if (!model) model = await fallbackProbeModel(input.provider, req.baseUrl, apiKey);
        // 最小调用：发一条 ping 消息，验证 URL 可达 + key 有效 + 该模型仍在线
        await runOpenAiCompatible({
          baseUrl: req.baseUrl,
          apiKey,
          model,
          messages: [{ role: "user", content: "ping" }],
          endpoint: req.endpoint,
          headers: req.headers,
        });
        return {
          ok: true,
          message: `连接成功，API Key 有效（测试模型：${model}）`,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          message: `模型 ${model || "（未确定）"} 调用失败：${msg.slice(0, 260)}`,
          latencyMs: Date.now() - started,
        };
      }
    }),
});
