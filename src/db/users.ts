export interface NewUser {
  id: string;
  name: string | null;
  email: string | null;
  passwordHash?: string | null;
  passwordSalt?: string | null;
}

export interface NewApiKey {
  id: string;
  userId: string;
  keyId: string;
  secretHash: string;
  name: string;
  scope: "fullaccess";
}

export async function insertUser(db: D1Database, user: NewUser): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (id, name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(user.id, user.name, user.email, user.passwordHash ?? null, user.passwordSalt ?? null, Date.now())
    .run();
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<{
  id: string;
  name: string | null;
  email: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
} | null> {
  const row = await db
    .prepare("SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?")
    .bind(email)
    .first<{
      id: string;
      name: string | null;
      email: string | null;
      password_hash: string | null;
      password_salt: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
  };
}

export function generateKeyId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateKeySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function insertApiKey(db: D1Database, key: NewApiKey): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(key.id, key.userId, key.keyId, key.secretHash, key.name, key.scope, Date.now())
    .run();
}
