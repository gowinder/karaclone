/**
 * Phase 0 Android APK verifier（可重放、fail-closed）。
 *
 * 从锁定的官方不可变 asset URL 下载已签名 APK，运行 Android Build Tools 的
 * `apksigner verify --verbose --print-certs` 与
 * `apkanalyzer manifest application-id|version-name|version-code`，
 * 保存脱敏规范化投影与 canonical hash，校验预期 package ID、version/build、
 * 签名证书 SHA-256 allow-list。
 *
 * 信任根（仅 Android）：immutableSourceUrl + assetId + 签名证书 allow-list。
 * 拒绝：非锁定 URL、错误 asset id、非 allow-list host、不可导出包、null package hash。
 *
 * 注入点：fetchImpl / runTool / constants（供 package-verifiers.test.ts fixtures）。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS_DIR = join(REPO_ROOT, "artifacts", "phase0");

export const ANDROID_LOCK = Object.freeze({
  versionName: "1.11.0",
  versionCode: 45,
  url: "https://github.com/karakeep-app/mobile-releases/releases/download/1.11.0/karakeep.apk",
  assetId: 536907626,
  size: 150947254,
  packageId: "app.hoarder.hoardermobile",
  packageSha256: "eb6891a77f1d6471f6139622e2f9242f24fae100ec6f9b0f63d044dfaaa37eab",
  sourceRepository: "https://github.com/karakeep-app/mobile-releases",
  sourceTag: "1.11.0",
  sourceCommit: "2f988f02440c0690d19905429f81d3f946cba8ae",
  signingCertificateSha256: "0A:9F:4A:6B:90:0B:DA:E4:D4:AD:7E:F3:E7:D7:73:90:1D:87:08:84:1A:DB:29:4C:49:4B:18:2A:1E:81:C3:D9",
});

const HOSTS_ALLOWED = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.github.com",
]);

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 只保留验证相关行的稳定投影，其余一律 [REDACTED]。 */
export function redactToolOutput(text) {
  const lines = String(text).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^Signer #1 certificate SHA-256 digest:/i.test(t)) kept.push(t);
    else if (/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/i.test(t)) kept.push(t);
    else if (/^(application-id|version-name|version-code):/.test(t)) kept.push(t);
    else kept.push("[REDACTED]");
  }
  return kept.join("\n");
}

function parseFingerprint(text) {
  // 兼容带冒号（0A:9F:...）与无冒号（0a9f4a6b...）两种输出，统一为带冒号大写。
  const m = String(text).match(/([0-9A-F]{2}(?::[0-9A-F]{2}){31}|[0-9A-F]{64})/i);
  if (!m) return null;
  const hex = m[1].replace(/:/g, "").toUpperCase();
  return hex.match(/.{2}/g).join(":");
}

function findBuildTools() {
  const candidates = [];
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) candidates.push(sdk);
  const home = process.env.HOME || "";
  candidates.push(join(home, "Library", "Android", "sdk"));
  candidates.push(join(home, "Android", "Sdk"));
  candidates.push("/opt/homebrew/share/android-commandlinetools", "/usr/local/share/android-commandlinetools");
  // 注意：不能边遍历边 unshift（迭代器会无限循环）。先收集版本目录再统一前插。
  const versionDirs = [];
  for (const base of candidates) {
    const bt = join(base, "build-tools");
    let versions = [];
    try {
      versions = readdirSync(bt).sort().reverse();
    } catch {
      continue;
    }
    for (const v of versions) {
      versionDirs.push(join(bt, v));
    }
  }
  candidates.unshift(...versionDirs);
  for (const dir of candidates) {
    if (existsSync(join(dir, "apksigner"))) return dir;
  }
  return null;
}

function defaultRunTool(tool, args) {
  const bt = findBuildTools();
  let bin = null;
  if (bt) {
    const candidate = join(bt, tool);
    if (existsSync(candidate)) bin = candidate;
  }
  if (!bin) {
    // apkanalyzer 由 cmdline-tools 提供（PATH 中）；apksigner 必须来自 build-tools
    const fromPath = spawnSync("which", [tool], { encoding: "utf8" });
    if (fromPath.status === 0 && fromPath.stdout.trim()) bin = fromPath.stdout.trim();
  }
  if (!bin) {
    throw new Error(
      `ANDROID_BUILD_TOOLS_MISSING: ${tool} not found; install Android build-tools (brew install --cask android-commandlinetools + sdkmanager "build-tools;...")`,
    );
  }
  const res = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (res.error) throw res.error;
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const defaultFetch = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  return { status: res.status, finalUrl: res.url, body: new Uint8Array(await res.arrayBuffer()) };
};

function isAllowedUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:" && HOSTS_ALLOWED.has(u.hostname);
}

/** 校验锁定 URL 并从官方 API 独立核对 assetId/size（始终执行，不因缓存跳过）。 */
async function verifyAssetApi({ fetchImpl, constants }) {
  if (constants.url !== ANDROID_LOCK.url) throw new Error("ANDROID_URL_MISMATCH: 非锁定 immutable asset URL");
  if (!isAllowedUrl(constants.url)) throw new Error("ANDROID_HOST_NOT_ALLOWED");
  const apiRes = await fetchImpl("https://api.github.com/repos/karakeep-app/mobile-releases/releases/tags/1.11.0");
  if (apiRes.status !== 200) throw new Error(`ANDROID_ASSET_API_FAILED: HTTP ${apiRes.status}`);
  const meta = JSON.parse(new TextDecoder().decode(apiRes.body));
  const asset = (meta.assets ?? []).find((a) => a.browser_download_url === constants.url);
  if (!asset) throw new Error("ANDROID_ASSET_NOT_FOUND");
  if (asset.id !== constants.assetId) throw new Error(`ANDROID_ASSET_ID_MISMATCH: ${asset.id}`);
  if (asset.size !== constants.size) throw new Error(`ANDROID_ASSET_SIZE_MISMATCH: ${asset.size}`);
  return { finalUrl: constants.url, assetId: asset.id, size: asset.size };
}

/** 下载 APK 字节（锁定 URL、允许 GitHub 重定向域），校验 size/sha。 */
async function fetchApkBytes({ fetchImpl, constants }) {
  if (constants.url !== ANDROID_LOCK.url) throw new Error("ANDROID_URL_MISMATCH: 非锁定 immutable asset URL");
  if (!isAllowedUrl(constants.url)) throw new Error("ANDROID_HOST_NOT_ALLOWED");
  const res = await fetchImpl(constants.url);
  if (res.status !== 200) throw new Error(`ANDROID_DOWNLOAD_FAILED: HTTP ${res.status}`);
  const body = res.body;
  if (body.length !== constants.size) throw new Error(`ANDROID_SIZE_MISMATCH: ${body.length} != ${constants.size}`);
  const finalUrl = res.finalUrl ?? constants.url;
  if (finalUrl !== constants.url && !isAllowedUrl(finalUrl)) throw new Error("ANDROID_FINAL_URL_NOT_ALLOWED");
  return { finalUrl, bytes: body };
}

function runAndroidTools({ runTool, apkPath, version }) {
  const apksigner = runTool("apksigner", ["verify", "--verbose", "--print-certs", apkPath]);
  if (apksigner.status !== 0) throw new Error(`APKSIGNER_FAILED: exit ${apksigner.status}`);
  const certFp = parseFingerprint(apksigner.stdout + "\n" + apksigner.stderr);
  if (!certFp) throw new Error("APKSIGNER_NO_CERT_FINGERPRINT");

  const appIdRes = runTool("apkanalyzer", ["manifest", "application-id", apkPath]);
  const versionNameRes = runTool("apkanalyzer", ["manifest", "version-name", apkPath]);
  const versionCodeRes = runTool("apkanalyzer", ["manifest", "version-code", apkPath]);
  const applicationId = (appIdRes.stdout ?? "").trim();
  const versionName = (versionNameRes.stdout ?? "").trim();
  const versionCodeRaw = (versionCodeRes.stdout ?? "").trim();
  const versionCode = Number(versionCodeRaw);
  if (!applicationId || !versionName || !Number.isInteger(versionCode)) throw new Error("APKANALYZER_INCOMPLETE");

  const projection = {
    apksigner: redactToolOutput(`Signer #1 certificate SHA-256 digest:\n${certFp}`),
    apkanalyzerManifest: redactToolOutput(`application-id: ${applicationId}\nversion-name: ${versionName}\nversion-code: ${versionCodeRaw}`),
    toolVersions: {
      apksigner: (apksigner.stdout.match(/apksigner version ([^\s]+)/i) ?? [null, null])[1] ?? null,
      apkanalyzer: (appIdRes.stdout.match(/apkanalyzer version ([^\s]+)/i) ?? [null, null])[1] ?? null,
    },
    verifierVersion: version,
  };
  return { certFp, applicationId, versionName, versionCode, projection };
}

/** 核心验证；返回不含 canonical 自哈希字段的 manifest 主体。 */
export async function verifyAndroidPackage({
  fetchImpl = defaultFetch,
  runTool = defaultRunTool,
  constants = ANDROID_LOCK,
  version = "1.0.0",
} = {}) {
  // asset API 校验始终执行（URL/assetId/size 不因缓存跳过）。
  const assetMeta = await verifyAssetApi({ fetchImpl, constants });
  // 磁盘缓存：150MB APK 避免重复下载。缓存键 = packageSha256（内容寻址），命中时校验 sha256。
  const cacheApk = join(REPO_ROOT, ".phase0", "cache", `karakeep-${constants.packageSha256}.apk`);
  let bytes = null;
  if (existsSync(cacheApk)) {
    const cached = readFileSync(cacheApk);
    if (cached.length === constants.size && sha256Hex(cached) === constants.packageSha256) {
      bytes = cached;
    }
  }
  if (!bytes) {
    const dl = await fetchApkBytes({ fetchImpl, constants });
    bytes = dl.bytes;
    mkdirSync(dirname(cacheApk), { recursive: true });
    writeFileSync(cacheApk, bytes);
  }
  const download = {
    finalUrl: assetMeta.finalUrl,
    assetId: assetMeta.assetId,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    bytes,
  };
  const tmpApk = join(REPO_ROOT, ".phase0", "tmp", `karakeep-${constants.versionName}.apk`);
  mkdirSync(dirname(tmpApk), { recursive: true });
  writeFileSync(tmpApk, download.bytes);

  const tool = runAndroidTools({ runTool, apkPath: tmpApk, version });
  const passed =
    download.sha256 === constants.packageSha256 &&
    download.size === constants.size &&
    download.assetId === constants.assetId &&
    tool.applicationId === constants.packageId &&
    tool.versionName === constants.versionName &&
    tool.versionCode === constants.versionCode &&
    tool.certFp === constants.signingCertificateSha256;

  return {
    lockStatus: "PENDING",
    client: "mobile",
    platform: "android",
    version: constants.versionName,
    build: String(constants.versionCode),
    packageId: constants.packageId,
    packageSha256: download.sha256,
    packageSize: download.size,
    immutableSourceUrl: constants.url,
    finalUrl: download.finalUrl,
    assetId: download.assetId,
    sourceRepository: constants.sourceRepository,
    sourceTag: constants.sourceTag,
    sourceCommit: constants.sourceCommit,
    signingCertificateSha256: tool.certFp,
    signerAllowList: [ANDROID_LOCK.signingCertificateSha256],
    verifierVersions: { android: version },
    verificationProjection: tool.projection,
    verificationProjectionSha256: null,
    canonicalSha256: null,
    passed,
  };
}

/** 原子写 JSON artifact。 */
export async function writeArtifactJson(path, obj) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * CLI：
 *   node verify-android-package.mjs [--write-lock <lock.tmp.json>]
 */
export async function main(argv) {
  const args = argv.slice(2);
  const lockIdx = args.indexOf("--write-lock");
  const lockPath = lockIdx >= 0 ? args[lockIdx + 1] : null;

  const manifest = await verifyAndroidPackage();
  const projectionSha = await canonicalJsonHash(manifest.verificationProjection);
  let final = { ...manifest, verificationProjectionSha256: projectionSha };

  if (lockPath) {
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(lockPath, "utf8").toString());
    } catch {
      existing = {};
    }
    final.clientLockSha256 = existing.clientLockSha256 ?? null;
    const merged = { ...existing, android: final };
    await writeArtifactJson(lockPath, merged);
  } else {
    final.clientLockSha256 = null;
  }

  final.canonicalSha256 = await canonicalJsonHash(final);
  const manifestPath = join(ARTIFACTS_DIR, "android-client-manifest.json");
  await writeArtifactJson(manifestPath, final);

  console.log(JSON.stringify({ android: { passed: final.passed, packageSha256: final.packageSha256, manifestPath } }));
  process.exit(final.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`verify-android-package: ${err.message}`);
    process.exit(2);
  });
}
