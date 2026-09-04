// OpenAI 兼容 chat completions 调用（OpenRouter / Ollama Cloud 统一抽象）。
// 两者都是 POST {baseUrl}/chat/completions + Bearer key + {model, messages}。

export type OpenAiCompatibleRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  fetchImpl?: typeof fetch;
};

export async function runOpenAiCompatible(req: OpenAiCompatibleRequest): Promise<string> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const url = `${req.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: false,
    }),
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
