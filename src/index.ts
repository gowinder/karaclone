import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import {
  corsHeaders,
  corsPreflight,
  healthResponse,
  jsonNotFound,
  previewResponse,
  versionResponse,
} from "./http/routes.js";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(req.url);
    const allowedOrigin = env.ALLOWED_EXTENSION_ORIGIN;

    // 1. CORS preflight：仅扩展白名单 Origin + 合法 token 头才回显；
    //    非法 header name / 非白名单 Origin 的 OPTIONS 一律在此终结，不落 tRPC，
    //    且不返回任何 CORS allow header。
    if (req.method === "OPTIONS") {
      const preflight = corsPreflight(req, allowedOrigin);
      if (preflight) return preflight;
      return new Response(null, { status: 204 });
    }

    // 2. Phase 0 探针（T8 起启用）
    if (env.PHASE0_CAPTURE === "true" && url.pathname.startsWith("/__phase0/")) {
      return new Response("phase0 probe not implemented", { status: 404 });
    }

    // 3. tRPC
    if (url.pathname.startsWith("/api/trpc")) {
      const res = fetchRequestHandler({
        endpoint: "/api/trpc",
        req,
        router: appRouter,
        createContext: () => createContext({ req, env, executionCtx: ctx }),
        onError({ path, error }) {
          console.error(JSON.stringify({ event: "trpc_error", path, code: error.code }));
        },
      });
      const headers = corsHeaders(req, allowedOrigin);
      return res.then((r) => {
        const merged = new Response(r.body, r);
        for (const [k, v] of headers) merged.headers.set(k, v);
        return merged;
      });
    }

    // 4. 健康/版本
    if (url.pathname === "/api/health") return healthResponse();
    if (url.pathname === "/api/version") return versionResponse(env.SERVER_VERSION);

    // 5. 预览页
    const previewMatch = url.pathname.match(/^\/dashboard\/preview\/([^/]+)$/);
    if (previewMatch) return previewResponse(env.DB, decodeURIComponent(previewMatch[1]!));

    // 6. 已知 /api/assets/*（Phase 0 无资产，统一 404 JSON）
    if (url.pathname.startsWith("/api/assets/")) return jsonNotFound();

    // 7. 兜底：/api/* 一律 JSON 404；其余普通 404
    if (url.pathname.startsWith("/api/")) return jsonNotFound();
    return new Response("Not Found", { status: 404 });
  },
  // T9 前的最小占位：wrangler.jsonc 声明了 queue consumer，
  // workerd 测试环境要求入口定义 queue()。
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    console.error(JSON.stringify({ event: "queue_unimplemented", messages: batch.messages.length }));
  },
} satisfies ExportedHandler<Env>;
