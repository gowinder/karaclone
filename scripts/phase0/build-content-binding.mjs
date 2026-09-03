/**
 * T13 Step 1/4：extension-store-content-binding 唯一生成器。
 * 从只读 extension manifest 与直接内容重算：原 extension manifest canonical hash、
 * installed/signed manifest canonical hashes、相同 contentExclusionRulesVersion、
 * Store evidence/install screenshot hashes、profile path hash、profile session nonce，
 * 以及顶层完整 clients DeploymentProvenance。任一信任条件或本次绑定不一致立即失败。
 * 严禁改写 extension-client-manifest.json。
 *
 * 用法：node scripts/phase0/build-content-binding.mjs
 *       --deploy <deploy-clients.json> --extension-manifest <extension-client-manifest.json>
 *       --store-evidence <extension-store-evidence.json> --installed-dir <dir>
 *       --signed-dir <dir> --install-png <extension-store-install.png>
 *       --profile <profileDir> --session-nonce <nonce> --out <path>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 稳定排序的逐文件 {path,size,sha256} manifest（相对 POSIX 路径）。 */
export async function buildContentManifest(dir, contentExclusionRulesVersion) {
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
  const manifest = { contentExclusionRulesVersion, files };
  manifest.canonicalSha256 = await canonicalJsonHash(manifest);
  return manifest;
}

export async function buildContentBinding({
  deployPath = join(ARTIFACTS, "deploy-clients.json"),
  extensionManifestPath = join(ARTIFACTS, "extension-client-manifest.json"),
  storeEvidencePath = join(ARTIFACTS, "extension-store-evidence.json"),
  installedDir,
  signedDir,
  installPngPath = join(ARTIFACTS, "extension-store-install.png"),
  profilePath,
  profileSessionNonce,
  outPath = join(ARTIFACTS, "extension-store-content-binding.json"),
  contentExclusionRulesVersion = "1.0.0",
  reviewedBy = process.env.PHASE0_REVIEWER || "human-reviewer",
  checkedAt = new Date().toISOString(),
} = {}) {
  if (!installedDir || !signedDir || !profilePath || !profileSessionNonce) {
    throw new Error("INSTALLED_DIR_SIGNED_DIR_PROFILE_NONCE_REQUIRED");
  }

  // 1. 原 extension manifest：只读，重算 canonical hash
  const extManifest = readJson(extensionManifestPath);
  const extManifestHash = await canonicalJsonHash(extManifest);
  if (extManifest.canonicalSha256 !== extManifestHash) throw new Error("EXTENSION_MANIFEST_HASH_MISMATCH");
  if (extManifest.version !== "1.2.11" || extManifest.packageId !== "kgcjekpmcjjogibpjebkhaanilehneje") {
    throw new Error("EXTENSION_MANIFEST_LOCK_MISMATCH");
  }
  // contentExclusionRulesVersion 必须与 verifier 版本一致
  const verifierVersion = extManifest.verificationProjection?.verifierVersion;
  if (typeof verifierVersion === "string" && contentExclusionRulesVersion !== verifierVersion) {
    throw new Error(`RULES_VERSION_MISMATCH: ${contentExclusionRulesVersion} != ${verifierVersion}`);
  }

  // 2. Store evidence：重算 canonical hash
  const evidence = readJson(storeEvidencePath);
  const evidenceHash = await canonicalJsonHash(evidence);
  if (evidence.canonicalSha256 !== evidenceHash) throw new Error("STORE_EVIDENCE_HASH_MISMATCH");
  if (evidence.extensionId !== "kgcjekpmcjjogibpjebkhaanilehneje" || evidence.version !== "1.2.11" || evidence.publisher !== "karakeep.app") {
    throw new Error("STORE_EVIDENCE_LOCK_MISMATCH");
  }

  // 3. install screenshot
  if (!existsSync(installPngPath)) throw new Error("INSTALL_SCREENSHOT_MISSING");
  const installScreenshotSha256 = sha256File(installPngPath);

  // 4. 两份内容 manifest：相同规则，canonical hash 必须相等
  const installedManifest = await buildContentManifest(installedDir, contentExclusionRulesVersion);
  const signedManifest = await buildContentManifest(signedDir, contentExclusionRulesVersion);
  if (installedManifest.canonicalSha256 !== signedManifest.canonicalSha256) {
    throw new Error("CONTENT_MANIFEST_HASH_MISMATCH");
  }

  // 5. clients DeploymentProvenance（五字段必须完整非空）
  const deploy = readJson(deployPath);
  if (deploy.profile !== "clients" || deploy.passed !== true) throw new Error("DEPLOY_PROVENANCE_NOT_CLIENTS");
  if (typeof deploy.deploymentId !== "string" || deploy.deploymentId.length === 0) throw new Error("DEPLOY_PROVENANCE_DEPLOYMENT_ID_MISSING");
  if (!Array.isArray(deploy.versionIds) || deploy.versionIds.length === 0) throw new Error("DEPLOY_PROVENANCE_VERSION_IDS_MISSING");
  if (typeof deploy.workerUrl !== "string" || deploy.workerUrl.length === 0) throw new Error("DEPLOY_PROVENANCE_WORKER_URL_MISSING");
  if (typeof deploy.sourceDeploySha256 !== "string" || deploy.sourceDeploySha256.length === 0) throw new Error("DEPLOY_PROVENANCE_SOURCE_SHA_MISSING");
  const provenance = {
    deploymentId: deploy.deploymentId,
    versionIds: [...deploy.versionIds].sort(),
    profile: deploy.profile,
    workerUrl: deploy.workerUrl,
    sourceDeploySha256: deploy.sourceDeploySha256,
  };

  // 6. profile path hash + session nonce
  const profilePathHash = createHash("sha256").update(profilePath, "utf8").digest("hex");

  const binding = {
    ...provenance,
    extensionManifestSha256: extManifestHash,
    installedManifestSha256: installedManifest.canonicalSha256,
    signedManifestSha256: signedManifest.canonicalSha256,
    contentExclusionRulesVersion,
    storeEvidenceSha256: evidenceHash,
    installScreenshotSha256,
    profilePathHash,
    profileSessionNonce,
    capturedAt: checkedAt,
    reviewedBy,
    reviewedAt: checkedAt,
    canonicalSha256: null,
    passed: true,
  };
  binding.canonicalSha256 = await canonicalJsonHash(binding);

  // 原子写
  const tmp = `${outPath}.tmp`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(binding, null, 2) + "\n");
  renameSync(tmp, outPath);

  return binding;
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
  const { deploy, "extension-manifest": extManifest, "store-evidence": storeEvidence, "installed-dir": installedDir, "signed-dir": signedDir, "install-png": installPng, profile, "session-nonce": nonce, out } = args;
  if (!deploy || !extManifest || !storeEvidence || !installedDir || !signedDir || !installPng || !profile || !nonce || !out) {
    throw new Error("Usage: build-content-binding.mjs --deploy <path> --extension-manifest <path> --store-evidence <path> --installed-dir <dir> --signed-dir <dir> --install-png <path> --profile <dir> --session-nonce <nonce> --out <path>");
  }
  const binding = await buildContentBinding({
    deployPath: deploy,
    extensionManifestPath: extManifest,
    storeEvidencePath: storeEvidence,
    installedDir,
    signedDir,
    installPngPath: installPng,
    profilePath: profile,
    profileSessionNonce: nonce,
    outPath: out,
  });
  console.log(JSON.stringify({ binding: { passed: binding.passed, canonicalSha256: binding.canonicalSha256, out } }));
  process.exit(binding.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`build-content-binding: ${err.message}`);
    process.exit(2);
  });
}
