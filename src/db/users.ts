export interface NewUser {
  id: string;
  name: string | null;
  email: string | null;
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
    .prepare("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.name, user.email, Date.now())
    .run();
}

export async function insertApiKey(db: D1Database, key: NewApiKey): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(key.id, key.userId, key.keyId, key.secretHash, key.name, key.scope, Date.now())
    .run();
}
