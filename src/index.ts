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
import {
  captureRouteEvent,
  captureTrpcHttp,
  handleCaptureControl,
} from "./phase0/capture-http.js";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // 2. Phase 0 捕获控制接口（受认证保护）
    const control = await handleCaptureControl(req, env);
    if (control) return control;

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
        void captureTrpcHttp(req, merged, env, ctx);
        void captureRouteEvent(req, merged, env, ctx);
        return merged;
      });
    }

    // 4. 健康/版本
    if (url.pathname === "/api/health") {
      const res = healthResponse();
      void captureRouteEvent(req, res, env, ctx);
      return res;
    }
    if (url.pathname === "/api/version") {
      const res = versionResponse(env.SERVER_VERSION);
      void captureRouteEvent(req, res, env, ctx);
      return res;
    }

    // 5. 预览页
    const previewMatch = url.pathname.match(/^\/dashboard\/preview\/([^/]+)$/);
    if (previewMatch) {
      const res = previewResponse(env.DB, decodeURIComponent(previewMatch[1]!));
      return res.then((r) => {
        void captureRouteEvent(req, r, env, ctx);
        return r;
      });
    }

    // 6. 已知 /api/assets/*（Phase 0 无资产，统一 404 JSON）
    if (url.pathname.startsWith("/api/assets/")) {
      const res = jsonNotFound();
      void captureRouteEvent(req, res, env, ctx);
      return res;
    }

    // 7. 兜底：/api/* 一律 JSON 404；其余普通 404
    if (url.pathname.startsWith("/api/")) {
      const res = jsonNotFound();
      void captureRouteEvent(req, res, env, ctx);
      return res;
    }
    const res = new Response("Not Found", { status: 404 });
    void captureRouteEvent(req, res, env, ctx);
    return res;
  },
  // T9 前的最小占位：wrangler.jsonc 声明了 queue consumer，
  // workerd 测试环境要求入口定义 queue()。
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    console.error(JSON.stringify({ event: "queue_unimplemented", messages: batch.messages.length }));
  },
} satisfies ExportedHandler<Env>;
