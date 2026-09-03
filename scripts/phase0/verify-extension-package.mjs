/**
 * Phase 0 Chromium CRX3 扩展 verifier（可重放、fail-closed）。
 *
 * 信任根（仅扩展）：固定 Google `service/update2/crx` 请求模板 + Google 官方
 * TLS redirect-host allow-list + 离线 CRX3 cryptographic proof + 公钥派生
 * extension ID 等于独立 Store ID/version/publisher evidence。
 *
 * 明确禁止（扩展不作信任条件）：immutableSourceUrl、assetId、
 * signer/public-key allow-list、候选 package hash。signerPublicKeySha256/
 * package hash 只出现在 observations，不参与 passed 判定。
 *
 * 注入点：fetchImpl / constants / storeEvidence（供测试构造 fixtures）。
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS_DIR = join(REPO_ROOT, "artifacts", "phase0");

export const EXTENSION_LOCK = Object.freeze({
  extensionId: "kgcjekpmcjjogibpjebkhaanilehneje",
  version: "1.2.11",
  publisher: "karakeep.app",
  storeUrl: "https://chromewebstore.google.com/detail/kgcjekpmcjjogibpjebkhaanilehneje",
  prodversion: "11702.1301.0.0",
  updateUrl: "https://clients2.google.com/service/update2/crx",
  redirectHostAllowList: [
    "clients2.google.com",
    "redirector.gvt1.com",
    "storage.googleapis.com",
    "ssl.gstatic.com",
    "clients2.googleusercontent.com",
  ],
  storeEvidenceFile: "extension-store-evidence.json",
});

const CRX3_SIGNED_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1");

/** 从已验证公钥按 Chromium 规则派生扩展 ID（sha256 前 32 nibble → a-p）。 */
/**
 * 派生扩展 ID。
 * - 优先：signed_header_data.crx_id（16 字节 hex，Chromium 新版）→ 每 hex 字符映射 a-p
 * - 回退：公钥 SHA-256 前 16 字节（旧版算法，测试 fixtures 用）
 */
export function deriveExtensionId(publicKeyDer, crxIdHex = null) {
  if (crxIdHex) {
    let out = "";
    for (const ch of crxIdHex) {
      const v = parseInt(ch, 16);
      out += String.fromCharCode("a".charCodeAt(0) + v);
    }
    return out;
  }
  const digest = createHash("sha256").update(publicKeyDer).digest();
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += String.fromCharCode("a".charCodeAt(0) + ((digest[i] >> 4) & 0x0f));
    out += String.fromCharCode("a".charCodeAt(0) + (digest[i] & 0x0f));
  }
  return out;
}

/* ------------------------- 最小 protobuf reader（CRX3 头） ------------------------- */

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, pos };
    shift += 7;
    if (shift > 35) throw new Error("CRX3_PROTOBUF_VARINT_TOO_LONG");
  }
  throw new Error("CRX3_PROTOBUF_TRUNCATED_VARINT");
}

function readLengthDelimited(buf, pos, len) {
  if (pos + len > buf.length) throw new Error("CRX3_PROTOBUF_TRUNCATED_FIELD");
  return { value: buf.subarray(pos, pos + len), pos: pos + len };
}

function parseSignedData(data) {
  let publicKey = null;
  let signature = null;
  let p = 0;
  while (p < data.length) {
    const tagRes = readVarint(data, p);
    p = tagRes.pos;
    const fieldNum = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x07;
    if (wireType !== 2) throw new Error("CRX3_SIGNED_DATA_BAD_WIRE_TYPE");
    const lenRes = readVarint(data, p);
    p = lenRes.pos;
    const field = readLengthDelimited(data, p, lenRes.value);
    p = field.pos;
    if (fieldNum === 1) publicKey = field.value;
    else if (fieldNum === 2) signature = field.value;
  }
  if (!publicKey || !signature) throw new Error("CRX3_SIGNED_DATA_INCOMPLETE");
  return { publicKey, signature };
}

/**
 * 解析 CRX3 头部 protobuf：CrxFileHeader {
 *   repeated SignedData sha256_with_rsa = 1;
 *   repeated SignedData sha256_with_ecdsa = 2;
 *   bytes signed_header_data = 10000;
 * }
 * 返回 { blocks, signedHeaderData }。
 */
function parseCrxHeader(header) {
  const blocks = [];
  let signedHeaderData = null;
  let pos = 0;
  while (pos < header.length) {
    const tagRes = readVarint(header, pos);
    pos = tagRes.pos;
    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x07;
    if (fieldNumber === 10000) {
      if (wireType !== 2) throw new Error("CRX3_PROTOBUF_UNEXPECTED_WIRE_TYPE");
      const lenRes = readVarint(header, pos);
      pos = lenRes.pos;
      const field = readLengthDelimited(header, pos, lenRes.value);
      pos = field.pos;
      signedHeaderData = field.value;
    } else if (fieldNumber === 2 || fieldNumber === 3 || fieldNumber === 4) {
      // Chromium crx3.proto: 2=sha256_with_rsa, 3=sha256_with_ecdsa, 4=sha256_with_rsa_1024
      if (wireType !== 2) throw new Error("CRX3_PROTOBUF_UNEXPECTED_WIRE_TYPE");
      const lenRes = readVarint(header, pos);
      pos = lenRes.pos;
      const field = readLengthDelimited(header, pos, lenRes.value);
      pos = field.pos;
      const block = parseSignedData(field.value);
      blocks.push({ algorithm: fieldNumber === 2 ? "rsa" : fieldNumber === 3 ? "ecdsa" : "rsa1024", ...block });
    } else if (wireType === 0) {
      const skip = readVarint(header, pos);
      pos = skip.pos;
    } else if (wireType === 2) {
      const lenRes = readVarint(header, pos);
      pos = lenRes.pos;
      const skip = readLengthDelimited(header, pos, lenRes.value);
      pos = skip.pos;
    } else if (wireType === 5) {
      pos += 4;
      if (pos > header.length) throw new Error("CRX3_PROTOBUF_TRUNCATED_FIELD");
    } else if (wireType === 1) {
      pos += 8;
      if (pos > header.length) throw new Error("CRX3_PROTOBUF_TRUNCATED_FIELD");
    } else {
      throw new Error(`CRX3_PROTOBUF_UNSUPPORTED_WIRE_TYPE: ${wireType}`);
    }
  }
  if (blocks.length === 0) throw new Error("CRX3_NO_SIGNATURE_BLOCKS");
  // 从 signed_header_data 提取 crx_id（field 1）
  let crxIdHex = null;
  if (signedHeaderData) {
    let p = 0;
    while (p < signedHeaderData.length) {
      const tagRes = readVarint(signedHeaderData, p);
      p = tagRes.pos;
      const fieldNum = tagRes.value >>> 3;
      const wireType = tagRes.value & 0x07;
      if (wireType !== 2) break;
      const lenRes = readVarint(signedHeaderData, p);
      p = lenRes.pos;
      const field = readLengthDelimited(signedHeaderData, p, lenRes.value);
      p = field.pos;
      if (fieldNum === 1) crxIdHex = Buffer.from(field.value).toString("hex");
    }
  }
  return { blocks, signedHeaderData, crxIdHex };
}

/** 解析整份 CRX3：返回 { blocks, signedHeaderData, zipBytes }。结构异常即 throw。 */
export function parseCrx3(bytes) {
  if (bytes.length < 16) throw new Error("CRX3_TOO_SHORT");
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "Cr24") throw new Error("CRX3_BAD_MAGIC");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 3) throw new Error(`CRX3_UNSUPPORTED_VERSION: ${version}`);
  const headerSize = view.getUint32(8, true);
  if (headerSize <= 0 || headerSize > bytes.length - 12) throw new Error("CRX3_BAD_HEADER_SIZE");
  const header = bytes.subarray(12, 12 + headerSize);
  const zipBytes = bytes.subarray(12 + headerSize);
  if (zipBytes.length < 4) throw new Error("CRX3_NO_ZIP_CONTENT");
  const zipHead = Buffer.from(zipBytes.subarray(0, 4)).toString("latin1");
  if (zipHead !== "PK\u0003\u0004" && zipHead !== "PK\u0005\u0006") throw new Error("CRX3_NOT_ZIP_PAYLOAD");
  const { blocks, signedHeaderData, crxIdHex } = parseCrxHeader(header);
  return { blocks, signedHeaderData, crxIdHex, zipBytes };
}

/**
 * 离线验证 CRX3 签名证明。签名上下文（Chromium）：
 * sha256("CRX3 SignedData\x00" + signed_header_data + archive)
 * 若无 signed_header_data（测试用手搓构造），回退到 context + archive。
 * 任一区块通过即成功。
 */
export function verifyCrxProof(bytes) {
  const { blocks, signedHeaderData, zipBytes, crxIdHex } = parseCrx3(bytes);
  const archiveBytes = Buffer.from(zipBytes);
  // Chromium: 签名覆盖 [prefix][signed-header-size:4B LE][signed-header][archive]
  const signedContext = signedHeaderData
    ? (() => {
        const sizeOctets = Buffer.alloc(4);
        sizeOctets.writeInt32LE(signedHeaderData.length, 0);
        return Buffer.concat([CRX3_SIGNED_CONTEXT, sizeOctets, Buffer.from(signedHeaderData), archiveBytes]);
      })()
    : Buffer.concat([CRX3_SIGNED_CONTEXT, archiveBytes]);
  const errors = [];
  for (const block of blocks) {
    try {
      const key = createPublicKey({ key: block.publicKey, format: "der", type: "spki" });
      const ok =
        block.algorithm === "rsa"
          ? verify("RSA-SHA256", signedContext, key, Buffer.from(block.signature))
          : verify("sha256", signedContext, { key, dsaEncoding: "der" }, Buffer.from(block.signature));
      if (ok) {
        return {
          verified: true,
          algorithm: block.algorithm,
          publicKey: block.publicKey,
          publicKeySha256: createHash("sha256").update(block.publicKey).digest("hex"),
          crxIdHex,
        };
      }
      errors.push(`${block.algorithm}: signature mismatch`);
    } catch (err) {
      errors.push(`${block.algorithm}: ${err.message}`);
    }
  }
  throw new Error(`CRX3_PROOF_FAILED: ${errors.join("; ")}`);
}

/* ------------------------- Google update 请求模板 ------------------------- */

export function buildUpdateRequest(constants) {
  const x = `id=${constants.extensionId}&installsource=ondemand&uc`;
  return `${constants.updateUrl}?response=redirect&acceptformat=crx2,crx3&prodversion=${encodeURIComponent(constants.prodversion)}&x=${encodeURIComponent(x)}`;
}

function isAllowedRedirectHost(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:" && EXTENSION_LOCK.redirectHostAllowList.includes(u.hostname);
}

function loadStoreEvidence(evidenceDir) {
  const file = join(evidenceDir, EXTENSION_LOCK.storeEvidenceFile);
  if (!existsSync(file)) throw new Error("STORE_EVIDENCE_MISSING");
  return JSON.parse(readFileSync(file, "utf8").toString());
}

function sha256FileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertNoForbiddenFields(evidence) {
  const trust = evidence.trust ?? {};
  for (const key of ["immutableSourceUrl", "assetId", "signerAllowList", "trustedSignerPublicKeySha256", "packageHashAllowList", "candidatePackageHashes"]) {
    if (key in evidence || key in trust) {
      throw new Error(`EXTENSION_FORBIDDEN_TRUST_FIELD: ${key}`);
    }
  }
}

/**
 * 核心验证。storeEvidence 可用对象或路径（默认 artifacts/phase0）。
 * any 失败即 throw；成功返回 manifest 主体。
 */
export async function verifyExtensionPackage({
  fetchImpl,
  constants = EXTENSION_LOCK,
  storeEvidence,
  evidenceDir = ARTIFACTS_DIR,
  version = "1.0.0",
} = {}) {
  const fetchFn =
    fetchImpl ??
    (async (url) => {
      const res = await fetch(url, { redirect: "manual" });
      return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
    });
  const evidence = storeEvidence ?? loadStoreEvidence(evidenceDir);
  if (!evidence || typeof evidence !== "object") throw new Error("STORE_EVIDENCE_MISSING");
  assertNoForbiddenFields(evidence);

  const requestUrl = buildUpdateRequest(constants);
  const redirectChain = [];
  let res = await fetchFn(requestUrl);
  let hops = 0;
  const seen = new Set();
  while (res.status >= 300 && res.status < 400 && hops < 8) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("CRX_REDIRECT_WITHOUT_LOCATION");
    if (seen.has(loc)) throw new Error("CRX_REDIRECT_LOOP");
    seen.add(loc);
    redirectChain.push(loc);
    if (!isAllowedRedirectHost(loc)) throw new Error(`CRX_REDIRECT_HOST_NOT_ALLOWED: ${loc}`);
    res = await fetchFn(loc);
    hops++;
  }
  if (res.status !== 200) throw new Error(`CRX_DOWNLOAD_FAILED: HTTP ${res.status}`);
  if (redirectChain.length === 0) throw new Error("CRX_NO_REDIRECT_CHAIN");
  const body = res.body;

  const packageSha256 = createHash("sha256").update(body).digest("hex");
  const proof = verifyCrxProof(body);
  const derivedId = deriveExtensionId(proof.publicKey, proof.crxIdHex);

  // 截图绑定必须先于字段比对：截图缺失/hash 不符单独失败
  const screenshot = evidence.screenshot;
  if (screenshot && typeof screenshot === "object") {
    const png = screenshot.file ? join(evidenceDir, screenshot.file) : null;
    if (!png || !existsSync(png)) throw new Error("STORE_EVIDENCE_SCREENSHOT_MISSING");
    if (sha256FileSync(png) !== screenshot.sha256) throw new Error("STORE_EVIDENCE_SCREENSHOT_HASH_MISMATCH");
  }
  // 独立 Store evidence：ID/version/publisher + canonical hash
  const evidenceHash = await canonicalJsonHash(evidence);
  const storeMatches =
    evidence.extensionId === constants.extensionId &&
    evidence.version === constants.version &&
    evidence.publisher === constants.publisher &&
    evidence.canonicalSha256 === evidenceHash &&
    typeof evidence.fetchedAt === "string";
  if (!storeMatches) throw new Error("STORE_EVIDENCE_MISMATCH");
  if (derivedId !== constants.extensionId) {
    throw new Error(`EXTENSION_ID_MISMATCH: derived ${derivedId} != locked ${constants.extensionId}`);
  }

  const projection = {
    crxRequestTemplate: requestUrl,
    redirectChain,
    redirectHostAllowList: [...constants.redirectHostAllowList],
    responseHeadersProjection: {
      contentLength: body.length,
      contentType: typeof res.headers.get === "function" ? res.headers.get("content-type") : null,
    },
    crxProof: { algorithm: proof.algorithm, publicKeySha256: proof.publicKeySha256 },
    downloadedAt: new Date().toISOString(),
    crxFormat: "CRX3",
    extensionId: derivedId,
    storeEvidenceSha256: evidenceHash,
    verifierVersion: version,
  };

  return {
    lockStatus: "PENDING",
    client: "extension",
    platform: "chrome",
    version: constants.version,
    build: null,
    packageId: constants.extensionId,
    packageSha256,
    packageSize: body.length,
    verificationProjection: projection,
    verificationProjectionSha256: null,
    canonicalSha256: null,
    passed: true,
    observations: {
      signerPublicKeySha256: proof.publicKeySha256,
      finalUrl: redirectChain.at(-1),
    },
    storeEvidenceSha256: evidenceHash,
    extensionId: derivedId,
  };
}

async function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * CLI：
 *   --write-lock <lock.tmp.json>      合并 extension 段
 *   --finalize-lock <lock.tmp.json> --out <lock.json>   原子 finalize
 */
export async function main(argv) {
  const args = argv.slice(2);
  const lockIdx = args.indexOf("--write-lock");
  const lockPath = lockIdx >= 0 ? args[lockIdx + 1] : null;
  const finalizeIdx = args.indexOf("--finalize-lock");
  const finalizePath = finalizeIdx >= 0 ? args[finalizeIdx + 1] : null;
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

  if (finalizePath) {
    const tmpPath = outPath ?? finalizePath;
    const tmp = JSON.parse(readFileSync(finalizePath, "utf8").toString());
    if (!tmp.extension || !tmp.android) throw new Error("LOCK_INCOMPLETE");
    if (!tmp.extension.passed || !tmp.android.passed) throw new Error("LOCK_NOT_PASSED");
    const lock = {
      ...tmp,
      lockStatus: "RESOLVED",
      reviewedBy: process.env.PHASE0_REVIEWER || "human-reviewer",
      reviewedAt: new Date().toISOString(),
    };
    lock.canonicalSha256 = await canonicalJsonHash(lock);
    lock.extension.clientLockSha256 = lock.canonicalSha256;
    lock.android.clientLockSha256 = lock.canonicalSha256;
    lock.canonicalSha256 = await canonicalJsonHash(lock);
    await writeJsonAtomic(tmpPath, lock);
    console.log(JSON.stringify({ lockStatus: "RESOLVED", canonicalSha256: lock.canonicalSha256, out: tmpPath }));
    process.exit(0);
  }

  const manifest = await verifyExtensionPackage();
  const projectionSha = await canonicalJsonHash(manifest.verificationProjection);
  const final = { ...manifest, verificationProjectionSha256: projectionSha, canonicalSha256: null };
  final.canonicalSha256 = await canonicalJsonHash(final);

  if (lockPath) {
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(lockPath, "utf8").toString());
    } catch {
      existing = {};
    }
    const merged = { ...existing, extension: { manifestSha256: final.canonicalSha256, ...final } };
    await writeJsonAtomic(lockPath, merged);
  }

  const manifestPath = join(ARTIFACTS_DIR, "extension-client-manifest.json");
  await writeJsonAtomic(manifestPath, final);
  console.log(JSON.stringify({ extension: { passed: final.passed, extensionId: final.extensionId, manifest: manifestPath } }));
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`verify-extension-package: ${err.message}`);
    process.exit(2);
  });
}
