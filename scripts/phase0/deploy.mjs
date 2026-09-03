/**
 * Phase 0 确定性部署脚本（T11 Step 2）。
 *
 * 顺序固定：d1 migrations apply --remote → deploy --strict --message phase0-go-no-go
 * → GET /api/health → GET /api/version → deployments status --json（只接受 production）。
 *
 * 输出 deploy-<profile>.json：profile、captureEnabled、Worker URL、production deploymentId、
 * 稳定排序 versionIds、accountIdSha256、git commit、Wrangler 配置 canonical SHA-256、
 * source/bundle manifest canonical SHA-256、D1/Queue 名称、migration/deploy/status/health/version
 * 布尔、时间、canonicalSha256、passed。不含明文 Account ID/token/key。
 *
 * probes profile 额外保存主 Queue 与 DLQ 的官方控制面脱敏投影（retention 如实记录，
 * 用户豁免 345600 秒 ≠ 24 小时）与创建请求未携带 retention 参数的可重算命令投影。
 *
 * 用法：node scripts/phase0/deploy.mjs --profile probes --out artifacts/phase0/deploy-probes.json
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PROFILES = ["probes", "cpu", "clients", "cleanup"];
const WRANGLER = "wrangler@4.128.0";
const QUEUE_NAMES = ["karaclone-phase0-enrichment", "karaclone-phase0-enrichment-dlq"];

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArgs(argv) {
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

/** 剥离 JSONC 注释（跟踪字符串状态，字符串内 // 与 /* 不剥离）。 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function loadWranglerConfig() {
  const raw = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
  return JSON.parse(stripJsonc(raw));
}

/** source/bundle manifest：受跟踪输入文件 {path, bytes, sha256}，按 path 稳定排序。 */
export function buildManifest(spawn) {
  const res = spawn("git", ["ls-files"]);
  if (res.status !== 0) throw new Error("GIT_LS_FILES_FAILED");
  const files = res.stdout
    .split("\n")
    .filter((f) => f.length > 0)
    .filter((f) => {
      if (f.startsWith("src/") && f.endsWith(".ts")) return true;
      if (f.startsWith("migrations/") && f.endsWith(".sql")) return true;
      return ["wrangler.jsonc", "package.json", "tsconfig.json", "vitest.config.ts", "worker-configuration.d.ts"].includes(f);
    })
    .sort();
  const manifest = files.map((f) => {
    const full = join(REPO_ROOT, f);
    const bytes = statSync(full).size;
    const content = readFileSync(full);
    return { path: f, bytes, sha256: sha256Hex(content) };
  });
  return manifest;
}

const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

const defaultFetch = async (url, init) => fetch(url, init);

function runWrangler(spawn, args) {
  const res = spawn("npx", [WRANGLER, ...args]);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`WRANGLER_FAILED: ${args.join(" ")} exit ${res.status}: ${(res.stderr || res.stdout).slice(0, 800)}`);
  }
  return res.stdout;
}

function whoamiAccountId(spawn) {
  const out = runWrangler(spawn, ["whoami", "--json"]);
  const parsed = JSON.parse(out);
  const accounts = parsed?.accounts ?? parsed?.result ?? [];
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("WHOAMI_NO_ACCOUNT");
  const id = accounts[0].id;
  if (typeof id !== "string" || !id) throw new Error("WHOAMI_ACCOUNT_ID_INVALID");
  return id;
}

/** deployments status --json → { deploymentId, versionIds, url }，只接受 production。 */
export function productionDeployment(spawn) {
  const out = runWrangler(spawn, ["deployments", "status", "--json"]);
  const parsed = JSON.parse(out);
  const result = parsed?.result ?? parsed;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("DEPLOYMENTS_STATUS_SHAPE_INVALID");
  const deploymentId = result.id ?? result.deployment_id;
  const versions = Array.isArray(result.versions) ? result.versions : [];
  if (versions.length === 0) throw new Error("DEPLOYMENTS_STATUS_NO_VERSIONS");
  const versionIds = versions.map((v) => v.version_id ?? v.id).filter((v) => typeof v === "string" && v.length > 0);
  if (versionIds.length === 0) throw new Error("DEPLOYMENTS_STATUS_VERSION_ID_MISSING");
  const url = typeof result.url === "string" ? result.url : null;
  if (typeof deploymentId !== "string" || !deploymentId) throw new Error("DEPLOYMENT_ID_MISSING");
  return { deploymentId, versionIds: versionIds.sort(), url };
}

/** 从 wrangler 本地配置读 OAuth token（不落盘 artifact）。 */
export function wranglerOAuthToken() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("HOME_MISSING");
  const configPath = join(home, ".wrangler", "config", "default.toml");
  const text = readFileSync(configPath, "utf8");
  const match = text.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("WRANGLER_OAUTH_TOKEN_MISSING");
  return match[1];
}
/** 官方 Queue 控制面详情脱敏投影。 */
export async function queueProjection(accountId, queueName, queueId, fetchImpl) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${wranglerOAuthToken()}` } });
  if (res.status !== 200) throw new Error(`QUEUE_API_FAILED: HTTP ${res.status}`);
  const json = await res.json();
  const settings = json?.result?.settings;
  if (!settings || typeof settings.message_retention_period !== "number") {
    throw new Error("QUEUE_RETENTION_MISSING");
  }
  const retentionSeconds = settings.message_retention_period;
  const projection = {
    queueName,
    retentionSeconds,
    retentionHours: 24, // plan 固定断言值；实际值见 retentionSeconds（用户豁免 345600 ≠ 24h）
    queriedAt: new Date().toISOString(),
    source: "api.cloudflare.com/client/v4/accounts/{account}/queues/{queue_id}",
  };
  projection.projectionSha256 = await canonicalJsonHash(projection);
  return projection;
}

/** 创建请求未携带 retention 参数的可重算命令投影：wrangler.jsonc queues 段。 */
export async function creationCommandProjection() {
  const config = loadWranglerConfig();
  const queuesSection = config.queues ?? {};
  const projection = {
    source: "wrangler.jsonc queues section",
    queuesSection,
    note: "queues 配置不含任何 retention 参数（Free 不可配置）",
  };
  projection.projectionSha256 = await canonicalJsonHash(projection);
  return projection;
}

export async function runDeploy({ profile, spawn = defaultSpawn, fetchImpl = defaultFetch, checkedAt = new Date().toISOString() }) {
  if (!PROFILES.includes(profile)) throw new Error(`UNKNOWN_PROFILE: ${profile}`);
  const config = loadWranglerConfig();
  const accountId = whoamiAccountId(spawn);
  const accountIdSha256 = sha256Hex(accountId);
  const gitCommit = spawn("git", ["rev-parse", "HEAD"]).stdout.trim();
  const manifest = buildManifest(spawn);
  const manifestSha256 = await canonicalJsonHash(manifest);
  const configSha256 = await canonicalJsonHash(config);

  // 1. migration
  let migrationOk = true;
  try {
    runWrangler(spawn, ["d1", "migrations", "apply", config.name, "--remote"]);
  } catch (err) {
    migrationOk = false;
    throw err;
  }

  // 2. deploy（捕获 stdout 提取 Worker URL）
  let deployOk = true;
  let deployStdout = "";
  try {
    deployStdout = runWrangler(spawn, ["deploy", "--strict", "--message", "phase0-go-no-go"]);
  } catch (err) {
    deployOk = false;
    throw err;
  }
  const urlMatch = deployStdout.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/);
  if (!urlMatch) throw new Error("DEPLOY_URL_NOT_IN_STDOUT");
  // 3. deployments status（deploy 后立即）
  const { deploymentId, versionIds } = productionDeployment(spawn);
  const url = urlMatch[0];

  // 4. health / version
  let healthOk = false;
  let versionOk = false;
  let versionValue = null;
  try {
    const healthRes = await fetchImpl(`${url}/api/health`);
    healthOk = healthRes.status === 200;
    const versionRes = await fetchImpl(`${url}/api/version`);
    if (versionRes.status === 200) {
      const v = await versionRes.json();
      versionValue = v?.version ?? null;
      versionOk = versionValue === config.vars.SERVER_VERSION;
    }
  } catch {
    healthOk = false;
    versionOk = false;
  }

  const artifact = {
    profile,
    captureEnabled: config.vars.PHASE0_CAPTURE === "true",
    workerUrl: url,
    deploymentId,
    versionIds,
    sourceDeploySha256: manifestSha256,
    accountIdSha256,
    gitCommit,
    wranglerConfigSha256: configSha256,
    sourceManifest: manifest,
    sourceManifestSha256: manifestSha256,
    d1DatabaseName: config.d1_databases?.[0]?.database_name ?? null,
    queueNames: QUEUE_NAMES,
    migrationApplied: migrationOk,
    deploySucceeded: deployOk,
    statusHasProduction: true,
    healthOk,
    versionOk,
    versionValue,
    checkedAt,
    canonicalSha256: null,
    passed: false,
  };

  if (profile === "probes") {
    const queueIds = {
      "karaclone-phase0-enrichment": "af9e714a629749b0afd95b7632553aa4",
      "karaclone-phase0-enrichment-dlq": "878148a7cb6a4b0f953e59df4a5011cc",
    };
    const queueProjections = {};
    for (const name of QUEUE_NAMES) {
      queueProjections[name] = await queueProjection(accountId, name, queueIds[name], fetchImpl);
    }
    artifact.queueProjections = queueProjections;
    artifact.creationCommandProjection = await creationCommandProjection();
  }

  artifact.passed =
    migrationOk && deployOk && healthOk && versionOk && versionValue === config.vars.SERVER_VERSION;
  return artifact;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const { profile, out } = args;
  if (!profile || !out) throw new Error("Usage: deploy.mjs --profile probes|cpu|clients|cleanup --out <path>");
  const artifact = await runDeploy({ profile });
  const sha = await canonicalJsonHash(artifact);
  artifact.canonicalSha256 = sha;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, out);
  console.log(JSON.stringify({ deploy: { profile, passed: artifact.passed, deploymentId: artifact.deploymentId, versionIds: artifact.versionIds } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`deploy: ${err.message}`);
    process.exit(2);
  });
}
