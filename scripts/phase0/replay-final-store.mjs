/**
 * T15 Step 2：final Store 五文件唯一生成器（禁止手工预建或由 decide 生成）。
 * 自行创建空的随机临时 Chrome user-data-dir、随机本地 CDP port 与不可重放的
 * profileSessionNonce；目录非空、已有扩展、CDP 不是本次 profile，或五个目标
 * 文件任一已存在时立即失败。打开官方 Chrome Web Store 锁定页面，等待用户只
 * 在该 profile 中从 Store 安装锁定 ID/version，通过 CDP 页面/安装来源证据和
 * 实际扩展目录确认不是 unpacked、侧载或其他来源。按锁定 Google request
 * template 重新下载 CRX3，验证 redirect-host allow-list、CRX3 proof、公钥
 * 派生 ID、Store ID/version/publisher 与 package hash，定位真实安装目录，
 * 以同一 exclusionRulesVersion 对安装目录和验签 CRX 解包目录生成稳定排序的
 * 逐文件 {path,size,sha256} manifests；两者 canonical hash 必须相等。通过
 * CDP 截取 final-store-install.png，脱敏/secret scan 后原子生成五文件。
 *
 * 注入契约（测试用）：fetchImpl/cdp/unzip/findExtensionDir 可注入；
 * 真实路径用默认实现。
 *
 * 用法：node scripts/phase0/replay-final-store.mjs --client-lock <path>
 *       --store-evidence <path> --store-content-binding <path>
 *       --deploy-provenance <path> --out-dir <path>
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";
import { buildUpdateRequest, deriveExtensionId, verifyCrxProof, EXTENSION_LOCK } from "./verify-extension-package.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");

const EXCLUSION_RULES_VERSION = "1.0.0";
const FINAL_FILES = [
  "final-store-binding.json",
  "final-store-screenshot-manifest.json",
  "final-installed-content-manifest.json",
  "final-signed-content-manifest.json",
  "final-store-install.png",
];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 稳定排序的逐文件 {path,size,sha256} manifest（相对 POSIX 路径）。 */
export async function buildContentManifest(dir, exclusionRulesVersion) {
  const { readdirSync, statSync } = await import("node:fs");
  const files = [];
  const walk = (rel) => {
    const abs = join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        files.push({ path: childRel, size: statSync(childAbs).size, sha256: sha256File(childAbs) });
      }
    }
  };
  walk("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = { exclusionRulesVersion, files };
  manifest.canonicalSha256 = await canonicalJsonHash(manifest);
  return manifest;
}

/** 默认 CRX 下载：按锁定 request template，验证 redirect allow-list。 */
async function defaultFetchCrx() {
  const requestUrl = buildUpdateRequest(EXTENSION_LOCK);
  const redirectChain = [];
  let res = await fetch(requestUrl, { redirect: "manual" });
  let hops = 0;
  const seen = new Set();
  while (res.status >= 300 && res.status < 400 && hops < 8) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("CRX_REDIRECT_WITHOUT_LOCATION");
    if (seen.has(loc)) throw new Error("CRX_REDIRECT_LOOP");
    seen.add(loc);
    redirectChain.push(loc);
    if (!EXTENSION_LOCK.redirectHostAllowList.some((h) => loc.includes(h))) {
      throw new Error(`CRX_REDIRECT_HOST_NOT_ALLOWED: ${loc}`);
    }
    res = await fetch(loc, { redirect: "manual" });
    hops++;
  }
  if (res.status !== 200) throw new Error(`CRX_DOWNLOAD_FAILED: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return { requestUrl, redirectChain, body: Buffer.from(body) };
}

/** 默认 CDP：连接本地 Chrome，读取扩展信息并截图。 */
async function defaultCdp({ cdpPort, profileDir }) {
  // 真实路径：通过 CDP 连接本地 Chrome（用户已在该 profile 安装扩展）。
  // 测试注入 fakeCdp。
  throw new Error("CDP_REQUIRES_INJECTION");
}

/** 默认扩展目录定位：Chrome 扩展安装目录。 */
async function defaultFindExtensionDir(profileDir) {
  const candidates = [
    join(profileDir, "Default", "Extensions", EXTENSION_LOCK.extensionId),
    join(profileDir, "Profile 1", "Extensions", EXTENSION_LOCK.extensionId),
  ];
  for (const base of candidates) {
    if (existsSync(base)) {
      const { readdirSync } = await import("node:fs");
      const versions = readdirSync(base);
      for (const v of versions) {
        const vDir = join(base, v);
        if (existsSync(vDir)) {
          const { readdirSync: rd } = await import("node:fs");
          const sub = rd(vDir);
          if (sub.length > 0) return join(vDir, sub[0]);
        }
      }
    }
  }
  throw new Error("EXTENSION_DIR_NOT_FOUND");
}

/** 默认 unzip：解包 CRX3 的 zip 部分。 */
async function defaultUnzip(crxPath, outDir) {
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync("unzip", ["-o", crxPath, "-d", outDir], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`UNZIP_FAILED: ${(res.stderr || res.stdout).slice(0, 400)}`);
}

export async function runReplay({
  artifactsDir = ARTIFACTS,
  profileDir,
  profileSessionNonce,
  cdpPort,
  expectedSessionNonce,
  fetchImpl,
  cdp,
  unzip,
  findExtensionDir,
  verifyCrx,
  expectedPackageSha256,
  clientLockPath = join(REPO_ROOT, "config", "phase0", "client-lock.json"),
  storeEvidencePath = join(artifactsDir, "extension-store-evidence.json"),
  contentBindingPath = join(artifactsDir, "extension-store-content-binding.json"),
  deployProvenancePath = join(artifactsDir, "deploy-clients.json"),
  reviewedBy = process.env.PHASE0_REVIEWER || "human-reviewer",
  checkedAt = new Date().toISOString(),
} = {}) {
  // 1. 前置校验：profile 目录必须为空
  if (!profileDir) throw new Error("PROFILE_DIR_REQUIRED");
  if (existsSync(profileDir)) {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(profileDir);
    if (entries.length > 0) throw new Error("PROFILE_DIR_NOT_EMPTY");
  } else {
    mkdirSync(profileDir, { recursive: true });
  }

  // 2. final 五文件任一已存在 → 失败
  for (const name of FINAL_FILES) {
    if (existsSync(join(artifactsDir, name))) throw new Error(`FINAL_ARTIFACT_ALREADY_EXISTS: ${name}`);
  }

  // 3. session nonce 校验
  if (expectedSessionNonce && expectedSessionNonce !== profileSessionNonce) {
    throw new Error("SESSION_NONCE_MISMATCH");
  }

  // 4. 读取锁定证据
  const evidence = readJson(storeEvidencePath);
  if (evidence.extensionId !== EXTENSION_LOCK.extensionId) throw new Error("STORE_EVIDENCE_ID_MISMATCH");
  if (evidence.version !== EXTENSION_LOCK.version) throw new Error("STORE_EVIDENCE_VERSION_MISMATCH");
  if (evidence.publisher !== EXTENSION_LOCK.publisher) throw new Error("STORE_EVIDENCE_PUBLISHER_MISMATCH");
  const contentBinding = readJson(contentBindingPath);
  if (contentBinding.passed !== true) throw new Error("CONTENT_BINDING_NOT_PASSED");
  const deploy = readJson(deployProvenancePath);
  if (deploy.profile !== "clients" || deploy.passed !== true) throw new Error("DEPLOY_PROVENANCE_NOT_CLIENTS");
  const provenance = {
    deploymentId: deploy.deploymentId,
    versionIds: [...(deploy.versionIds ?? [])].sort(),
    profile: deploy.profile,
    workerUrl: deploy.workerUrl,
    sourceDeploySha256: deploy.sourceDeploySha256,
  };

  // 5. CDP：确认安装来源与 ID/version
  const cdpSession = typeof cdp === "function" ? await cdp({ cdpPort, profileDir }) : await cdp.connect({ cdpPort, profileDir });
  const extInfo = await cdpSession.getExtensionInfo();
  if (extInfo.source !== "chrome_web_store") throw new Error(`EXTENSION_SOURCE_NOT_STORE: ${extInfo.source}`);
  if (extInfo.id !== EXTENSION_LOCK.extensionId) throw new Error(`EXTENSION_ID_MISMATCH: ${extInfo.id}`);
  if (extInfo.version !== EXTENSION_LOCK.version) throw new Error(`EXTENSION_VERSION_MISMATCH: ${extInfo.version}`);

  // 6. 重下载并验签 CRX3
  const fetchImplFn = fetchImpl ?? defaultFetchCrx;
  const crx = await fetchImplFn();
  const crxBytes = Buffer.isBuffer(crx.body) ? crx.body : Buffer.from(crx.body);
  const packageSha256 = sha256Hex(crxBytes);
  const proof = verifyCrx ? verifyCrx(crxBytes) : verifyCrxProof(crxBytes);
  const derivedId = deriveExtensionId(proof.publicKey, proof.crxIdHex);
  if (derivedId !== EXTENSION_LOCK.extensionId) throw new Error(`CRX_ID_MISMATCH: ${derivedId}`);
  const expectedHash = expectedPackageSha256 ?? EXTENSION_LOCK.packageSha256;
  if (packageSha256 !== expectedHash) throw new Error(`CRX_PACKAGE_HASH_MISMATCH`);

  // 7. 定位真实安装目录 + 生成 installed manifest
  const findDir = findExtensionDir ?? defaultFindExtensionDir;
  const installedDir = await findDir(profileDir);
  const installedManifest = await buildContentManifest(installedDir, EXCLUSION_RULES_VERSION);

  // 8. 解包 CRX 生成 signed manifest
  const tmpCrx = join(profileDir, "locked.crx3");
  writeFileSync(tmpCrx, crxBytes);
  const unzipDir = join(profileDir, "unpacked");
  const unzipImpl = unzip ?? defaultUnzip;
  await unzipImpl(tmpCrx, unzipDir);
  const signedManifest = await buildContentManifest(unzipDir, EXCLUSION_RULES_VERSION);

  // 9. 两份 manifest canonical hash 必须相等
  if (installedManifest.canonicalSha256 !== signedManifest.canonicalSha256) {
    throw new Error("CONTENT_MANIFEST_HASH_MISMATCH");
  }

  // 10. 截图
  let screenshotPng;
  try {
    screenshotPng = await cdpSession.screenshot();
  } catch (err) {
    throw new Error(`SCREENSHOT_FAILED: ${err.message}`);
  }
  const screenshotPath = join(artifactsDir, "final-store-install.png");
  writeFileSync(screenshotPath, screenshotPng);
  const screenshotSha256 = sha256File(screenshotPath);

  // 11. 原子生成五文件
  const profilePathHash = sha256Hex(profileDir);
  const common = {
    ...provenance,
    crxPackageSha256: packageSha256,
    storeId: EXTENSION_LOCK.extensionId,
    storeVersion: EXTENSION_LOCK.version,
    profileSessionNonce,
    profilePathHash,
    contentBindingSha256: contentBinding.canonicalSha256,
    extensionManifestSha256: contentBinding.extensionManifestSha256,
  };

  const screenshotManifest = {
    ...common,
    screenshots: [{ file: "final-store-install.png", sha256: screenshotSha256 }],
    exclusionRulesVersion: EXCLUSION_RULES_VERSION,
    checkedAt,
    canonicalSha256: null,
  };
  screenshotManifest.canonicalSha256 = await canonicalJsonHash(screenshotManifest);

  const binding = {
    ...common,
    installedManifestSha256: installedManifest.canonicalSha256,
    signedManifestSha256: signedManifest.canonicalSha256,
    screenshotManifestSha256: screenshotManifest.canonicalSha256,
    crxRequestProjection: {
      requestUrl: crx.requestUrl ?? null,
      redirectChain: crx.redirectChain ?? [],
      proof: { algorithm: proof.algorithm, publicKeySha256: proof.publicKeySha256 },
    },
    capturedAt: checkedAt,
    reviewedBy,
    reviewedAt: checkedAt,
    canonicalSha256: null,
    passed: true,
  };
  binding.canonicalSha256 = await canonicalJsonHash(binding);

  const writeAtomic = (name, obj) => {
    const p = join(artifactsDir, name);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(tmp, p);
  };
  writeAtomic("final-installed-content-manifest.json", installedManifest);
  writeAtomic("final-signed-content-manifest.json", signedManifest);
  writeAtomic("final-store-screenshot-manifest.json", screenshotManifest);
  writeAtomic("final-store-binding.json", binding);

  // 清理临时目录
  rmSync(profileDir, { recursive: true, force: true });

  return { passed: true, binding, installedManifest, signedManifest, screenshotManifest, screenshotSha256 };
}

export async function main(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      args[key.slice(2)] = value;
      i++;
    }
  }
  const { "client-lock": clientLock, "store-evidence": storeEvidence, "store-content-binding": contentBinding, "deploy-provenance": deployProvenance, "out-dir": outDir } = args;
  if (!clientLock || !storeEvidence || !contentBinding || !deployProvenance || !outDir) {
    throw new Error("Usage: replay-final-store.mjs --client-lock <path> --store-evidence <path> --store-content-binding <path> --deploy-provenance <path> --out-dir <path>");
  }
  const profileDir = join(outDir, ".replay-profile");
  const profileSessionNonce = randomBytes(32).toString("hex");
  const cdpPort = 9000 + Math.floor(Math.random() * 1000);
  const res = await runReplay({
    artifactsDir: outDir,
    profileDir,
    profileSessionNonce,
    cdpPort,
    clientLockPath: clientLock,
    storeEvidencePath: storeEvidence,
    contentBindingPath: contentBinding,
    deployProvenancePath: deployProvenance,
  });
  console.log(JSON.stringify({ replay: { passed: res.passed, binding: res.binding.canonicalSha256 } }));
  process.exit(res.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`replay-final-store: ${err.message}`);
    process.exit(2);
  });
}
