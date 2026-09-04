import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { encryptSecret, decryptSecret } from "../../auth/secret-box.js";
import { listProviderModels } from "../../ai/model-list.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const zProviderSchema = z.enum(["workers-ai", "openrouter", "ollama-cloud"]);

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
        return {
          models: [
            { id: "@cf/meta/llama-3.1-8b-instruct-fast", name: "Llama 3.1 8B Instruct (Fast)", kind: "chat" as const, contextLength: null, pricing: null },
          ],
        };
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
      const baseUrl = row.base_url ?? (input.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ollama.com");
      const models = await listProviderModels(input.provider, baseUrl, apiKey);
      return { models };
    }),
});
