import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { encryptSecret, decryptSecret } from "../../auth/secret-box.js";
import { listProviderModels } from "../../ai/model-list.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const zProviderSchema = z.enum(["workers-ai", "openrouter", "ollama-cloud"]);

const zSetConfigSchema = z.object({
  provider: zProviderSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  embeddingModel: z.string().min(1).optional(),
});

export const llmRouter = router({
  getConfig: protectedProcedure
    .output(
      z.object({
        provider: zProviderSchema,
        baseUrl: z.string().nullable(),
        model: z.string(),
        embeddingModel: z.string().nullable(),
        apiKeyConfigured: z.boolean(),
      }),
    )
    .query(async ({ ctx }) => {
      const row = await ctx.env.DB.prepare("SELECT provider, base_url, api_key_enc, model, embedding_model FROM user_llm_config WHERE user_id = ?")
        .bind(ctx.user.id)
        .first<{ provider: string; base_url: string | null; api_key_enc: string | null; model: string | null; embedding_model: string | null }>();
      if (!row) {
        return { provider: "workers-ai" as const, baseUrl: null, model: DEFAULT_MODEL, embeddingModel: null, apiKeyConfigured: false };
      }
      return {
        provider: row.provider as "workers-ai" | "openrouter" | "ollama-cloud",
        baseUrl: row.base_url,
        model: row.model ?? DEFAULT_MODEL,
        embeddingModel: row.embedding_model,
        apiKeyConfigured: !!row.api_key_enc,
      };
    }),
  listModels: protectedProcedure
    .input(z.object({ provider: zProviderSchema }))
    .output(
      z.object({
        models: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(["chat", "embedding"]),
            contextLength: z.number().nullable(),
            pricing: z.object({ prompt: z.string().nullable(), completion: z.string().nullable() }).nullable(),
          }),
        ),
      }),
    )
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
  setConfig: protectedProcedure
    .input(zSetConfigSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const secret = ctx.env.LLM_CONFIG_KEY;
      if (!secret) throw new Error("LLM_CONFIG_KEY not configured");
      const apiKeyEnc = input.apiKey ? await encryptSecret(input.apiKey, secret) : null;
      const now = Date.now();
      await ctx.env.DB.prepare(
        `INSERT INTO user_llm_config (user_id, provider, base_url, api_key_enc, model, embedding_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           api_key_enc = COALESCE(excluded.api_key_enc, user_llm_config.api_key_enc),
           model = excluded.model,
           embedding_model = excluded.embedding_model,
           updated_at = excluded.updated_at`,
      )
        .bind(ctx.user.id, input.provider, input.baseUrl ?? null, apiKeyEnc, input.model ?? null, input.embeddingModel ?? null, now)
        .run();
      return { success: true };
    }),
});
