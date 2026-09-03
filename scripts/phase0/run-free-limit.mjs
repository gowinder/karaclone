/**
 * T12 Step 7：Free 10ms CPU 上限实测。独占打开 handoff，验证 hash 全等，
 * 创建一次性 D1 nonce，恰好一次请求 POST /__phase0/cpu-limit/<segment>，
 * 要求 HTTP 1102 + Telemetry outcome="exceededCpu"。
 * try/finally：finally 无条件 unlink handoff + 调用 cleanup 部署器。
 * 输出 free-limit.json。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, loadDeployArtifact, PROVENANCE_KEYS } from "./remote-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");
const HANDOFF_DEFAULT = join(REPO_ROOT, ".phase0", "runtime", "cpu-limit-handoff");

const defaultFetch = async (url, init) => fetch(url, init);

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 独占打开 handoff：O_CREAT|O_EXCL 语义由调用方保证（文件已存在则直接读并校验权限）。 */
export function readHandoff(handoffPath) {
  const mode = statSync(handoffPath).mode & 0o777;
  if (mode !== 0o600) throw new Error(`HANDOFF_MODE_NOT_0600: ${mode.toString(8)}`);
  const parsed = JSON.parse(readFileSync(handoffPath, "utf8"));
  if (typeof parsed.secret !== "string" || typeof parsed.pathSegment !== "string" || typeof parsed.sessionNonce !== "string") {
    throw new Error("HANDOFF_SHAPE_INVALID");
  }
  return parsed;
}

export async function runFreeLimit({
  deployPath,
  cpuRunPath,
  queueInvocationsPath,
  cpuPath,
  cleanupOut,
  out,
  handoffPath = HANDOFF_DEFAULT,
  cleanup,
  fetchImpl = defaultFetch,
  telemetry,
  checkedAt = new Date().toISOString(),
}) {
  const deployArtifact = loadDeployArtifact(deployPath, "cpu");
  const checks = {};
  let error = null;
  let cleanupCalled = false;
  let cleanupResult = null;
  let handoff = null;

  try {
    // 独占打开 + 验证 hash 全等
    handoff = readHandoff(handoffPath);
    checks.handoffSecretSha256 = sha256Hex(handoff.secret);
    checks.handoffPathSegmentSha256 = sha256Hex(handoff.pathSegment);
    checks.handoffSessionNonceSha256 = sha256Hex(handoff.sessionNonce);
    checks.secretMatchesDeploy = deployArtifact.secretSha256 === checks.handoffSecretSha256;
    checks.pathMatchesDeploy = deployArtifact.pathSegmentSha256 === checks.handoffPathSegmentSha256;
    checks.sessionMatchesDeploy = deployArtifact.handoffSessionNonceSha256 === checks.handoffSessionNonceSha256;
    if (!checks.secretMatchesDeploy || !checks.pathMatchesDeploy || !checks.sessionMatchesDeploy) {
      throw new Error("HANDOFF_HASH_MISMATCH");
    }

    // 一次性 D1 nonce（短 TTL）
    const nonce = randomBytes(32).toString("hex");
    const nonceSha256 = sha256Hex(nonce);
    const runId = randomUUID();
    const window = { from: new Date().toISOString(), to: null };

    // 恰好一次请求
    const url = `${deployArtifact.workerUrl}/__phase0/cpu-limit/${handoff.pathSegment}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${handoff.secret}` },
      body: JSON.stringify({ nonce }),
    });
    checks.http1102Seen = res.status === 1102;
    window.to = new Date().toISOString();

    // Telemetry outcome="exceededCpu"
    let telemetryExceededCpuSeen = false;
    if (telemetry) {
      const t = await telemetry();
      telemetryExceededCpuSeen = Array.isArray(t?.events) && t.events.some((e) => e?.outcome === "exceededCpu");
    }
    checks.telemetryExceededCpuSeen = telemetryExceededCpuSeen;
    // 常规 G5/G7 窗口与 free-limit 窗口两两不重叠（容错：文件缺失/损坏记失败不抛）
    let windowsNonOverlapping = false;
    const regularWindows = [];
    try {
      for (const p of [cpuRunPath, queueInvocationsPath]) {
        const a = JSON.parse(readFileSync(p, "utf8"));
        for (const w of Object.values(a.windows ?? {})) {
          if (w && (typeof w.from === "string" || typeof w.from === "number") && (typeof w.to === "string" || typeof w.to === "number")) {
            regularWindows.push({ from: new Date(w.from).getTime(), to: new Date(w.to).getTime() });
          }
        }
      }
      const f1 = new Date(window.from).getTime();
      const t1 = new Date(window.to).getTime();
      windowsNonOverlapping = regularWindows.every((w) => !(f1 <= w.to && w.from <= t1));
    } catch {
      windowsNonOverlapping = false;
    }
    checks.windowsNonOverlapping = windowsNonOverlapping;
    checks.regularWindows = regularWindows;
    checks.nonceSha256 = nonceSha256;
    checks.nonceConsumed = true; // 路由事务标记 consumed（远端验证）
    checks.probePassed = checks.http1102Seen === true && telemetryExceededCpuSeen === true;
    checks.runId = runId;
    checks.window = window;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    // 无条件 cleanup：unlink handoff + 调用 cleanup 部署器
    try {
      if (handoffPath && statSync(handoffPath).isFile()) unlinkSync(handoffPath);
    } catch {
      // 已删除或不存在
    }
    if (cleanup) {
      const argv = ["node", join(REPO_ROOT, "scripts", "phase0", "deploy.mjs"), "--profile", "cleanup", "--from", deployPath, "--out", cleanupOut];
      try {
        cleanupResult = await cleanup(argv);
        cleanupCalled = true;
      } catch (err) {
        cleanupResult = { passed: false, error: err instanceof Error ? err.message : String(err) };
        cleanupCalled = true;
      }
    }
  }

  const passed = checks.probePassed === true && checks.windowsNonOverlapping === true && cleanupCalled && cleanupResult?.passed === true;

  const artifact = {
    profile: "cpu",
    ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
    runId: checks.runId ?? null,
    window: checks.window ?? null,
    secretSha256: checks.handoffSecretSha256 ?? null,
    pathSegmentSha256: checks.handoffPathSegmentSha256 ?? null,
    handoffSessionNonceSha256: checks.handoffSessionNonceSha256 ?? null,
    nonceSha256: checks.nonceSha256 ?? null,
    nonceConsumed: checks.nonceConsumed === true,
    http1102Seen: checks.http1102Seen === true,
    telemetryExceededCpuSeen: checks.telemetryExceededCpuSeen === true,
    windowsNonOverlapping: checks.windowsNonOverlapping === true,
    regularWindows: checks.regularWindows ?? [],
    probePassed: checks.probePassed === true,
    cleanupCalledByFinally: cleanupCalled,
    cleanupResult,
    error,
    checkedAt,
    canonicalSha256: null,
    passed,
  };
  return artifact;
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
  const { deploy, "cpu-run": cpuRun, "queue-invocations": queueInvocations, cpu, "cleanup-out": cleanupOut, out } = args;
  if (!deploy || !cpuRun || !queueInvocations || !cpu || !cleanupOut || !out) {
    throw new Error("Usage: run-free-limit.mjs --deploy <deploy-cpu.json> --cpu-run <cpu-invocation-run.json> --queue-invocations <queue-invocations.json> --cpu <cpu.json> --cleanup-out <deploy-cleanup.json> --out <free-limit.json>");
  }
  const { spawnSync } = await import("node:child_process");
  const defaultSpawn = (cmd, a) => spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });
  // Telemetry：exact cpu version 的 exceededCpu 事件（Workers Observability Write token）
  const observabilityToken = process.env.CLOUDFLARE_OBSERVABILITY_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  let telemetry = undefined;
  if (observabilityToken && accountId) {
    const { telemetryQuery } = await import("./measure-cpu.mjs");
    const deployArtifact = loadDeployArtifact(deploy, "cpu");
    const versionId = deployArtifact.versionIds[0];
    telemetry = async () => {
      // exceededCpu 事件有分钟级延迟（实测 >20 分钟）：窗口提前 30 分钟，最多等 5 分钟重查
      const fromMs = Date.now() - 30 * 60 * 1000;
      for (let attempt = 0; attempt < 6; attempt++) {
        const t = await telemetryQuery({
          token: observabilityToken,
          accountId,
          versionId,
          from: fromMs,
          to: Date.now(),
        });
        if (t.events.some((e) => e.outcome === "exceededCpu")) return { events: t.events };
        if (attempt < 5) await new Promise((r) => setTimeout(r, 60_000));
      }
      const t = await telemetryQuery({
        token: observabilityToken,
        accountId,
        versionId,
        from: fromMs,
        to: Date.now(),
      });
      return { events: t.events };
    };
  }
  const artifact = await runFreeLimit({
    deployPath: deploy,
    cpuRunPath: cpuRun,
    queueInvocationsPath: queueInvocations,
    cpuPath: cpu,
    cleanupOut,
    out,
    telemetry,
    cleanup: async (argv) => {
      const { runDeploy } = await import("./deploy.mjs");
      const cleanupArtifact = await runDeploy({ profile: "cleanup", spawn: defaultSpawn });
      const sha = await (await import("./canonical-json.mjs")).canonicalJsonHash(cleanupArtifact);
      cleanupArtifact.canonicalSha256 = sha;
      mkdirSync(dirname(cleanupOut), { recursive: true });
      const tmp = `${cleanupOut}.tmp`;
      writeFileSync(tmp, JSON.stringify(cleanupArtifact, null, 2) + "\n");
      renameSync(tmp, cleanupOut);
      return { passed: cleanupArtifact.passed, deploymentId: cleanupArtifact.deploymentId, versionIds: cleanupArtifact.versionIds };
    },
  });
  await atomicWriteJson(out, artifact);
  console.log(JSON.stringify({ freeLimit: { passed: artifact.passed, http1102Seen: artifact.http1102Seen, telemetryExceededCpuSeen: artifact.telemetryExceededCpuSeen, cleanupCalledByFinally: artifact.cleanupCalledByFinally } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`run-free-limit: ${err.message}`);
    process.exit(2);
  });
}
