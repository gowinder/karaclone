// 捕获会话与事件写入：所有写入必须用单条 INSERT ... SELECT，
// SELECT 从 phase0_capture_session 条件读取并同时限定 run_id/client/enabled=1，
// 保证 stop 之后才完成的在途 waitUntil 不会污染已冻结 run。
import type { CaptureClient } from "./capture.js";

export type CaptureSession = {
  run_id: string;
  client: CaptureClient;
  enabled: number;
};

export async function getCaptureSession(db: D1Database): Promise<CaptureSession | null> {
  const row = await db
    .prepare("SELECT run_id, client, enabled FROM phase0_capture_session WHERE singleton = 1")
    .first<{ run_id: string; client: string; enabled: number }>();
  if (!row) return null;
  return { run_id: row.run_id, client: row.client as CaptureClient, enabled: row.enabled };
}

export async function startCaptureSession(
  db: D1Database,
  runId: string,
  client: CaptureClient,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM protocol_events"),
    db.prepare("DELETE FROM protocol_http_events"),
    db.prepare("DELETE FROM protocol_route_events"),
    db
      .prepare(
        "INSERT INTO phase0_capture_session (singleton, run_id, client, enabled, started_at) VALUES (1, ?, ?, 1, ?) ON CONFLICT(singleton) DO UPDATE SET run_id = excluded.run_id, client = excluded.client, enabled = 1, started_at = excluded.started_at",
      )
      .bind(runId, client, new Date().toISOString()),
  ]);
}

export async function stopCaptureSession(db: D1Database): Promise<void> {
  await db.prepare("UPDATE phase0_capture_session SET enabled = 0 WHERE singleton = 1").run();
}

export async function recordProtocolEvent(
  db: D1Database,
  runId: string,
  client: CaptureClient,
  event: {
    procedure: string;
    procedureType: "query" | "mutation";
    inputShape: string;
    outputShape: string | null;
    errorCode: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO protocol_events (run_id, client, procedure, procedure_type, input_shape, output_shape, error_code, created_at)
       SELECT run_id, client, ?, ?, ?, ?, ?, ?
       FROM phase0_capture_session
       WHERE singleton = 1 AND run_id = ? AND client = ? AND enabled = 1`,
    )
    .bind(
      event.procedure,
      event.procedureType,
      event.inputShape,
      event.outputShape,
      event.errorCode,
      new Date().toISOString(),
      runId,
      client,
    )
    .run();
}

export async function recordHttpEvent(
  db: D1Database,
  runId: string,
  client: CaptureClient,
  event: {
    method: string;
    isBatch: boolean;
    procedures: string;
    requestEnvelopeShape: string;
    responseStatus: number;
    responseEnvelopeShape: string;
    fixedTestHeaderSeen: boolean;
    corsFixedHeaderRequested: boolean | null;
    corsFixedHeaderAllowed: boolean | null;
    corsOriginMatched: boolean | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO protocol_http_events (run_id, client, method, is_batch, procedures, request_envelope_shape, response_status, response_envelope_shape, fixed_test_header_seen, cors_fixed_header_requested, cors_fixed_header_allowed, cors_origin_matched, created_at)
       SELECT run_id, client, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM phase0_capture_session
       WHERE singleton = 1 AND run_id = ? AND client = ? AND enabled = 1`,
    )
    .bind(
      event.method,
      event.isBatch ? 1 : 0,
      event.procedures,
      event.requestEnvelopeShape,
      event.responseStatus,
      event.responseEnvelopeShape,
      event.fixedTestHeaderSeen ? 1 : 0,
      event.corsFixedHeaderRequested === null ? null : event.corsFixedHeaderRequested ? 1 : 0,
      event.corsFixedHeaderAllowed === null ? null : event.corsFixedHeaderAllowed ? 1 : 0,
      event.corsOriginMatched === null ? null : event.corsOriginMatched ? 1 : 0,
      new Date().toISOString(),
      runId,
      client,
    )
    .run();
}

export async function recordRouteEvent(
  db: D1Database,
  runId: string,
  client: CaptureClient,
  event: {
    method: string;
    routeTemplate: string;
    responseStatus: number;
    requestShape: string;
    responseShape: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO protocol_route_events (run_id, client, method, route_template, response_status, request_shape, response_shape, created_at)
       SELECT run_id, client, ?, ?, ?, ?, ?, ?
       FROM phase0_capture_session
       WHERE singleton = 1 AND run_id = ? AND client = ? AND enabled = 1`,
    )
    .bind(
      event.method,
      event.routeTemplate,
      event.responseStatus,
      event.requestShape,
      event.responseShape,
      new Date().toISOString(),
      runId,
      client,
    )
    .run();
}
