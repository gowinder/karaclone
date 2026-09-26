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
import { handleQueueProbe } from "./phase0/queue-probe.js";
import { handleAiProbe } from "./phase0/ai-probe.js";
import { handleEnrichmentBatch } from "./queue/consumer.js";
import { handleImportBatch } from "./queue/import-consumer.js";
import { handleAssetUpload, handleAssetGet } from "./http/assets.js";
import { handleDashboard } from "./http/dashboard.js";
import { handleDlqBatch } from "./queue/dlq.js";
import { runCronInvocation } from "./queue/cron.js";

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

    // 2b. Phase 0 Queue 探针接口（受认证保护）
    const queueProbe = await handleQueueProbe(req, env);
    if (queueProbe) return queueProbe;

    // 2c. Phase 0 AI JSON Mode 探针（受认证保护）
    const aiProbe = await handleAiProbe(req, env);
    if (aiProbe) return aiProbe;

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
        headers.forEach((v, k) => merged.headers.set(k, v));
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

    // 4b. 面板
    if (url.pathname === "/dashboard" || url.pathname === "/") {
      const res = await handleDashboard(env);
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

    // 6. 资产上传与下载
    if (url.pathname === "/api/assets" && req.method === "POST") {
      const res = await handleAssetUpload(req, env);
      void captureRouteEvent(req, res, env, ctx);
      return res;
    }
    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch && req.method === "GET") {
      const res = await handleAssetGet(req, env, decodeURIComponent(assetMatch[1]!));
      void captureRouteEvent(req, res, env, ctx);
      return res;
    }
    if (url.pathname.startsWith("/api/assets")) {
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

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "karaclone-phase0-enrichment-dlq") {
      await handleDlqBatch(env.DB, batch);
      return;
    }
    if (batch.queue === "karaclone-phase0-import") {
      await handleImportBatch(env.DB, batch, env);
      return;
    }
    await handleEnrichmentBatch(env.DB, batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runCronInvocation(env.DB, env.ENRICHMENT_QUEUE, env.PHASE0_CAPTURE === "true");
  },
} satisfies ExportedHandler<Env>;
