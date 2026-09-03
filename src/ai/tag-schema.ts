// T10：AI tag 结果 schema 与二次验证。
// 只接受 object 或纯 JSON string；markdown fence 必须失败，防止宽松解析掩盖 JSON Mode 失效。
import { z } from "zod";

export const tagResultSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  description: z.string().max(300).nullable(),
});

export type TagResult = z.infer<typeof tagResultSchema>;

export type ParseTagResult =
  | { ok: true; value: TagResult }
  | { ok: false; error: string };

// normalize：移除 # 前缀与首尾空白，仅允许文字/数字/空格/-/_，
// 按小写并移除空格/-/_ 后的名称去重。
const TAG_CHAR = /[^\p{L}\p{N} _-]/gu;

export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const cleaned = t
      .replace(/^#+/, "")
      .trim()
      .replace(TAG_CHAR, "");
    if (cleaned.length === 0) continue;
    const key = cleaned.toLowerCase().replace(/[\s_-]/g, "");
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function parseTagResult(input: unknown): ParseTagResult {
  let candidate: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    // 仅接受纯 JSON string：fence/前缀文本一律失败
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return { ok: false, error: "not_pure_json_string" };
    }
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: "invalid_json" };
    }
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: "not_object" };
  }
  const parsed = tagResultSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: "schema_violation" };
  return { ok: true, value: parsed.data };
}
