/**
 * Phase 0 远端 runner 公共模块：DeploymentProvenance 校验、production 漂移检查、
 * 原子 JSON 写入、canonical hash 收尾。所有 runner 共用，保证五字段直接展开。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
export const WRANGLER = "wrangler@4.128.0";

export const PROVENANCE_KEYS = ["deploymentId", "versionIds", "profile", "workerUrl", "sourceDeploySha256"];

export function parseArgs(argv) {
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
  return args;
}

export const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

export function runWrangler(spawn, args) {
  const res = spawn("npx", [WRANGLER, ...args]);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`WRANGLER_FAILED: ${args.join(" ")} exit ${res.status}: ${(res.stderr || res.stdout).slice(0, 800)}`);
  }
  return res.stdout;
}

export function productionDeployment(spawn) {
  // wrangler 网络瞬时失败（fetch failed）最多重试 2 次、间隔 5s
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = runWrangler(spawn, ["deployments", "status", "--json"]);
      return parseDeploymentsStatus(out);
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        spawnSync("sleep", ["5"]);
      }
    }
  }
  throw lastError;
}
function parseDeploymentsStatus(out) {
  const parsed = JSON.parse(out);
  const result = parsed?.result ?? parsed;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("DEPLOYMENTS_STATUS_SHAPE_INVALID");
  const deploymentId = result.id ?? result.deployment_id;
  const versions = Array.isArray(result.versions) ? result.versions : [];
  if (versions.length === 0) throw new Error("DEPLOYMENTS_STATUS_NO_VERSIONS");
  const versionIds = versions.map((v) => v.version_id ?? v.id).filter((v) => typeof v === "string" && v.length > 0);
  if (versionIds.length === 0) throw new Error("DEPLOYMENTS_STATUS_VERSION_ID_MISSING");
  if (typeof deploymentId !== "string" || !deploymentId) throw new Error("DEPLOYMENT_ID_MISSING");
  return { deploymentId, versionIds: versionIds.sort() };
}

/** 校验 deploy artifact：profile/passed/五字段齐全、versionIds 稳定排序。 */
export function loadDeployArtifact(path, expectedProfile) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  if (artifact.profile !== expectedProfile) throw new Error(`DEPLOY_PROFILE_MISMATCH: ${artifact.profile} != ${expectedProfile}`);
  if (artifact.passed !== true) throw new Error("DEPLOY_NOT_PASSED");
  for (const key of PROVENANCE_KEYS) {
    if (!(key in artifact)) throw new Error(`DEPLOY_MISSING_${key.toUpperCase()}`);
  }
  const sorted = [...artifact.versionIds].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(artifact.versionIds)) throw new Error("VERSION_IDS_NOT_SORTED");
  return artifact;
}

/** 启动与结束各检查一次 production 漂移。 */
export function assertNoDrift(spawn, deployArtifact, phase) {
  const prod = productionDeployment(spawn);
  if (prod.deploymentId !== deployArtifact.deploymentId) throw new Error(`DEPLOYMENT_DRIFT_${phase}`);
  if (JSON.stringify(prod.versionIds) !== JSON.stringify(deployArtifact.versionIds)) throw new Error(`VERSION_DRIFT_${phase}`);
  return prod;
}

/** 原子写入 JSON（tmp + rename），返回 canonicalSha256。 */
export async function atomicWriteJson(outPath, artifact) {
  const sha = await canonicalJsonHash(artifact);
  artifact.canonicalSha256 = sha;
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, outPath);
  return sha;
}

/** 从 .dev.vars 安全加载 PHASE0_API_KEY；文件必须 0600。 */
export function loadApiKey(envFilePath) {
  const mode = statSync(envFilePath).mode & 0o777;
  if (mode !== 0o600) throw new Error(`DEV_VARS_MODE_NOT_0600: ${mode.toString(8)}`);
  const text = readFileSync(envFilePath, "utf8");
  const match = text.match(/^PHASE0_API_KEY=(.+)$/m);
  if (!match) throw new Error("PHASE0_API_KEY_MISSING");
  const key = match[1].trim();
  if (!/^ak2_[0-9a-f]{20}_[0-9a-f]{64}$/.test(key)) throw new Error("PHASE0_API_KEY_FORMAT_INVALID");
  return key;
}
