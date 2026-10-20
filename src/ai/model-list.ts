// Provider 模型列表拉取：OpenRouter / Ollama Cloud / OpenCode Go 统一为
// {id, name, kind, contextLength, pricing, free, recommended}。
// kind: "chat" | "embedding"（karakeep 需要 LLM + Embedding 两个模型）。
// free 只能由「明确的零价字段」得出，禁止用模型名含 "free" 之类的字符串推断。

import type { LlmProvider } from "./providers.js";

export type ProviderModel = {
  id: string;
  name: string;
  kind: "chat" | "embedding";
  contextLength: number | null;
  pricing: { prompt: string | null; completion: string | null } | null;
  /** 官方明确零价（显式价格字段全为 0）；未知价格一律 false，不得误标「免费」 */
  free: boolean;
  /** 本项目推荐（当前仅 Workers AI 白名单，入选前提：在官方 JSON Mode 支持列表内） */
  recommended: boolean;
};

// models.dev 是 OpenCode 官方使用的模型注册表（opencode 自身从这里取模型元数据）。
// 每个模型带 provider.api / provider.npm，用于区分路由：
//   - provider 默认 npm = @ai-sdk/openai-compatible → POST /openai/v1/chat/completions（我们能调）
//   - 模型级 npm = @ai-sdk/openai → /responses 路由（我们的通用客户端调不通）
//   - 模型级 npm = @ai-sdk/anthropic / @ai-sdk/google → /anthropic、/google 路由（同样调不通）
// 同时 cost.input/output 是显式价格字段，用它判定免费（0 元即官方明确免费）。
const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const MODEL_LIST_TIMEOUT_MS = 15000;

type ModelsDevModel = {
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  provider?: { api?: string; npm?: string };
};

type ModelsDevProvider = {
  api?: string;
  npm?: string;
  models?: Record<string, ModelsDevModel>;
};

// 显式零价：接受 "0" / 0 / "0.0"；null/undefined/空串/空白/非数字一律不算免费。
// 注意 Number("") === 0，必须先去空，否则空价格会被误标「免费」。
function isExplicitZero(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    const n = Number(trimmed);
    return Number.isFinite(n) && n === 0;
  }
  return Number.isFinite(value) && value === 0;
}

export async function listProviderModels(
  provider: Exclude<LlmProvider, "workers-ai">,
  baseUrl: string,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ProviderModel[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, "");

  if (provider === "openrouter") {
    const res = await fetchImpl(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
    const data = (await res.json()) as {
      data?: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[];
    };
    return (data.data ?? []).map((m) => {
      const pricing = m.pricing
        ? { prompt: m.pricing.prompt ?? null, completion: m.pricing.completion ?? null }
        : null;
      return {
        id: m.id,
        name: m.name ?? m.id,
        kind: /embed/i.test(m.id) ? ("embedding" as const) : ("chat" as const),
        contextLength: m.context_length ?? null,
        pricing,
        // OpenRouter 的零价模型两个方向的价格字段都是 "0"（例如 ":free" 变体）
        free: !!pricing && isExplicitZero(pricing.prompt) && isExplicitZero(pricing.completion),
        recommended: false,
      };
    });
  }

  if (provider === "opencode-go") return listOpenCodeGoModels(base, apiKey, fetchImpl);

  // ollama-cloud：/api/tags，capabilities 含 "embedding" 判定
  const res = await fetchImpl(`${base}/api/tags`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
  const data = (await res.json()) as {
    models?: { name?: string; model?: string; capabilities?: string[] }[];
  };
  return (data.models ?? []).map((m) => {
    const id = m.name ?? m.model ?? "";
    const caps = m.capabilities ?? [];
    const kind = caps.includes("embedding") || /embed/i.test(id) ? ("embedding" as const) : ("chat" as const);
    return { id, name: id, kind, contextLength: null, pricing: null, free: false, recommended: false };
  });
}

// OpenCode Go：模型列表在 /inference/go/v1/models，与 chat base（/inference/go/openai/v1）不同路径。
// 该列表只有 id（无价格、无路由信息），因此路由与价格一律以 models.dev 注册表为准：
//   - 只保留 chat completions 路由的模型（否则用户选了必然失败）
//   - free 由 cost.input === 0 && cost.output === 0 判定
// 元数据不可用时直接报错，而不是把无法确认兼容性的模型列出来让用户踩坑。
async function listOpenCodeGoModels(
  base: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ProviderModel[]> {
  const root = base.replace(/\/openai\/v1$/, "").replace(/\/$/, "");
  const res = await fetchImpl(`${root}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
  const list = (await res.json()) as { data?: { id?: string }[] };
  const ids = (list.data ?? []).map((m) => m.id).filter((id): id is string => !!id);

  const metaRes = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  if (!metaRes.ok) throw new Error(`Model metadata failed: ${metaRes.status}`);
  const registry = (await metaRes.json()) as Record<string, ModelsDevProvider>;
  const meta = registry[OPENCODE_GO_PROVIDER_ID];
  if (!meta?.models) throw new Error("Model metadata missing: opencode-go");

  // fail closed：provider 级 npm 缺失时不做「默认兼容」假设，一律视为不可用。
  const providerNpm = meta.npm;
  const out: ProviderModel[] = [];
  for (const id of ids) {
    const m = meta.models[id];
    if (!m) continue; // 注册表里没有 → 路由与价格都无法确认，不展示
    const npm = m.provider?.npm ?? providerNpm;
    if (npm !== "@ai-sdk/openai-compatible") continue; // responses / anthropic / google 路由，通用客户端调不通
    if (m.provider?.api && meta.api && m.provider.api !== meta.api) continue;
    out.push({
      id,
      name: m.name ?? id,
      kind: "chat",
      contextLength: m.limit?.context ?? null,
      // models.dev 的 cost 是「每百万 token 美元」，与 OpenRouter 的「每 token」单位不同，
      // 混在同一个字段里会误导，因此这里不下发价格，只用它判定免费。
      pricing: null,
      free: isExplicitZero(m.cost?.input) && isExplicitZero(m.cost?.output),
      recommended: false,
    });
  }
  return out;
}
