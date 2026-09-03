const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fixedTimeEqualHex(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

export interface AuthenticatedUser {
  id: string;
  name: string | null;
  email: string | null;
}

export async function authenticateApiKey(
  db: D1Database,
  apiKey: string,
): Promise<AuthenticatedUser | null> {
  const match = /^ak2_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)$/.exec(apiKey);
  if (!match || !match[1] || !match[2]) return null;
  const keyId = match[1];
  const secret = match[2];

  const row = await db
    .prepare(
      "SELECT api_keys.secret_hash, api_keys.revoked_at, users.id, users.name, users.email FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE api_keys.key_id = ?",
    )
    .bind(keyId)
    .first<{ secret_hash: string; revoked_at: number | null; id: string; name: string | null; email: string | null }>();
  if (!row) return null;
  if (row.revoked_at !== null) return null;

  const secretHash = await sha256Hex(secret);
  if (!fixedTimeEqualHex(secretHash, row.secret_hash)) return null;

  return { id: row.id, name: row.name, email: row.email };
}
