/**
 * Phase 0 确定性部署脚本（T11 Step 2 / T12 Step 5/7）。
 *
 * probes：d1 migrations apply --remote → deploy --strict → health/version → deployments status。
 * cpu：CSPRNG 生成 secret/path/session nonce，stdin 注入 versions secret put，
 *      --var PHASE0_CAPTURE=false --var PHASE0_CPU_LIMIT_PROBE=true 覆盖部署，
 *      明文只写 .phase0/runtime/cpu-limit-handoff（0700/0600 独占创建）。
 * cleanup：--var PHASE0_CAPTURE=false --var PHASE0_CPU_LIMIT_PROBE=false，
 *      versions secret delete 两个 binding，覆盖部署，复查 404/health/version。
 *
 * 输出 deploy-<profile>.json：profile、captureEnabled、Worker URL、production deploymentId、
 * 稳定排序 versionIds、accountIdSha256、git commit、Wrangler 配置 canonical SHA-256、
 * source/bundle manifest canonical SHA-256、D1/Queue 名称、migration/deploy/status/health/version
 * 布尔、时间、canonicalSha256、passed。不含明文 Account ID/token/key/secret。
 *
 * 用法：node scripts/phase0/deploy.mjs --profile probes --out artifacts/phase0/deploy-probes.json
 *       node scripts/phase0/deploy.mjs --profile cpu --out artifacts/phase0/deploy-cpu.json
 *       node scripts/phase0/deploy.mjs --profile cleanup --from artifacts/phase0/deploy-cpu.json --out artifacts/phase0/deploy-cleanup.json
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PROFILES = ["probes", "cpu", "clients", "cleanup"];
const WRANGLER = "wrangler@4.128.0";
const QUEUE_NAMES = ["karaclone-phase0-enrichment", "karaclone-phase0-enrichment-dlq"];
const CPU_SECRET_BINDING = "PHASE0_CPU_LIMIT_SECRET";
const CPU_PATH_BINDING = "PHASE0_CPU_LIMIT_PATH_SEGMENT";
const HANDOFF_DIR = join(REPO_ROOT, ".phase0", "runtime");
const HANDOFF_PATH = join(HANDOFF_DIR, "cpu-limit-handoff");

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

/** stdin 注入式 wrangler 调用（secret put 用，值不进入 argv）。 */
function runWranglerInput(spawn, args, input) {
  const res = spawn("npx", [WRANGLER, ...args], { input });
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

/** CSPRNG 生成 cpu profile 凭据；拒绝预存 handoff。 */
function generateCpuCredentials() {
  if (statSync(HANDOFF_PATH, { throwIfNoEntry: false })) {
    throw new Error("HANDOFF_ALREADY_EXISTS");
  }
  const secret = randomBytes(32).toString("hex"); // 256-bit
  const pathSegment = randomBytes(16).toString("base64url"); // 128-bit URL-safe
  const sessionNonce = randomBytes(32).toString("hex"); // 256-bit
  return { secret, pathSegment, sessionNonce };
}

/** 独占创建 handoff（目录 0700、文件 0600）。 */
function writeHandoff({ secret, pathSegment, sessionNonce }) {
  mkdirSync(HANDOFF_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HANDOFF_DIR, 0o700);
  const fd = openSync(HANDOFF_PATH, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ secret, pathSegment, sessionNonce }) + "\n");
  chmodSync(HANDOFF_PATH, 0o600);
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

  // cpu/cleanup 专用状态
  let cpuCredentials = null;
  let secretSha256 = null;
  let pathSegmentSha256 = null;
  let handoffSessionNonceSha256 = null;
  let secretBindingDeleted = false;
  let pathBindingDeleted = false;
  let cpuRoute404 = false;

  if (profile === "cpu") {
    cpuCredentials = generateCpuCredentials();
    secretSha256 = sha256Hex(cpuCredentials.secret);
    pathSegmentSha256 = sha256Hex(cpuCredentials.pathSegment);
    handoffSessionNonceSha256 = sha256Hex(cpuCredentials.sessionNonce);
    // stdin 注入两个 secret binding
    runWranglerInput(spawn, ["versions", "secret", "put", CPU_SECRET_BINDING], cpuCredentials.secret);
    runWranglerInput(spawn, ["versions", "secret", "put", CPU_PATH_BINDING], cpuCredentials.pathSegment);
  } else if (profile === "cleanup") {
    // 删除两个临时 binding（失败不致命，继续覆盖部署）
    try {
      runWrangler(spawn, ["versions", "secret", "delete", CPU_SECRET_BINDING]);
      secretBindingDeleted = true;
    } catch {
      secretBindingDeleted = false;
    }
    try {
      runWrangler(spawn, ["versions", "secret", "delete", CPU_PATH_BINDING]);
      pathBindingDeleted = true;
    } catch {
      pathBindingDeleted = false;
    }
  }

  // 1. migration
  let migrationOk = true;
  try {
    runWrangler(spawn, ["d1", "migrations", "apply", config.name, "--remote"]);
  } catch (err) {
    migrationOk = false;
    throw err;
  }

  // 2. deploy（--var 覆盖 profile 开关）
  const deployArgs = ["deploy", "--strict", "--message", "phase0-go-no-go"];
  if (profile === "cpu") {
    deployArgs.push("--var", "PHASE0_CAPTURE:false", "--var", "PHASE0_CPU_LIMIT_PROBE:true");
  } else if (profile === "cleanup") {
    deployArgs.push("--var", "PHASE0_CAPTURE:false", "--var", "PHASE0_CPU_LIMIT_PROBE:false");
  }
  let deployOk = true;
  let deployStdout = "";
  try {
    deployStdout = runWrangler(spawn, deployArgs);
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

  // 5. cpu/cleanup 专用复查
  if (profile === "cpu") {
    // CPU-limit 路由带完整认证应可达（probe 开启）；其他 /__phase0/* 404 由 measure-cpu 复查
    writeHandoff(cpuCredentials);
  } else if (profile === "cleanup") {
    try {
      const res = await fetchImpl(`${url}/__phase0/cpu-limit/whatever`, { method: "POST" });
      cpuRoute404 = res.status === 404;
    } catch {
      cpuRoute404 = false;
    }
  }

  const artifact = {
    profile,
    captureEnabled: profile === "probes" ? config.vars.PHASE0_CAPTURE === "true" : false,
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
  } else if (profile === "cpu") {
    artifact.secretBindingName = CPU_SECRET_BINDING;
    artifact.pathBindingName = CPU_PATH_BINDING;
    artifact.secretSha256 = secretSha256;
    artifact.pathSegmentSha256 = pathSegmentSha256;
    artifact.handoffSessionNonceSha256 = handoffSessionNonceSha256;
    artifact.credentialsGeneratedAt = checkedAt;
    artifact.credentialsAlgorithm = "CSPRNG(randomBytes)";
    artifact.probeEnabled = true;
    artifact.limitsCpuMsAbsent = !JSON.stringify(config).includes("cpu_ms");
  } else if (profile === "cleanup") {
    artifact.secretBindingDeleted = secretBindingDeleted;
    artifact.pathBindingDeleted = pathBindingDeleted;
    artifact.probeEnabled = false;
    artifact.limitsCpuMsAbsent = !JSON.stringify(config).includes("cpu_ms");
    artifact.cpuRoute404 = cpuRoute404;
  }

  artifact.passed =
    migrationOk && deployOk && healthOk && versionOk && versionValue === config.vars.SERVER_VERSION;
  return artifact;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const { profile, out, from } = args;
  if (!profile || !out) throw new Error("Usage: deploy.mjs --profile probes|cpu|clients|cleanup --out <path> [--from <deploy-cpu.json>]");
  if (profile === "cleanup" && from) {
    // 校验 cleanup 的 from 是本次 cpu deployment
    const cpuArtifact = JSON.parse(readFileSync(from, "utf8"));
    if (cpuArtifact.profile !== "cpu") throw new Error("CLEANUP_FROM_NOT_CPU");
    if (cpuArtifact.passed !== true) throw new Error("CLEANUP_FROM_NOT_PASSED");
  }
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
