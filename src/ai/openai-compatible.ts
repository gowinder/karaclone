// OpenAI 兼容 chat completions 调用（OpenRouter / Ollama Cloud 统一抽象）。
// 两者都是 POST {baseUrl}/{endpoint} + Bearer key + {model, messages}。
// OpenRouter 端点是 /chat/completions；Ollama Cloud 是 /v1/chat/completions。

export type OpenAiCompatibleRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** 相对端点，默认 chat/completions；Ollama Cloud 传 v1/chat/completions */
  endpoint?: string;
  /** 额外请求头（如 OpenCode Go 强制要求的 x-opencode-session） */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** 请求超时毫秒，默认 60000 */
  timeoutMs?: number;
};

export async function runOpenAiCompatible(req: OpenAiCompatibleRequest): Promise<string> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const endpoint = req.endpoint ?? "chat/completions";
  const url = `${req.baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.apiKey}`,
      ...req.headers,
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(req.timeoutMs ?? 60000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    throw new Error("LLM response missing content");
  }
  return content;
}
