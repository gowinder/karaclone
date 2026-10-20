// T10：Workers AI 调用封装。模型锁定为固定字面量，显式 unknown 双重转换，
// 不得使用 any，不得放宽为任意模型字符串。
export const LOCKED_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as const;

export type TagModelInput = {
  messages: { role: "system" | "user"; content: string }[];
  response_format?: {
    type: "json_schema";
    json_schema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
  };
};

// 最小结构接口：当前 workers-types 的 AiModels 联合可能滞后于官方活跃模型目录，
// 因此只声明我们实际消费的字段。
type AiBinding = {
  run: (model: string, input: unknown) => Promise<unknown>;
};

// Workers AI 绑定输出解包：文本模型返回 { response }（JSON Mode 下 response 是已解析对象）
// 或 OpenAI 兼容 { choices: [{ message: { content } }] }；裸对象（测试 mock / 部分模型）原样返回。
// 必须显式 unknown 双重转换，不得用 any。
export function unwrapWorkersAiOutput(raw: unknown): unknown {
  const asUnknown: unknown = raw;
  if (asUnknown !== null && typeof asUnknown === "object") {
    const record = asUnknown as Record<string, unknown>;
    if (record.response !== undefined) return record.response;
    const choices = record.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const content = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
      if (content && typeof content.content === "string") return content.content;
    }
  }
  return asUnknown;
}

export async function runLockedTextModel(
  ai: unknown,
  model: string,
  input: TagModelInput,
): Promise<unknown> {
  if (model !== LOCKED_MODEL) {
    throw new Error(`Unexpected AI model: ${model}`);
  }
  const binding = ai as AiBinding;
  return unwrapWorkersAiOutput(await binding.run(LOCKED_MODEL, input));
}
