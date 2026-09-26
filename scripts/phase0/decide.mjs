/**
 * T15 Step 2/5：G0–G7 纯函数决策器 + G8 后置检查。
 * 从 Files 表固定的 50 个直接证据输入 + 5 个源码审计输入重算 hash/引用/DeploymentProvenance，
 * 不读取旧 decision.json、local-tests.txt，不把 G8 当输入。
 * 进程退出码：GO=0、NO-GO=2、证据解析错误=3。
 *
 * 用户豁免（三次，如实记录）：
 * 1. 账户存在 3 个与本项目无关的 Paid 订阅，preflight passed=false 允许继续；
 * 2. Queue retention 实际 345600 秒（4 天）非 Free 24 小时，用户批准忽略，按 24 小时假设继续；
 * 3. entitlement 三件套跳过（collector 代码保留在仓库但不再运行）。
 *
 * 注入契约（测试用）：artifactsDir/repoRoot 指向临时目录；git/gitExit 为假 Git runner。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");

const PROVENANCE_KEYS = ["deploymentId", "versionIds", "profile", "workerUrl", "sourceDeploySha256"];
const LOCKED_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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
    if (JSON.stringify(a[k]) !== JSON.stringify(d[k])) failures.push(`${label}.${k} mismatch`);
  }
  const sorted = [...(artifact.versionIds ?? [])].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(artifact.versionIds ?? [])) failures.push(`${label}.versionIds not sorted`);
  if (artifact.profile !== deployArtifact.profile) failures.push(`${label}.profile cross-deployment`);
}

/** Git 历史审计：文件在唯一前置提交首次加入、是 HEAD 祖先、无二次修改、blob 全等。 */
function auditGitHistory(files, git, gitExit, failures, evidence) {
  const firstCommits = new Set();
  for (const f of files) {
    const out = git(["log", "--diff-filter=A", "--format=%H", "--", f]);
    const lines = out.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      failures.push(`GIT: ${f} never added`);
      return;
    }
    if (lines.length > 1) {
      failures.push(`GIT: ${f} added in multiple commits`);
      return;
    }
    firstCommits.add(lines[0]);
  }
  if (firstCommits.size !== 1) {
    failures.push(`GIT: files added in different commits: ${[...firstCommits].join(",")}`);
    return;
  }
  const firstCommit = [...firstCommits][0];
  evidence.firstCommit = firstCommit;

  if (gitExit(["merge-base", "--is-ancestor", firstCommit, "HEAD"]) !== 0) {
    failures.push(`GIT: first commit ${firstCommit} not ancestor of HEAD`);
    return;
  }

  for (const f of files) {
    const firstBlob = git(["rev-parse", `${firstCommit}:${f}`]).trim();
    const headBlob = git(["rev-parse", `HEAD:${f}`]).trim();
    const idxBlob = git(["rev-parse", `:${f}`]).trim();
    const workBlob = git(["hash-object", f]).trim();
    if (firstBlob !== headBlob || firstBlob !== idxBlob || firstBlob !== workBlob) {
      failures.push(`GIT: ${f} blob changed since first commit`);
      return;
    }
    evidence.blobs = evidence.blobs ?? {};
    evidence.blobs[f] = firstBlob;
  }

  evidence.treeSha = git(["rev-parse", `${firstCommit}^{tree}`]).trim();
}

/** 源码审计：文件存在且 blob 等于 HEAD。 */
function auditSource(files, repoRoot, git, failures, evidence) {
  for (const f of files) {
    if (!existsSync(join(repoRoot, f))) {
      failures.push(`SOURCE: ${f} missing`);
      continue;
    }
    const workBlob = git(["hash-object", f]).trim();
    const headBlob = git(["rev-parse", `HEAD:${f}`]).trim();
    if (workBlob !== headBlob) {
      failures.push(`SOURCE: ${f} worktree differs from HEAD`);
      continue;
    }
    evidence.sourceBlobs = evidence.sourceBlobs ?? {};
    evidence.sourceBlobs[f] = workBlob;
  }
}

/** 校验 PNG 清单：每张截图存在且 hash 匹配。 */
function assertScreenshots(screenshots, artifactsDir, label, failures) {
  if (!Array.isArray(screenshots)) {
    failures.push(`${label}.screenshots not array`);
    return;
  }
  for (const s of screenshots) {
    if (!s?.file || !s?.sha256) {
      failures.push(`${label}.screenshot entry incomplete`);
      continue;
    }
    const p = join(artifactsDir, s.file);
    if (!existsSync(p)) {
      failures.push(`${label}.screenshot ${s.file} missing`);
      continue;
    }
    if (sha256File(p) !== s.sha256) failures.push(`${label}.screenshot ${s.file} hash mismatch`);
  }
}

export async function decide({
  artifactsDir = ARTIFACTS,
  repoRoot = REPO_ROOT,
  git = (args) => spawnSync("git", args, { encoding: "utf8", cwd: repoRoot }).stdout,
  gitExit = (args) => spawnSync("git", args, { encoding: "utf8", cwd: repoRoot }).status,
  checkedAt = new Date().toISOString(),
} = {}) {
  const failures = [];
  const gates = { G0: false, G1: false, G2: false, G3: false, G4: false, G5: false, G6: false, G7: false };
  const evidence = {};

  const A = (name) => join(artifactsDir, name);
  const has = (name) => existsSync(A(name));
  const R = (name) => join(repoRoot, name);

  /* ---------------- G0：账户闸门 + client lock + Git 历史 ---------------- */
  {
    const g0 = [];
    if (!has("preflight.json")) g0.push("preflight.json missing");
    else {
      const pre = readJson(A("preflight.json"));
      if (pre.whoamiAccountIdSha256 !== pre.billingRequestAccountIdSha256) g0.push("G0 account hashes differ");
      if (pre.uniqueSubscriptionIdCount !== pre.totalCount) g0.push("G0 uniqueSubscriptionIdCount != totalCount");
      if (typeof pre.subscriptionProjectionSha256 !== "string") g0.push("G0 projection hash missing");
      else {
        const projHash = await canonicalJsonHash(pre.subscriptionProjection);
        if (projHash !== pre.subscriptionProjectionSha256) g0.push("G0 projection hash mismatch");
      }
      // 豁免 1：Paid 订阅与项目无关，preflight passed=false 允许继续
      evidence.g0Exemption = {
        preflightPassed: pre.passed,
        subscriptionRiskFree: pre.subscriptionRiskFree,
        exemption: "账户存在 3 个与本项目无关的 Paid 订阅，用户批准忽略",
      };
      evidence.g0AccountIdSha256 = pre.whoamiAccountIdSha256;
    }
    if (!has("deploy-probes.json")) g0.push("deploy-probes.json missing");
    else {
      const dep = readJson(A("deploy-probes.json"));
      if (dep.accountIdSha256 !== evidence.g0AccountIdSha256) g0.push("G2 account hash != G0");
    }
    // client lock
    if (!existsSync(R("config/phase0/client-lock.json"))) g0.push("client-lock.json missing");
    else {
      const lock = readJson(R("config/phase0/client-lock.json"));
      if (lock.lockStatus !== "RESOLVED") g0.push("client-lock not RESOLVED");
      if (!lock.reviewedBy || !lock.reviewedAt) g0.push("client-lock not human-reviewed");
      if (!lock.extension?.passed || !lock.android?.passed) g0.push("client-lock not passed");
      evidence.clientLockSha256 = lock.canonicalSha256;
    }
    // Git 历史：两份 immutable manifest + client lock + store evidence 同一前置提交
    auditGitHistory(
      ["config/phase0/client-lock.json", "artifacts/phase0/extension-client-manifest.json", "artifacts/phase0/android-client-manifest.json", "artifacts/phase0/extension-store-evidence.json"],
      git,
      gitExit,
      g0,
      evidence,
    );
    // 源码审计：entitlement collector + 测试（豁免 3：collector 保留但不再运行）
    auditSource(["scripts/phase0/capture-workers-plan-entitlement.mjs", "test/workers-plan-entitlement.test.ts"], repoRoot, git, g0, evidence);
    gates.G0 = g0.length === 0;
    failures.push(...g0.map((m) => `G0: ${m}`));
  }

  /* ---------------- G1：local-tests.json ---------------- */
  {
    const g1 = [];
    if (!has("local-tests.json")) g1.push("local-tests.json missing");
    else {
      const lt = readJson(A("local-tests.json"));
      if (lt.passed !== true) g1.push("local-tests passed:false");
      if (!Array.isArray(lt.commands) || lt.commands.length !== 3) g1.push("local-tests commands missing");
      else if (lt.commands.some((c) => c.exitCode !== 0)) g1.push("local-tests command non-zero");
      if (lt.dryRun?.bindingsOk !== true) g1.push("local-tests bindings check failed");
      if (lt.dryRun?.cronOk !== true) g1.push("local-tests cron check failed");
      if (lt.dryRun?.cpuMsPresent === true) g1.push("local-tests limits.cpu_ms present");
      if (lt.dryRun?.forbiddenOk !== true) g1.push("local-tests forbidden resources present");
      const hash = await canonicalJsonHash(lt);
      if (hash !== lt.canonicalSha256) g1.push("local-tests canonical hash mismatch");
    }
    gates.G1 = g1.length === 0;
    failures.push(...g1.map((m) => `G1: ${m}`));
  }

  /* ---------------- G2：probes deployment + bootstrap/smoke/contract ---------------- */
  {
    const g2 = [];
    if (!has("deploy-probes.json")) g2.push("deploy-probes.json missing");
    else {
      const dep = readJson(A("deploy-probes.json"));
      if (dep.passed !== true) g2.push("deploy-probes passed:false");
      if (dep.profile !== "probes") g2.push("deploy-probes profile != probes");
      if (dep.accountIdSha256 !== evidence.g0AccountIdSha256) g2.push("deploy-probes account != G0");
      const qp = dep.queueProjections ?? {};
      for (const [name, proj] of Object.entries(qp)) {
        if (proj.retentionHours !== 24) g2.push(`queue ${name} retention != 24h`);
        if (typeof proj.projectionSha256 !== "string") g2.push(`queue ${name} projection hash missing`);
      }
      evidence.queueRetentionExemption = {
        actualRetentionSeconds: Object.values(qp)[0]?.retentionSeconds,
        exemption: "Queue retention 实际 345600 秒（4 天）非 Free 24 小时，用户批准忽略",
      };
      evidence.probesProvenance = provenanceOf(dep);
    }
    for (const name of ["bootstrap.json", "smoke.json", "remote-contract.json"]) {
      if (!has(name)) g2.push(`${name} missing`);
      else {
        const art = readJson(A(name));
        if (art.passed !== true) g2.push(`${name} passed:false`);
        if (has("deploy-probes.json")) assertProvenance(art, readJson(A("deploy-probes.json")), name, g2);
      }
    }
    gates.G2 = g2.length === 0;
    failures.push(...g2.map((m) => `G2: ${m}`));
  }

  /* ---------------- G3：extension content binding + final 五件套 ---------------- */
  {
    const g3 = [];
    if (!has("deploy-clients.json")) g3.push("deploy-clients.json missing");
    else {
      const dc = readJson(A("deploy-clients.json"));
      if (dc.passed !== true) g3.push("deploy-clients passed:false");
      if (dc.profile !== "clients") g3.push("deploy-clients profile != clients");
      evidence.clientsProvenance = provenanceOf(dc);
    }
    if (!has("extension-store-content-binding.json")) g3.push("extension-store-content-binding.json missing");
    else {
      const cb = readJson(A("extension-store-content-binding.json"));
      if (cb.passed !== true) g3.push("content binding passed:false");
      if (has("extension-client-manifest.json")) {
        const m = readJson(A("extension-client-manifest.json"));
        const mHash = await canonicalJsonHash(m);
        if (mHash !== m.canonicalSha256) g3.push("extension manifest canonical hash mismatch");
        if (cb.extensionManifestSha256 !== m.canonicalSha256) g3.push("content binding manifest hash mismatch");
      }
      for (const name of ["installed-content-manifest.json", "signed-content-manifest.json"]) {
        if (!has(name)) g3.push(`${name} missing`);
        else {
          const cm = readJson(A(name));
          if (typeof cm.canonicalSha256 !== "string") g3.push(`${name} canonical hash missing`);
        }
      }
      if (has("installed-content-manifest.json") && has("signed-content-manifest.json")) {
        const i = readJson(A("installed-content-manifest.json"));
        const s = readJson(A("signed-content-manifest.json"));
        if (i.canonicalSha256 !== s.canonicalSha256) g3.push("installed/signed manifests differ");
      }
      if (!has("extension-store-install.png")) g3.push("extension-store-install.png missing");
      else if (cb.installScreenshotSha256 && sha256File(A("extension-store-install.png")) !== cb.installScreenshotSha256) g3.push("install screenshot hash mismatch");
      if (has("deploy-clients.json")) assertProvenance(cb, readJson(A("deploy-clients.json")), "content-binding", g3);
    }
    // extension 流程证据
    for (const name of ["extension-screenshots.json", "extension-manual.json", "capture-freeze-extension.json", "wire-extension.json"]) {
      if (!has(name)) g3.push(`${name} missing`);
      else {
        const art = readJson(A(name));
        if (art.passed !== true) g3.push(`${name} passed:false`);
        if (has("deploy-clients.json")) assertProvenance(art, readJson(A("deploy-clients.json")), name, g3);
      }
    }
    if (has("extension-screenshots.json")) {
      const ss = readJson(A("extension-screenshots.json"));
      assertScreenshots(ss.screenshots ?? ss, artifactsDir, "extension-screenshots", g3);
    }
    if (has("wire-extension.json")) {
      const w = readJson(A("wire-extension.json"));
      if (w.unknownProcedures !== 0 && w.unknownProcedures !== undefined) g3.push("wire-extension unknown procedures non-empty");
    }
    // final 五件套
    for (const name of ["final-store-binding.json", "final-store-screenshot-manifest.json", "final-installed-content-manifest.json", "final-signed-content-manifest.json", "final-store-install.png"]) {
      if (!has(name)) g3.push(`${name} missing`);
    }
    if (has("final-store-binding.json")) {
      const fb = readJson(A("final-store-binding.json"));
      if (fb.passed !== true) g3.push("final-store-binding passed:false");
      if (has("extension-store-content-binding.json")) {
        const cb = readJson(A("extension-store-content-binding.json"));
        if (fb.contentBindingSha256 !== cb.canonicalSha256) g3.push("final binding content-binding hash mismatch");
      }
      if (has("deploy-clients.json")) assertProvenance(fb, readJson(A("deploy-clients.json")), "final-binding", g3);
    }
    if (has("final-installed-content-manifest.json") && has("final-signed-content-manifest.json")) {
      const i = readJson(A("final-installed-content-manifest.json"));
      const s = readJson(A("final-signed-content-manifest.json"));
      if (i.canonicalSha256 !== s.canonicalSha256) g3.push("final installed/signed manifests differ");
    }
    gates.G3 = g3.length === 0;
    failures.push(...g3.map((m) => `G3: ${m}`));
  }

  /* ---------------- G4：mobile version evidence ---------------- */
  {
    const g4 = [];
    if (!has("mobile-version-evidence.json")) g4.push("mobile-version-evidence.json missing");
    else {
      const ve = readJson(A("mobile-version-evidence.json"));
      if (ve.passed !== true) g4.push("mobile version evidence passed:false");
      if (!has("mobile-version.png")) g4.push("mobile-version.png missing");
      else if (ve.screenshot?.sha256 && sha256File(A("mobile-version.png")) !== ve.screenshot.sha256) g4.push("mobile version png hash mismatch");
      if (ve.androidManifestSha256 && has("android-client-manifest.json")) {
        const m = readJson(A("android-client-manifest.json"));
        const mHash = await canonicalJsonHash(m);
        if (mHash !== m.canonicalSha256) g4.push("android manifest canonical hash mismatch");
        if (ve.androidManifestSha256 !== m.canonicalSha256) g4.push("mobile version evidence manifest hash mismatch");
      }
      if (has("deploy-clients.json")) assertProvenance(ve, readJson(A("deploy-clients.json")), "mobile-version-evidence", g4);
    }
    for (const name of ["mobile-manual.json", "mobile-screenshots.json", "capture-freeze-mobile.json", "wire-mobile.json"]) {
      if (!has(name)) g4.push(`${name} missing`);
      else {
        const art = readJson(A(name));
        if (art.passed !== true) g4.push(`${name} passed:false`);
        if (has("deploy-clients.json")) assertProvenance(art, readJson(A("deploy-clients.json")), name, g4);
      }
    }
    if (has("mobile-manual.json")) {
      const mm = readJson(A("mobile-manual.json"));
      if (mm.mobileVersionEvidenceSha256 && has("mobile-version-evidence.json")) {
        const ve = readJson(A("mobile-version-evidence.json"));
        if (mm.mobileVersionEvidenceSha256 !== ve.canonicalSha256) g4.push("mobile-manual evidence hash mismatch");
      }
    }
    if (has("mobile-screenshots.json")) {
      const ss = readJson(A("mobile-screenshots.json"));
      assertScreenshots(ss.screenshots ?? ss, artifactsDir, "mobile-screenshots", g4);
    }
    gates.G4 = g4.length === 0;
    failures.push(...g4.map((m) => `G4: ${m}`));
  }

  /* ---------------- G5：cpu deployment + free-limit + cleanup ---------------- */
  {
    const g5 = [];
    if (!has("deploy-cpu.json")) g5.push("deploy-cpu.json missing");
    else {
      const dc = readJson(A("deploy-cpu.json"));
      if (dc.passed !== true) g5.push("deploy-cpu passed:false");
      if (dc.profile !== "cpu") g5.push("deploy-cpu profile != cpu");
      if (dc.limitsCpuMsAbsent !== true) g5.push("deploy-cpu limits.cpu_ms present");
      if (!dc.secretSha256 || !dc.pathSegmentSha256 || !dc.handoffSessionNonceSha256) g5.push("deploy-cpu secret/path/session hash missing");
      evidence.cpuProvenance = provenanceOf(dc);
    }
    if (!has("cpu.json")) g5.push("cpu.json missing");
    else {
      const cpu = readJson(A("cpu.json"));
      if (cpu.passed !== true) g5.push("cpu passed:false");
      if (cpu.http1102Count !== 0) g5.push("cpu http1102Count != 0");
      if (cpu.graphql?.maxCpuTimeP99Us >= 8000) g5.push("cpu p99 >= 8000us");
      if (has("deploy-cpu.json")) assertProvenance(cpu, readJson(A("deploy-cpu.json")), "cpu.json", g5);
    }
    if (!has("free-limit.json")) g5.push("free-limit.json missing");
    else {
      const fl = readJson(A("free-limit.json"));
      if (fl.passed !== true) g5.push("free-limit passed:false");
      if (fl.http1102Seen !== true) g5.push("free-limit http1102 not seen");
      if (fl.telemetryExceededCpuSeen !== true) g5.push("free-limit exceededCpu not seen");
      if (fl.cleanupCalledByFinally !== true) g5.push("free-limit cleanup not called by finally");
      if (has("deploy-cpu.json")) {
        const dc = readJson(A("deploy-cpu.json"));
        if (fl.secretSha256 !== dc.secretSha256 || fl.pathSegmentSha256 !== dc.pathSegmentSha256 || fl.handoffSessionNonceSha256 !== dc.handoffSessionNonceSha256) {
          g5.push("free-limit secret/path/session hash != deploy-cpu");
        }
      }
    }
    if (!has("deploy-cleanup.json")) g5.push("deploy-cleanup.json missing");
    else {
      const cl = readJson(A("deploy-cleanup.json"));
      if (cl.passed !== true) g5.push("deploy-cleanup passed:false");
      if (cl.profile !== "cleanup") g5.push("deploy-cleanup profile != cleanup");
      if (cl.probeEnabled !== false) g5.push("deploy-cleanup probe still enabled");
      if (cl.limitsCpuMsAbsent !== true) g5.push("deploy-cleanup limits.cpu_ms present");
      // cleanup 是 cpu 之后的覆盖部署，deploymentId/versionIds 是新的，不与 cpu 比对
      if (typeof cl.deploymentId !== "string" || !Array.isArray(cl.versionIds) || cl.versionIds.length === 0) {
        g5.push("deploy-cleanup provenance incomplete");
      }
    }
    gates.G5 = g5.length === 0;
    failures.push(...g5.map((m) => `G5: ${m}`));
  }

  /* ---------------- G6：AI JSON Mode ---------------- */
  {
    const g6 = [];
    if (!has("ai.json")) g6.push("ai.json missing");
    else {
      const ai = readJson(A("ai.json"));
      if (ai.passed !== true) g6.push("ai passed:false");
      if (ai.model !== LOCKED_MODEL) g6.push("ai model not locked");
      if (has("deploy-probes.json")) assertProvenance(ai, readJson(A("deploy-probes.json")), "ai.json", g6);
    }
    gates.G6 = g6.length === 0;
    failures.push(...g6.map((m) => `G6: ${m}`));
  }

  /* ---------------- G7：Queue + Cron + Telemetry ---------------- */
  {
    const g7 = [];
    if (!has("queue.json")) g7.push("queue.json missing");
    else {
      const q = readJson(A("queue.json"));
      if (q.passed !== true) g7.push("queue passed:false");
      if (q.checks?.retryDlqPassed !== true) g7.push("queue retry/dlq failed");
      if (q.checks?.cronAuditPassed !== true) g7.push("queue cron audit failed");
      if (q.checks?.cronFailureRecoveryPassed !== true) g7.push("queue cron recovery failed");
      if (has("deploy-probes.json")) assertProvenance(q, readJson(A("deploy-probes.json")), "queue.json", g7);
    }
    for (const name of ["cpu-invocation-run.json", "queue-invocations.json"]) {
      if (!has(name)) g7.push(`${name} missing`);
      else {
        const art = readJson(A(name));
        if (art.passed !== true) g7.push(`${name} passed:false`);
        if (has("deploy-cpu.json")) assertProvenance(art, readJson(A("deploy-cpu.json")), name, g7);
      }
    }
    gates.G7 = g7.length === 0;
    failures.push(...g7.map((m) => `G7: ${m}`));
  }

  const failedGates = Object.entries(gates).filter(([, v]) => !v).map(([k]) => k);
  const decision = failedGates.length === 0 ? "GO" : "NO-GO";

  const artifact = {
    decision,
    failedGates,
    gates,
    checkedAt,
    lockedVersions: {
      karakeepCommit: "5a2f009e2f6d266087f2f3f527e6e384cefd6de4",
      extension: "1.2.11",
      mobile: "1.11.0",
    },
    exemptions: [
      { gate: "G0", note: "账户存在 3 个与本项目无关的 Paid 订阅，preflight passed=false 允许继续" },
      { gate: "G2", note: "Queue retention 实际 345600 秒（4 天）非 Free 24 小时，用户批准忽略，按 24 小时假设继续" },
      { gate: "G0", note: "entitlement 三件套跳过（collector 代码保留在仓库但不再运行）" },
    ],
    evidence,
    failures,
    canonicalSha256: null,
  };
  artifact.canonicalSha256 = await canonicalJsonHash(artifact);
  return artifact;
}

export async function main(argv) {
  const outPath = argv[2] ?? join(ARTIFACTS, "decision.json");
  const artifact = await decide();
  const { mkdirSync, writeFileSync, renameSync } = await import("node:fs");
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, outPath);
  console.log(JSON.stringify({ decision: artifact.decision, failedGates: artifact.failedGates, gates: artifact.gates }));
  process.exit(artifact.decision === "GO" ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`decide: ${err.message}`);
    process.exit(3);
  });
}
