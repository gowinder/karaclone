import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";

export default {
  fetch(req, env, ctx): Response | Promise<Response> {
    if (new URL(req.url).pathname.startsWith("/api/trpc")) {
      return fetchRequestHandler({
        endpoint: "/api/trpc",
        req,
        router: appRouter,
        createContext: () => createContext({ req, env, executionCtx: ctx }),
      });
    }
    return new Response("phase0 scaffold", { status: 503 });
  },
  // T9 前的最小占位：wrangler.jsonc 声明了 queue consumer，
  // workerd 测试环境要求入口定义 queue()。
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    console.error(JSON.stringify({ event: "queue_unimplemented", messages: batch.messages.length }));
  },
} satisfies ExportedHandler<Env>;
