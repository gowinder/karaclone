// T10：书签 tagger——模型锁定 + JSON schema + Zod 二次验证 + normalize 去重。
import { LOCKED_MODEL, runLockedTextModel, type TagModelInput } from "./cloudflare-ai.js";
import { normalizeTags, parseTagResult, type TagResult } from "./tag-schema.js";

export type TagBookmarkResult =
  | { ok: true; value: TagResult }
  | { ok: false; error: string };

export async function tagBookmark(env: Env, title: string, description: string): Promise<TagBookmarkResult> {
  if (env.AI_MODEL !== LOCKED_MODEL) {
    throw new Error(`Unexpected AI model: ${env.AI_MODEL}`);
  }

  const input: TagModelInput = {
    messages: [
      {
        role: "system",
        content: "Return 1-8 concise Chinese bookmark tags and a description or null.",
      },
      { role: "user", content: `${title}\n${description}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          tags: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          description: { type: ["string", "null"], maxLength: 300 },
        },
        required: ["tags", "description"],
        additionalProperties: false,
      },
    },
  };

  const raw = await runLockedTextModel(env.AI, LOCKED_MODEL, input);
  const parsed = parseTagResult(raw);
  if (!parsed.ok) return parsed;

  // 二次验证：normalize 后再次过 schema
  const normalized = normalizeTags(parsed.value.tags);
  const recheck = parseTagResult({ tags: normalized, description: parsed.value.description });
  if (!recheck.ok) return recheck;
  return { ok: true, value: recheck.value };
}
