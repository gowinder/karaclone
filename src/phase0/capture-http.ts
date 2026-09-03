// HTTP 层捕获：tRPC envelope、CORS 预检、route 事件。
// 只以常量查找固定测试头，绝不枚举/保存 header 名称或值。
import { authenticateApiKey } from "../auth/api-key.js";
import {
  FIXED_TEST_HEADER,
  hasFixedTestHeader,
  isCaptureClient,
  isValidRunId,
  shapeJson,
} from "./capture.js";
import {
  getCaptureSession,
  recordHttpEvent,
  recordRouteEvent,
  startCaptureSession,
  stopCaptureSession,
} from "./capture-store.js";

const UNPARSEABLE = '"unparseable"';

export async function handleCaptureControl(
  req: Request,
  env: Env,
): Promise<Response | null> {
  if (env.PHASE0_CAPTURE !== "true") return null;
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/__phase0/capture/")) return null;

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
  const user = await authenticateApiKey(env.DB, auth.slice("Bearer ".length).trim());
  if (!user) return new Response("Unauthorized", { status: 401 });

  if (req.method === "POST" && url.pathname.endsWith("/start")) {
    const body = (await req.json().catch(() => null)) as { runId?: unknown; client?: unknown } | null;
    const runId = body?.runId;
    const client = body?.client;
    if (typeof runId !== "string" || !isValidRunId(runId) || typeof client !== "string" || !isCaptureClient(client)) {
      return new Response("Bad Request", { status: 400 });
    }
    await startCaptureSession(env.DB, runId, client);
    return Response.json({ ok: true });
  }

  if (req.method === "POST" && url.pathname.endsWith("/stop")) {
    await stopCaptureSession(env.DB);
    return Response.json({ ok: true });
  }

  if (req.method === "GET" && url.pathname.endsWith("/events")) {
    const runId = url.searchParams.get("runId");
    if (!runId) return new Response("Bad Request", { status: 400 });
    const rows = await env.DB.prepare(
      "SELECT procedure, procedure_type, input_shape, output_shape, error_code FROM protocol_events WHERE run_id = ? ORDER BY id",
    )
      .bind(runId)
      .all();
    return Response.json(rows.results);
  }

  if (req.method === "GET" && url.pathname.endsWith("/http-events")) {
    const runId = url.searchParams.get("runId");
    if (!runId) return new Response("Bad Request", { status: 400 });
    const rows = await env.DB.prepare(
      "SELECT method, is_batch, procedures, request_envelope_shape, response_status, response_envelope_shape, fixed_test_header_seen, cors_fixed_header_requested, cors_fixed_header_allowed, cors_origin_matched FROM protocol_http_events WHERE run_id = ? ORDER BY id",
    )
      .bind(runId)
      .all();
    return Response.json(rows.results);
  }

  if (req.method === "GET" && url.pathname.endsWith("/route-events")) {
    const runId = url.searchParams.get("runId");
    if (!runId) return new Response("Bad Request", { status: 400 });
    const rows = await env.DB.prepare(
      "SELECT method, route_template, response_status, request_shape, response_shape FROM protocol_route_events WHERE run_id = ? ORDER BY id",
    )
      .bind(runId)
      .all();
    return Response.json(rows.results);
  }

  if (req.method === "GET" && url.pathname.endsWith("/unknown-procedures")) {
    const runId = url.searchParams.get("runId");
    if (!runId) return new Response("Bad Request", { status: 400 });
    const rows = await env.DB.prepare(
      "SELECT procedure FROM protocol_events WHERE run_id = ? AND error_code = 'NOT_FOUND' ORDER BY id",
    )
      .bind(runId)
      .all();
    return Response.json(rows.results);
  }

  if (req.method === "GET" && url.pathname.endsWith("/status")) {
    const session = await getCaptureSession(env.DB);
    const runId = session?.run_id ?? null;
    const [protocol, http, route, unknown] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_events WHERE run_id = ?").bind(runId).first<{ c: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_http_events WHERE run_id = ?").bind(runId).first<{ c: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_route_events WHERE run_id = ?").bind(runId).first<{ c: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS c FROM protocol_events WHERE run_id = ? AND error_code = 'NOT_FOUND'").bind(runId).first<{ c: number }>(),
    ]);
    return Response.json({
      enabled: session?.enabled === 1,
      runId,
      client: session?.client ?? null,
      counts: { protocol: protocol?.c ?? 0, http: http?.c ?? 0, route: route?.c ?? 0 },
      unknownProcedures: unknown?.c ?? 0,
    });
  }

  return new Response("Not Found", { status: 404 });
}

// 解析 tRPC 请求 envelope（GET query 或 POST body），失败返回 unparseable。
async function parseTrpcEnvelope(req: Request): Promise<unknown> {
  try {
    if (req.method === "GET") {
      const input = new URL(req.url).searchParams.get("input");
      return input ? JSON.parse(input) : null;
    }
    return await req.clone().json();
  } catch {
    return UNPARSEABLE;
  }
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    return UNPARSEABLE;
  }
}

export async function captureTrpcHttp(
  req: Request,
  res: Response,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const session = await getCaptureSession(env.DB);
  if (!session || session.enabled !== 1) return;

  const url = new URL(req.url);
  const pathPart = url.pathname.slice("/api/trpc/".length);
  const procedures = pathPart.split(",").map((p) => decodeURIComponent(p));
  const isBatch = url.searchParams.get("batch") === "1" || procedures.length > 1;

  const requestEnvelope = await parseTrpcEnvelope(req);
  const responseEnvelope = await parseJsonBody(res);

  const origin = req.headers.get("Origin");
  const isExtension = session.client === "extension";
  const originMatched = origin === env.ALLOWED_EXTENSION_ORIGIN;
  const isPreflight = req.method === "OPTIONS";
  const acrh = req.headers.get("Access-Control-Request-Headers") ?? "";
  const corsRequested = isExtension && isPreflight ? acrh.toLowerCase().includes(FIXED_TEST_HEADER) : null;
  const corsAllowed = isExtension && isPreflight ? res.headers.get("access-control-allow-headers")?.toLowerCase().includes(FIXED_TEST_HEADER) ?? false : null;
  const corsOriginMatched = isExtension ? (origin ? originMatched : null) : null;

  ctx.waitUntil(
    recordHttpEvent(env.DB, session.run_id, session.client, {
      method: req.method,
      isBatch,
      procedures: procedures.join(","),
      requestEnvelopeShape: typeof requestEnvelope === "string" ? requestEnvelope : shapeJson(requestEnvelope),
      responseStatus: res.status,
      responseEnvelopeShape: typeof responseEnvelope === "string" ? responseEnvelope : shapeJson(responseEnvelope),
      fixedTestHeaderSeen: hasFixedTestHeader(req.headers),
      corsFixedHeaderRequested: corsRequested,
      corsFixedHeaderAllowed: corsAllowed,
      corsOriginMatched,
    }),
  );
}

// 动态路径 ID 映射为 :id；无法映射记录 unknown；控制端点排除。
export function mapRouteTemplate(pathname: string): string {
  if (pathname.startsWith("/api/trpc/")) return "api/trpc";
  if (pathname === "/api/health") return "api/health";
  if (pathname === "/api/version") return "api/version";
  const preview = pathname.match(/^\/dashboard\/preview\/([^/]+)$/);
  if (preview) return "dashboard/preview/:id";
  const asset = pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (asset) return "api/assets/:id";
  return "unknown";
}

export async function captureRouteEvent(
  req: Request,
  res: Response,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/__phase0/capture/")) return;
  const session = await getCaptureSession(env.DB);
  if (!session || session.enabled !== 1) return;

  const requestShape = await parseTrpcEnvelope(req);
  const responseShape = await parseJsonBody(res);

  ctx.waitUntil(
    recordRouteEvent(env.DB, session.run_id, session.client, {
      method: req.method,
      routeTemplate: mapRouteTemplate(url.pathname),
      responseStatus: res.status,
      requestShape: typeof requestShape === "string" ? requestShape : shapeJson(requestShape),
      responseShape: typeof responseShape === "string" ? responseShape : shapeJson(responseShape),
    }),
  );
}
