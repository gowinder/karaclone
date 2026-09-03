import { authenticateApiKey } from "../auth/api-key.js";

const SUPPORTED_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "text/html",
  "application/pdf",
]);

const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25 MiB

async function authUser(env: Env, req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const apiKey = auth.slice("Bearer ".length).trim();
  if (!apiKey) return null;
  return authenticateApiKey(env.DB, apiKey);
}

export async function handleAssetUpload(req: Request, env: Env): Promise<Response> {
  const user = await authUser(env, req);
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid form data" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const file = form.get("file") ?? form.get("image");
  if (!(file instanceof File)) {
    return new Response(JSON.stringify({ error: "Missing file field" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!SUPPORTED_UPLOAD_TYPES.has(file.type)) {
    return new Response(JSON.stringify({ error: `Unsupported content type: ${file.type}` }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return new Response(JSON.stringify({ error: "File too large" }), { status: 413, headers: { "Content-Type": "application/json" } });
  }

  const assetId = crypto.randomUUID();
  const fileName = file.name.replace(/[^\x20-\x7E]/g, "_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  await env.ASSETS.put(assetId, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { userId: user.id, fileName },
  });
  await env.DB.prepare(
    "INSERT INTO assets (id, asset_type, size, content_type, file_name, user_id, created_at) VALUES (?, 'user-uploaded', ?, ?, ?, ?, ?)",
  )
    .bind(assetId, file.size, file.type, fileName, user.id, Date.now())
    .run();

  return new Response(
    JSON.stringify({ assetId, contentType: file.type, size: file.size, fileName }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export async function handleAssetGet(req: Request, env: Env, assetId: string): Promise<Response> {
  const user = await authUser(env, req);
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

  const row = await env.DB.prepare("SELECT user_id, content_type, file_name FROM assets WHERE id = ?")
    .bind(assetId)
    .first<{ user_id: string; content_type: string | null; file_name: string | null }>();
  if (!row || row.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const object = await env.ASSETS.get(assetId);
  if (!object) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const headers = new Headers();
  headers.set("Content-Type", row.content_type ?? "application/octet-stream");
  if (row.file_name) {
    headers.set("Content-Disposition", `inline; filename="${row.file_name}"`);
  }
  return new Response(object.body, { status: 200, headers });
}
