// API key 加密存储：AES-GCM，key 派生自环境 secret（LLM_CONFIG_KEY）。
// 格式：v1:<ivHex>:<cipherHex>，iv 12 字节随机。
const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode("karaclone-llm-config"), iterations: 100_000 },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return `v1:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipher))}`;
}

export async function decryptSecret(enc: string, secret: string): Promise<string> {
  const parts = enc.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("INVALID_ENCRYPTED_FORMAT");
  const key = await deriveKey(secret);
  const iv = hexToBytes(parts[1]!);
  const cipher = hexToBytes(parts[2]!);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
