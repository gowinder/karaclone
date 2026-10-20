// LLM provider 的统一默认地址与 chat 端点。
//
// 教训：此前 baseUrl 用 `provider === "openrouter" ? A : "https://ollama.com"` 的二元表达式，
// 新增 provider 时会静默落到 Ollama 的默认地址（请求打到错误主机，报错信息还指向另一个服务）。
// 所有调用路径（queue consumer / import-fix / tRPC）必须只从这张表取默认值。

export type LlmProvider = "workers-ai" | "openrouter" | "ollama-cloud" | "opencode-go";

export const LLM_PROVIDERS = ["workers-ai", "openrouter", "ollama-cloud", "opencode-go"] as const;

export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

// chatEndpoint 是相对 baseUrl 的路径。
// - OpenRouter: https://openrouter.ai/api/v1 + chat/completions
// - Ollama Cloud: https://ollama.com + v1/chat/completions（裸 /chat/completions 404）
// - OpenCode Go: https://opencode.ai/inference/go/openai/v1 + chat/completions
//   注意模型列表不在这个 base 下，是 https://opencode.ai/inference/go/v1/models（见 model-list.ts）
export const PROVIDER_ENDPOINTS: Record<LlmProvider, { baseUrl: string; chatEndpoint: string }> = {
  "workers-ai": { baseUrl: "", chatEndpoint: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", chatEndpoint: "chat/completions" },
  "ollama-cloud": { baseUrl: "https://ollama.com", chatEndpoint: "v1/chat/completions" },
  "opencode-go": { baseUrl: "https://opencode.ai/inference/go/openai/v1", chatEndpoint: "chat/completions" },
};

// OpenCode Go 强制要求 x-opencode-session（缺失返回 400 MissingSessionID：
// "Request is missing x-opencode-session and cannot be routed efficiently"），
// 官方要求该值在一次会话内稳定，这里用用户维度的稳定值。
export function providerExtraHeaders(provider: LlmProvider, sessionKey: string): Record<string, string> {
  if (provider === "opencode-go") return { "x-opencode-session": `karaclone-${sessionKey}` };
  return {};
}

export function resolveProviderRequest(
  provider: LlmProvider,
  configuredBaseUrl: string | null | undefined,
  sessionKey: string,
): { baseUrl: string; endpoint: string; headers: Record<string, string> } {
  const def = PROVIDER_ENDPOINTS[provider];
  return {
    baseUrl: configuredBaseUrl ?? def.baseUrl,
    endpoint: def.chatEndpoint,
    headers: providerExtraHeaders(provider, sessionKey),
  };
}
