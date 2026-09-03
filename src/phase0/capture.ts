// Phase 0 wire shape 捕获核心：值脱敏为类型名，绝不保存敏感值。

export type Shape =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "null"
  | "url"
  | { type: "array"; item: Shape }
  | { [key: string]: Shape };

const URL_RE = /^https?:\/\//i;

export function shapeOf(value: unknown): Shape {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return "date";
  if (typeof value === "string") {
    if (URL_RE.test(value)) return "url";
    return "string";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    const items = value.map(shapeOf);
    const item: Shape = items.length > 0 ? items[0]! : "null";
    return { type: "array", item };
  }
  if (typeof value === "object") {
    const out: { [key: string]: Shape } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return "string";
}

export function shapeJson(value: unknown): string {
  return JSON.stringify(shapeOf(value));
}

// 固定测试头常量：只允许这一个头作为布尔证据，绝不枚举/保存任意 header。
// 注意：X-KaraClone-Phase0 小写规范化后为 x-karaclone-phase0（无连字符）。
export const FIXED_TEST_HEADER = "x-karaclone-phase0";

export function hasFixedTestHeader(headers: Headers): boolean {
  return headers.get(FIXED_TEST_HEADER) !== null;
}

export const CAPTURE_CLIENTS = ["extension", "mobile", "contract"] as const;
export type CaptureClient = (typeof CAPTURE_CLIENTS)[number];

export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

export function isCaptureClient(client: string): client is CaptureClient {
  return (CAPTURE_CLIENTS as readonly string[]).includes(client);
}
