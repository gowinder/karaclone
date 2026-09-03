/**
 * T15 Step 1：fail-closed 决策测试（纯 node 环境）。
 * 表驱动：文件缺失、JSON 损坏、passed:false、G0 两个 account hash 不等、
 * client lock 非 RESOLVED、G1 命令非零、G2 账户不等、G3/G4 证据缺失、
 * G5 CPU 等于 8000、G6 模型未锁定、G7 Queue 少一次 attempt 等 → NO-GO。
 * 必须加入 vitest.config.ts 的 nodeTests 数组。
 */
import { describe, expect, it } from "vitest";
import { decide } from "../scripts/phase0/decide.mjs";
import { canonicalJsonHash } from "../scripts/phase0/canonical-json.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fs = { readFileSync, writeFileSync, rmSync };

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ACCOUNT_SHA = "bef40fdf3e1c552e900d60686f364aa0f847a5ce4e2066a44e094b2ef14eb645";
const PROBES = {
  profile: "probes",
  passed: true,
  workerUrl: "https://karaclone-phase0.gowinder.workers.dev",
  deploymentId: "feb1faea-6409-4ba7-a120-a094889b0417",
  versionIds: ["97be406d-c92c-4656-a592-e1c7b8018f28"],
  sourceDeploySha256: "2a8fa1c3bf3d01d7da21e6c56e5936e2cb2ea57161a73fd4e3709273a5cd7771",
  accountIdSha256: ACCOUNT_SHA,
  queueProjections: {
    "karaclone-phase0-enrichment": { retentionHours: 24, retentionSeconds: 345600, projectionSha256: "x" },
    "karaclone-phase0-enrichment-dlq": { retentionHours: 24, retentionSeconds: 345600, projectionSha256: "y" },
  },
};
const CLIENTS = {
  profile: "clients",
  passed: true,
  workerUrl: "https://karaclone-phase0.gowinder.workers.dev",
  deploymentId: "feb1faea-6409-4ba7-a120-a094889b0417",
  versionIds: ["97be406d-c92c-4656-a592-e1c7b8018f28"],
  sourceDeploySha256: "2a8fa1c3bf3d01d7da21e6c56e5936e2cb2ea57161a73fd4e3709273a5cd7771",
};
const CPU = {
  profile: "cpu",
  passed: true,
  workerUrl: "https://karaclone-phase0.gowinder.workers.dev",
  deploymentId: "feb1faea-6409-4ba7-a120-a094889b0417",
  versionIds: ["97be406d-c92c-4656-a592-e1c7b8018f28"],
  sourceDeploySha256: "2a8fa1c3bf3d01d7da21e6c56e5936e2cb2ea57161a73fd4e3709273a5cd7771",
  limitsCpuMsAbsent: true,
  secretSha256: "s1",
  pathSegmentSha256: "p1",
  handoffSessionNonceSha256: "n1",
};
const CLEANUP = {
  profile: "cleanup",
  passed: true,
  workerUrl: "https://karaclone-phase0.gowinder.workers.dev",
  deploymentId: "cleanup-deploy-1",
  versionIds: ["cleanup-version-1"],
  sourceDeploySha256: "2a8fa1c3bf3d01d7da21e6c56e5936e2cb2ea57161a73fd4e3709273a5cd7771",
  probeEnabled: false,
  limitsCpuMsAbsent: true,
};

const FIRST_COMMIT = "b0d7dab580598516075bb9730c5c472ab673b811";
const TREE_SHA = "tree123";
const BLOB = "blob123";

/** 假 Git runner：所有文件在同一前置提交首次加入，blob 全等。 */
function fakeGit(args: string[]) {
  const a = args.join(" ");
  if (a.includes("--diff-filter=A")) return `${FIRST_COMMIT}\n`;
  if (a.includes("rev-parse") && a.includes("^{tree}")) return `${TREE_SHA}\n`;
  if (a.includes("rev-parse")) return `${BLOB}\n`;
  if (a.includes("hash-object")) return `${BLOB}\n`;
  return "";
}
function fakeGitExit() {
  return 0;
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "decision-"));
}

function writeArtifact(dir: string, name: string, obj: unknown) {
  const p = join(dir, name);
  mkdirSync(join(dir, "config", "phase0"), { recursive: true });
  mkdirSync(join(dir, "scripts", "phase0"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function writePng(dir: string, name: string) {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from("fake-png-bytes"));
  return p;
}

/** 写 artifact 并计算真实 canonical hash（排除 canonicalSha256 字段）。 */
async function writeArtifactHashed(dir: string, name: string, obj: Record<string, unknown>) {
  const withNull = { ...obj, canonicalSha256: null };
  const hash = await canonicalJsonHash(withNull);
  writeArtifact(dir, name, { ...withNull, canonicalSha256: hash });
  return hash;
}

/** 构造一个"全通过"的 artifacts 目录。 */
async function buildAllPassing(): Promise<string> {
  const dir = tmpDir();
  // G0
  const pre: Record<string, unknown> = {
    whoamiAccountIdSha256: ACCOUNT_SHA,
    billingRequestAccountIdSha256: ACCOUNT_SHA,
    totalCount: 3,
    uniqueSubscriptionIdCount: 3,
    subscriptionProjection: [],
    subscriptionProjectionSha256: null,
    passed: false,
    subscriptionRiskFree: false,
  };
  pre.subscriptionProjectionSha256 = await canonicalJsonHash(pre.subscriptionProjection);
  writeArtifact(dir, "preflight.json", pre);
  // client lock
  const lockDir = join(dir, "config", "phase0");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "client-lock.json"), JSON.stringify({
    lockStatus: "RESOLVED",
    reviewedBy: "human-reviewer",
    reviewedAt: "2026-09-03T00:00:00.000Z",
    extension: { passed: true, version: "1.2.11" },
    android: { passed: true, version: "1.11.0" },
    canonicalSha256: "lock",
  }));
  // immutable manifests（真实 canonical hash）
  const extManifestHash = await writeArtifactHashed(dir, "extension-client-manifest.json", { passed: true, version: "1.2.11" });
  const andManifestHash = await writeArtifactHashed(dir, "android-client-manifest.json", { passed: true, version: "1.11.0" });
  writeArtifact(dir, "extension-store-evidence.json", { passed: true, canonicalSha256: "evid", extensionId: "kgcjekpmcjjogibpjebkhaanilehneje", version: "1.2.11", publisher: "karakeep.app" });
  // 源码审计输入
  writeArtifact(join(dir, "scripts", "phase0"), "capture-workers-plan-entitlement.mjs", {});
  writeArtifact(join(dir, "test"), "workers-plan-entitlement.test.ts", {});
  // G1
  const lt: Record<string, unknown> = {
    passed: true,
    commands: [{ command: "npm test", exitCode: 0 }, { command: "npm run typecheck", exitCode: 0 }, { command: "dry-run", exitCode: 0 }],
    dryRun: { bindingsOk: true, cronOk: true, cpuMsPresent: false, forbiddenOk: true },
    canonicalSha256: null,
  };
  lt.canonicalSha256 = await canonicalJsonHash(lt);
  writeArtifact(dir, "local-tests.json", lt);
  // G2
  writeArtifact(dir, "deploy-probes.json", PROBES);
  writeArtifact(dir, "bootstrap.json", { ...PROBES, passed: true });
  writeArtifact(dir, "smoke.json", { ...PROBES, passed: true });
  writeArtifact(dir, "remote-contract.json", { ...PROBES, passed: true });
  // G3
  writeArtifact(dir, "deploy-clients.json", CLIENTS);
  writePng(dir, "extension-store-install.png");
  const pngHash = sha256File(join(dir, "extension-store-install.png"));
  const cb: Record<string, unknown> = {
    ...CLIENTS,
    passed: true,
    extensionManifestSha256: extManifestHash,
    installScreenshotSha256: pngHash,
    contentBindingSha256: null,
    canonicalSha256: null,
  };
  cb.contentBindingSha256 = await canonicalJsonHash(cb);
  cb.canonicalSha256 = await canonicalJsonHash(cb);
  writeArtifact(dir, "extension-store-content-binding.json", cb);
  const cmHash = await writeArtifactHashed(dir, "installed-content-manifest.json", { files: [] });
  writeArtifact(dir, "signed-content-manifest.json", { files: [], canonicalSha256: cmHash });
  writeArtifact(dir, "extension-screenshots.json", { ...CLIENTS, passed: true, screenshots: [] });
  writeArtifact(dir, "extension-manual.json", { ...CLIENTS, passed: true });
  writeArtifact(dir, "capture-freeze-extension.json", { ...CLIENTS, passed: true });
  writeArtifact(dir, "wire-extension.json", { ...CLIENTS, passed: true, unknownProcedures: 0 });
  const fb = { ...CLIENTS, passed: true, contentBindingSha256: cb.canonicalSha256 };
  writeArtifact(dir, "final-store-binding.json", fb);
  writeArtifact(dir, "final-store-screenshot-manifest.json", { ...CLIENTS, passed: true });
  const fcmHash = await writeArtifactHashed(dir, "final-installed-content-manifest.json", { files: [] });
  writeArtifact(dir, "final-signed-content-manifest.json", { files: [], canonicalSha256: fcmHash });
  writePng(dir, "final-store-install.png");
  // G4
  writePng(dir, "mobile-version.png");
  const ve: Record<string, unknown> = {
    ...CLIENTS,
    passed: true,
    androidManifestSha256: andManifestHash,
    screenshot: { file: "mobile-version.png", sha256: pngHash },
    canonicalSha256: null,
  };
  ve.canonicalSha256 = await canonicalJsonHash(ve);
  writeArtifact(dir, "mobile-version-evidence.json", ve);
  const veHash = ve.canonicalSha256;
  writeArtifact(dir, "mobile-manual.json", { ...CLIENTS, passed: true, mobileVersionEvidenceSha256: veHash });
  writeArtifact(dir, "mobile-screenshots.json", { ...CLIENTS, passed: true, screenshots: [] });
  writeArtifact(dir, "capture-freeze-mobile.json", { ...CLIENTS, passed: true });
  writeArtifact(dir, "wire-mobile.json", { ...CLIENTS, passed: true });
  // G5
  writeArtifact(dir, "deploy-cpu.json", CPU);
  writeArtifact(dir, "cpu.json", { ...CPU, passed: true, http1102Count: 0, graphql: { maxCpuTimeP99Us: 1000 } });
  writeArtifact(dir, "free-limit.json", { ...CPU, passed: true, http1102Seen: true, telemetryExceededCpuSeen: true, cleanupCalledByFinally: true, secretSha256: "s1", pathSegmentSha256: "p1", handoffSessionNonceSha256: "n1" });
  writeArtifact(dir, "deploy-cleanup.json", CLEANUP);
  // G6
  writeArtifact(dir, "ai.json", { ...PROBES, passed: true, model: "@cf/meta/llama-3.1-8b-instruct-fast" });
  // G7
  writeArtifact(dir, "queue.json", { ...PROBES, passed: true, checks: { retryDlqPassed: true, cronAuditPassed: true, cronFailureRecoveryPassed: true } });
  writeArtifact(dir, "cpu-invocation-run.json", { ...CPU, passed: true });
  writeArtifact(dir, "queue-invocations.json", { ...CPU, passed: true });
  return dir;
}

async function decideAt(dir: string) {
  return decide({ artifactsDir: dir, repoRoot: dir, git: fakeGit, gitExit: fakeGitExit });
}

describe("decide 全通过 → GO", () => {
  it("所有证据齐全 → GO", async () => {
    const dir = await buildAllPassing();
    const res = await decideAt(dir);
    expect(res.decision).toBe("GO");
    expect(res.failedGates).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("decide fail-closed", () => {
  it("G0 两个 account hash 不等 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const pre = JSON.parse(fs.readFileSync(join(dir, "preflight.json"), "utf8"));
    pre.billingRequestAccountIdSha256 = "different";
    fs.writeFileSync(join(dir, "preflight.json"), JSON.stringify(pre));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G0");
    rmSync(dir, { recursive: true, force: true });
  });

  it("client lock 非 RESOLVED → NO-GO", async () => {
    const dir = await buildAllPassing();
    const lock = JSON.parse(fs.readFileSync(join(dir, "config", "phase0", "client-lock.json"), "utf8"));
    lock.lockStatus = "PENDING";
    fs.writeFileSync(join(dir, "config", "phase0", "client-lock.json"), JSON.stringify(lock));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G0");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G1 local-tests 命令非零 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const lt = JSON.parse(fs.readFileSync(join(dir, "local-tests.json"), "utf8"));
    lt.commands[1].exitCode = 1;
    fs.writeFileSync(join(dir, "local-tests.json"), JSON.stringify(lt));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G1 local-tests 缺失 → NO-GO", async () => {
    const dir = await buildAllPassing();
    fs.rmSync(join(dir, "local-tests.json"));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G2 deploy account hash != G0 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const dep = JSON.parse(fs.readFileSync(join(dir, "deploy-probes.json"), "utf8"));
    dep.accountIdSha256 = "different";
    fs.writeFileSync(join(dir, "deploy-probes.json"), JSON.stringify(dep));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G3 content binding 缺失 → NO-GO", async () => {
    const dir = await buildAllPassing();
    fs.rmSync(join(dir, "extension-store-content-binding.json"));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G3");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G4 mobile-version-evidence 缺失 → NO-GO", async () => {
    const dir = await buildAllPassing();
    fs.rmSync(join(dir, "mobile-version-evidence.json"));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G4");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G5 CPU p99 等于 8000 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const cpu = JSON.parse(fs.readFileSync(join(dir, "cpu.json"), "utf8"));
    cpu.graphql.maxCpuTimeP99Us = 8000;
    fs.writeFileSync(join(dir, "cpu.json"), JSON.stringify(cpu));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G5");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G6 AI 模型未锁定 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const ai = JSON.parse(fs.readFileSync(join(dir, "ai.json"), "utf8"));
    ai.model = "some-other-model";
    fs.writeFileSync(join(dir, "ai.json"), JSON.stringify(ai));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G6");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G7 Queue retry/dlq 失败 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const q = JSON.parse(fs.readFileSync(join(dir, "queue.json"), "utf8"));
    q.checks.retryDlqPassed = false;
    fs.writeFileSync(join(dir, "queue.json"), JSON.stringify(q));
    const res = await decideAt(dir);
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G7");
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON 损坏 → 抛错（证据解析错误）", async () => {
    const dir = await buildAllPassing();
    fs.writeFileSync(join(dir, "preflight.json"), "{broken");
    await expect(decideAt(dir)).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Git 历史：文件从未加入 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const res = await decide({
      artifactsDir: dir,
      repoRoot: dir,
      git: () => "",
      gitExit: () => 0,
    });
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G0");
    rmSync(dir, { recursive: true, force: true });
  });

  it("Git 历史：前置提交非 HEAD 祖先 → NO-GO", async () => {
    const dir = await buildAllPassing();
    const res = await decide({
      artifactsDir: dir,
      repoRoot: dir,
      git: fakeGit,
      gitExit: () => 1,
    });
    expect(res.decision).toBe("NO-GO");
    expect(res.failedGates).toContain("G0");
    rmSync(dir, { recursive: true, force: true });
  });
});
