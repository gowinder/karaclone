/**
 * Phase 0 远端 smoke（T11 Step 3）。
 *
 * 从权限为 0600 的 .dev.vars 安全加载 PHASE0_API_KEY；启动与结束各执行一次
 * deployments status --json 确认 production versionIds 与 deploy artifact 一致。
 * 检查：/api/health、/api/version、tRPC whoami（Bearer key）、
 * 无 key 401、错误 key 401。
 *
 * 用法：node scripts/phase0/smoke.mjs --deploy artifacts/phase0/deploy-probes.json
 *       --bootstrap artifacts/phase0/bootstrap.json --env-file .dev.vars --out artifacts/phase0/smoke.json
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";
import { productionDeployment } from "./deploy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const WRANGLER = "wrangler@4.128.0";

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

const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

function runWrangler(spawn, args) {
  const res = spawn("npx", [WRANGLER, ...args]);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`WRANGLER_FAILED: ${args.join(" ")} exit ${res.status}: ${(res.stderr || res.stdout).slice(0, 800)}`);
  }
  return res.stdout;
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

export async function runSmoke({ deployPath, bootstrapPath, envFilePath, spawn = defaultSpawn, checkedAt = new Date().toISOString() }) {
  const deployArtifact = JSON.parse(readFileSync(deployPath, "utf8"));
  const bootstrapArtifact = JSON.parse(readFileSync(bootstrapPath, "utf8"));
  if (deployArtifact.profile !== "probes" || deployArtifact.passed !== true) throw new Error("DEPLOY_NOT_PASSED_PROBES");
  if (bootstrapArtifact.profile !== "probes" || bootstrapArtifact.passed !== true) throw new Error("BOOTSTRAP_NOT_PASSED");
  if (bootstrapArtifact.deploymentId !== deployArtifact.deploymentId) throw new Error("BOOTSTRAP_DEPLOYMENT_MISMATCH");
  if (JSON.stringify(bootstrapArtifact.versionIds) !== JSON.stringify(deployArtifact.versionIds)) throw new Error("BOOTSTRAP_VERSION_MISMATCH");

  const apiKey = loadApiKey(envFilePath);
  const workerUrl = deployArtifact.workerUrl;

  // 启动时确认 production 一致
  const start = productionDeployment(spawn);
  if (start.deploymentId !== deployArtifact.deploymentId) throw new Error("DEPLOYMENT_DRIFT_START");
  if (JSON.stringify(start.versionIds) !== JSON.stringify(deployArtifact.versionIds)) throw new Error("VERSION_DRIFT_START");

  const checks = {};
  const healthRes = await fetch(`${workerUrl}/api/health`);
  checks.healthOk = healthRes.status === 200;

  const versionRes = await fetch(`${workerUrl}/api/version`);
  let versionValue = null;
  if (versionRes.status === 200) {
    const v = await versionRes.json();
    versionValue = v?.version ?? null;
  }
  checks.versionOk = versionValue === deployArtifact.versionValue;

  const whoamiRes = await fetch(`${workerUrl}/api/trpc/users.whoami`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  checks.whoamiOk = whoamiRes.status === 200;

  const noKeyRes = await fetch(`${workerUrl}/api/trpc/users.whoami`);
  checks.noKeyRejected = noKeyRes.status === 401;

  const badKeyRes = await fetch(`${workerUrl}/api/trpc/users.whoami`, {
    headers: { Authorization: "Bearer ak2_00000000000000000000_00000000000000000000000000000000" },
  });
  checks.badKeyRejected = badKeyRes.status === 401;

  // 结束时再确认一次
  const end = productionDeployment(spawn);
  if (end.deploymentId !== deployArtifact.deploymentId) throw new Error("DEPLOYMENT_DRIFT_END");
  if (JSON.stringify(end.versionIds) !== JSON.stringify(deployArtifact.versionIds)) throw new Error("VERSION_DRIFT_END");

  const artifact = {
    deploymentId: deployArtifact.deploymentId,
    versionIds: deployArtifact.versionIds,
    profile: "probes",
    workerUrl,
    sourceDeploySha256: deployArtifact.sourceManifestSha256,
    ...checks,
    versionValue,
    checkedAt,
    canonicalSha256: null,
    passed: false,
  };
  artifact.passed = Object.values(checks).every(Boolean);
  return artifact;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const { deploy, bootstrap, "env-file": envFilePath, out } = args;
  if (!deploy || !bootstrap || !envFilePath || !out) {
    throw new Error("Usage: smoke.mjs --deploy <path> --bootstrap <path> --env-file <path> --out <path>");
  }
  const artifact = await runSmoke({ deployPath: deploy, bootstrapPath: bootstrap, envFilePath });
  const sha = await canonicalJsonHash(artifact);
  artifact.canonicalSha256 = sha;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, out);
  console.log(JSON.stringify({ smoke: { passed: artifact.passed, checks: Object.fromEntries(Object.entries(artifact).filter(([k]) => k.endsWith("Ok") || k.endsWith("Rejected"))) } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`smoke: ${err.message}`);
    process.exit(2);
  });
}
