// 密码哈希：PBKDF2-SHA256（WebCrypto，Workers 可用）。
// upstream 用 bcrypt（Node 原生模块，Workers 不可用），此处以 PBKDF2 替代。
// 存储格式：pbkdf2$<iterations>$<saltHex>$<hashHex>
const encoder = new TextEncoder();

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations,
    },
    keyMaterial,
    KEY_BYTES * 8,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function generatePasswordSalt(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return bytesToHex(bytes);
}

export async function hashPassword(password: string): Promise<{
  hash: string;
  salt: string;
}> {
  const salt = await generatePasswordSalt();
  const hash = await derivePasswordHash(password, salt);
  return { hash, salt };
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  if (!storedHash || !storedSalt) return false;
  const candidate = await derivePasswordHash(password, storedSalt);
  return candidate === storedHash;
}
