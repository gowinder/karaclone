// tRPC capture middleware：procedure 完成后经 waitUntil 记录 shape 事件。
import { initTRPC } from "@trpc/server";
import type { Context } from "../trpc/context.js";
import { shapeJson } from "../phase0/capture.js";
import { getCaptureSession, recordProtocolEvent } from "../phase0/capture-store.js";

const t = initTRPC.context<Context>().create();

export const captureMiddleware = t.middleware(async ({ ctx, next, path, type, input }) => {
  const result = await next();
  const session = await getCaptureSession(ctx.env.DB);
  if (!session || session.enabled !== 1) return result;

  const runId = session.run_id;
  const client = session.client;
  const inputShape = shapeJson(input ?? {});
  const outputShape = result.ok ? shapeJson(result.data) : null;
  const errorCode = result.ok ? null : (result.error as { code?: string } | undefined)?.code ?? "UNKNOWN";

  ctx.executionCtx.waitUntil(
    recordProtocolEvent(ctx.env.DB, runId, client, {
      procedure: path ?? "unknown",
      procedureType: type === "mutation" ? "mutation" : "query",
      inputShape,
      outputShape,
      errorCode,
    }),
  );
  return result;
});
