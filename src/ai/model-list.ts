// Provider 模型列表拉取：OpenRouter / Ollama Cloud 统一为 {id, name, kind, pricing}。
// kind: "chat" | "embedding"（karakeep 需要 LLM + Embedding 两个模型）。

export type ProviderModel = {
  id: string;
  name: string;
  kind: "chat" | "embedding";
  contextLength: number | null;
  pricing: { prompt: string | null; completion: string | null } | null;
};

export async function listProviderModels(
  provider: "openrouter" | "ollama-cloud",
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
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      kind: /embed/i.test(m.id) ? ("embedding" as const) : ("chat" as const),
      contextLength: m.context_length ?? null,
      pricing: m.pricing
        ? { prompt: m.pricing.prompt ?? null, completion: m.pricing.completion ?? null }
        : null,
    }));
  }

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
    return { id, name: id, kind, contextLength: null, pricing: null };
  });
}
