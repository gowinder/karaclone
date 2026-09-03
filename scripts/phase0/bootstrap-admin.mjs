/**
 * Phase 0 一次性管理员与 API key bootstrap（T11 Step 1）。
 *
 * 生成 userId、keyId 与 32-byte secret（key 格式 ak2_<keyId>_<secret>），
 * 只把 SHA-256 hex 写入远端 D1；完整 secret 不进入 command/SQL/artifact/git。
 * 若远端已存在管理员则明确失败，不覆盖或复用未知 key。
 *
 * 用法：node scripts/phase0/bootstrap-admin.mjs --deploy artifacts/phase0/deploy-probes.json
 *       --write-dev-vars .dev.vars --out artifacts/phase0/bootstrap.json
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";
import { productionDeployment } from "./deploy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const WRANGLER = "wrangler@4.128.0";

const ID_RE = /^[a-z0-9_]{1,64}$/;
const KEY_ID_RE = /^[0-9a-f]{20}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

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

/**
 * 远端 D1 查询：SQL 经 --command 传入。SQL 只含 userId/keyId/secret 的 SHA-256 hash，
 * 不含完整 secret（secret 仅存在于内存，用于构造 .dev.vars）。
 */
function d1Query(spawn, sql) {
  const res = spawn("npx", [WRANGLER, "d1", "execute", "karaclone-phase0", "--remote", "--command", sql]);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`D1_EXECUTE_FAILED exit ${res.status}: ${(res.stderr || res.stdout).slice(0, 800)}`);
  }
  return res.stdout;
}

export async function runBootstrap({ deployPath, spawn = defaultSpawn, checkedAt = new Date().toISOString() }) {
  const deployArtifact = JSON.parse(readFileSync(deployPath, "utf8"));
  if (deployArtifact.profile !== "probes") throw new Error("DEPLOY_PROFILE_NOT_PROBES");
  if (deployArtifact.passed !== true) throw new Error("DEPLOY_NOT_PASSED");
  const { deploymentId, versionIds } = productionDeployment(spawn);
  if (deploymentId !== deployArtifact.deploymentId) throw new Error("DEPLOYMENT_DRIFT");
  if (JSON.stringify(versionIds) !== JSON.stringify(deployArtifact.versionIds)) throw new Error("VERSION_DRIFT");
  const url = deployArtifact.workerUrl;

  // 远端已存在管理员 → 明确失败
  const existing = d1Query(spawn, "SELECT COUNT(*) AS n FROM users WHERE name = 'phase0-admin'");
  if (!/n\s*:\s*0|"n":\s*0|\b0\b/.test(existing)) {
    throw new Error("ADMIN_ALREADY_EXISTS");
  }

  const userId = `user_${randomBytes(8).toString("hex")}`;
  const keyId = randomBytes(10).toString("hex");
  const secret = randomBytes(32).toString("hex");
  if (!ID_RE.test(userId)) throw new Error("USER_ID_WHITELIST_FAILED");
  if (!KEY_ID_RE.test(keyId)) throw new Error("KEY_ID_WHITELIST_FAILED");
  if (!SECRET_RE.test(secret)) throw new Error("SECRET_WHITELIST_FAILED");
  const secretHash = sha256Hex(secret);
  const now = Date.now();
  const apiKey = `ak2_${keyId}_${secret}`;

  const sql = [
    `INSERT INTO users (id, name, email, created_at) VALUES ('${userId}', 'phase0-admin', NULL, ${now});`,
    `INSERT INTO api_keys (id, user_id, key_id, secret_hash, name, scope, created_at) VALUES ('ak_row_${keyId}', '${userId}', '${keyId}', '${secretHash}', 'phase0-admin', 'fullaccess', ${now});`,
  ].join("\n");
  d1Query(spawn, sql);

  const artifact = {
    deploymentId,
    versionIds,
    profile: "probes",
    workerUrl: url,
    sourceDeploySha256: deployArtifact.sourceManifestSha256,
    userId,
    keyId,
    createdAt: new Date(now).toISOString(),
    checkedAt,
    canonicalSha256: null,
    passed: false,
  };
  artifact.passed = true;
  return { artifact, apiKey };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const { deploy, "write-dev-vars": devVarsPath, out } = args;
  if (!deploy || !devVarsPath || !out) {
    throw new Error("Usage: bootstrap-admin.mjs --deploy <path> --write-dev-vars <path> --out <path>");
  }
  const { artifact, apiKey } = await runBootstrap({ deployPath: deploy });

  // .dev.vars：0600，仅 PHASE0_API_KEY
  const devVars = `PHASE0_API_KEY=${apiKey}\n`;
  writeFileSync(devVarsPath, devVars, { mode: 0o600 });
  chmodSync(devVarsPath, 0o600);
  const mode = statSync(devVarsPath).mode & 0o777;
  artifact.devVarsMode = mode.toString(8);
  artifact.devVarsModeOk = mode === 0o600;

  const sha = await canonicalJsonHash(artifact);
  artifact.canonicalSha256 = sha;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, out);
  console.log(JSON.stringify({ bootstrap: { passed: artifact.passed, userId: artifact.userId, keyId: artifact.keyId } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`bootstrap-admin: ${err.message}`);
    process.exit(2);
  });
}
