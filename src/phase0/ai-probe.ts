// T10：一次性 AI 探针。POST /__phase0/ai-json 使用固定公开文本，不发送用户数据；
// 返回 model、validated、tags、错误类型和 passed。要求 API Key 且 PHASE0_CAPTURE=true。
import { authenticateApiKey } from "../auth/api-key.js";
import { LOCKED_MODEL } from "../ai/cloudflare-ai.js";
import { tagBookmark } from "../ai/tagger.js";

const PROBE_TITLE = "Phase 0 AI JSON Mode Probe";
const PROBE_DESCRIPTION = "Fixed public text used to verify Workers AI JSON mode on the free plan.";

export async function handleAiProbe(req: Request, env: Env): Promise<Response | null> {
  if (env.PHASE0_CAPTURE !== "true") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/__phase0/ai-json") return null;

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
  const user = await authenticateApiKey(env.DB, auth.slice("Bearer ".length).trim());
  if (!user) return new Response("Unauthorized", { status: 401 });

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const result = await tagBookmark(env, PROBE_TITLE, PROBE_DESCRIPTION);
    if (!result.ok) {
      return Response.json({
        model: env.AI_MODEL,
        validated: false,
        tags: [],
        errorType: result.error,
        passed: false,
      });
    }
    return Response.json({
      model: env.AI_MODEL,
      validated: true,
      tags: result.value.tags,
      description: result.value.description,
      errorType: null,
      passed: true,
    });
  } catch (err) {
    const errorType = err instanceof Error ? err.message : "UNKNOWN";
    return Response.json({
      model: env.AI_MODEL,
      validated: false,
      tags: [],
      errorType,
      passed: false,
    });
  }
}

export { LOCKED_MODEL };
