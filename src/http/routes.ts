import { renderReaderHtml } from "../bookmarks/reader-html.js";

// RFC 7230 token 字符：tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isHttpToken(value: string): boolean {
  return TCHAR.test(value);
}

// 扩展 Origin 白名单：仅允许 client-lock 中确定性推导的 Store ID。
// 支持逗号分隔多值（官方 Store ID + 本地开发固定 key 的 ID）。
// 动态回显 Access-Control-Request-Headers 中每个符合 HTTP token 语法的头；
// 非法 header name 或非白名单 Origin 一律不返回 CORS allow header。绝不用 "*"。
export function isAllowedOrigin(origin: string | null, allowedOriginsCsv: string): boolean {
  if (!origin) return false;
  return allowedOriginsCsv
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .includes(origin);
}

export function corsPreflight(req: Request, allowedOrigin: string): Response | null {
  const origin = req.headers.get("Origin");
  if (!origin || !isAllowedOrigin(origin, allowedOrigin)) return null;

  const requestedHeaders = req.headers.get("Access-Control-Request-Headers");
  if (requestedHeaders === null) {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin } });
  }
  const names = requestedHeaders
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (names.length === 0 || names.some((h) => !isHttpToken(h))) return null;

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": names.join(", "),
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function corsHeaders(req: Request, allowedOrigin: string): Headers {
  const headers = new Headers();
  const origin = req.headers.get("Origin");
  if (origin && isAllowedOrigin(origin, allowedOrigin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

export function healthResponse(): Response {
  return Response.json({ status: "ok", message: "Web app is working" });
}

export function versionResponse(version: string): Response {
  return Response.json({ version });
}

export function jsonNotFound(): Response {
  return new Response(JSON.stringify({ error: "Not Found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

export async function previewResponse(db: D1Database, bookmarkId: string): Promise<Response> {
  const row = await db
    .prepare("SELECT id, canonical_url, title, summary FROM bookmarks WHERE id = ?")
    .bind(bookmarkId)
    .first<{ id: string; canonical_url: string; title: string | null; summary: string | null }>();
  if (!row) {
    return new Response("<h1>Not Found</h1>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const html = renderReaderHtml({
    title: row.title,
    url: row.canonical_url,
    summary: row.summary,
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
