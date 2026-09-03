/**
 * T12 Step 7：汇总校验。--regular-only 跳过 free-limit 相关；
 * 校验各 artifact 五字段 provenance 与对应 deploy artifact 严格相等、
 * versionIds 稳定排序、跨 profile 即 NO-GO。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, PROVENANCE_KEYS } from "./remote-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function provenanceOf(artifact) {
  const out = {};
  for (const k of PROVENANCE_KEYS) out[k] = artifact[k];
  return out;
}

function assertProvenance(artifact, deployArtifact, label, failures) {
  const a = provenanceOf(artifact);
  const d = provenanceOf(deployArtifact);
  for (const k of PROVENANCE_KEYS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(d[k])) {
      failures.push(`${label}.${k} mismatch`);
    }
  }
  const sorted = [...(artifact.versionIds ?? [])].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(artifact.versionIds ?? [])) {
    failures.push(`${label}.versionIds not sorted`);
  }
  if (artifact.profile !== deployArtifact.profile) {
    failures.push(`${label}.profile cross-deployment`);
  }
}

export async function verifyArtifacts({
  regularOnly = false,
  artifactsDir = ARTIFACTS,
  deployProbesPath = join(artifactsDir, "deploy-probes.json"),
  deployCpuPath = join(artifactsDir, "deploy-cpu.json"),
  remoteContractPath = join(artifactsDir, "remote-contract.json"),
  aiPath = join(artifactsDir, "ai.json"),
  queuePath = join(artifactsDir, "queue.json"),
  cpuInvocationRunPath = join(artifactsDir, "cpu-invocation-run.json"),
  queueInvocationsPath = join(artifactsDir, "queue-invocations.json"),
  cpuPath = join(artifactsDir, "cpu.json"),
  freeLimitPath = join(artifactsDir, "free-limit.json"),
  deployCleanupPath = join(artifactsDir, "deploy-cleanup.json"),
  checkedAt = new Date().toISOString(),
}) {
  const failures = [];
  const checks = {};

  const probes = readJson(deployProbesPath);
  const cpu = readJson(deployCpuPath);

  for (const [label, path, deploy] of [
    ["remote-contract", remoteContractPath, probes],
    ["ai", aiPath, probes],
    ["queue", queuePath, probes],
  ]) {
    const artifact = readJson(path);
    if (artifact.passed !== true) failures.push(`${label}.passed != true`);
    assertProvenance(artifact, deploy, label, failures);
  }

  for (const [label, path, deploy] of [
    ["cpu-invocation-run", cpuInvocationRunPath, cpu],
    ["queue-invocations", queueInvocationsPath, cpu],
    ["cpu", cpuPath, cpu],
  ]) {
    const artifact = readJson(path);
    if (artifact.passed !== true) failures.push(`${label}.passed != true`);
    assertProvenance(artifact, deploy, label, failures);
    // cpu 系 artifact 必须绑定 cpu deployment，禁止复用 probes deployment（跨 deployment 拼接）
    if (artifact.deploymentId === probes.deploymentId) failures.push(`${label}.deploymentId reused from probes`);
  }

  if (!regularOnly) {
    const freeLimit = readJson(freeLimitPath);
    const cleanup = readJson(deployCleanupPath);
    if (freeLimit.passed !== true) failures.push("free-limit.passed != true");
    if (cleanup.passed !== true) failures.push("deploy-cleanup.passed != true");
    assertProvenance(freeLimit, cpu, "free-limit", failures);
    if (freeLimit.deploymentId === probes.deploymentId) failures.push("free-limit.deploymentId reused from probes");
    // cleanup 无独立 deploy artifact：直接校验五字段齐全 + profile + 排序
    for (const k of PROVENANCE_KEYS) {
      if (!(k in cleanup)) failures.push(`deploy-cleanup.${k} missing`);
    }
    if (cleanup.profile !== "cleanup") failures.push("deploy-cleanup.profile != cleanup");
    const sorted = [...(cleanup.versionIds ?? [])].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(cleanup.versionIds ?? [])) failures.push("deploy-cleanup.versionIds not sorted");
    if (freeLimit.secretSha256 !== cpu.secretSha256) failures.push("free-limit.secretSha256 != deploy-cpu");
    if (freeLimit.pathSegmentSha256 !== cpu.pathSegmentSha256) failures.push("free-limit.pathSegmentSha256 != deploy-cpu");
    if (freeLimit.handoffSessionNonceSha256 !== cpu.handoffSessionNonceSha256) failures.push("free-limit.handoffSessionNonceSha256 != deploy-cpu");
    if (freeLimit.http1102Seen !== true) failures.push("free-limit.http1102Seen != true");
    if (freeLimit.telemetryExceededCpuSeen !== true) failures.push("free-limit.telemetryExceededCpuSeen != true");
    if (freeLimit.cleanupCalledByFinally !== true) failures.push("free-limit.cleanupCalledByFinally != true");
  }

  const passed = failures.length === 0;
  const artifact = {
    regularOnly,
    checks: { artifactCount: regularOnly ? 6 : 8, failures },
    passed,
    checkedAt,
    canonicalSha256: null,
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
  const regularOnly = args["regular-only"] !== undefined;
  const artifact = await verifyArtifacts({ regularOnly });
  await atomicWriteJson(join(ARTIFACTS, "verify.json"), artifact);
  console.log(JSON.stringify({ verify: { regularOnly, passed: artifact.passed, failures: artifact.checks.failures } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`verify-remote-artifacts: ${err.message}`);
    process.exit(2);
  });
}
