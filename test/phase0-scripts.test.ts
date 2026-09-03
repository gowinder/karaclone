/**
 * T12 Step 1：远端 runner 失败安全行为测试（纯 node 环境）。
 * 把 HTTP/Wrangler/Telemetry/GraphQL 作为注入函数，覆盖 plan 列出的失败路径。
 * 必须加入 vitest.config.ts 的 nodeTests 数组（workerd 环境无法跑这些注入测试）。
 */
import { describe, expect, it } from "vitest";
import { runContract } from "../scripts/phase0/remote-contract.mjs";
import { runAiProbe } from "../scripts/phase0/run-ai-probe.mjs";
import { runQueue, runResume } from "../scripts/phase0/run-queue-probe.mjs";
import { runCpu } from "../scripts/phase0/measure-cpu.mjs";
import { runFreeLimit } from "../scripts/phase0/run-free-limit.mjs";
import { verifyArtifacts } from "../scripts/phase0/verify-remote-artifacts.mjs";
import { loadApiKey, loadDeployArtifact, assertNoDrift } from "../scripts/phase0/remote-common.mjs";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBES = {
  profile: "probes",
  passed: true,
  workerUrl: "https://karaclone-phase0.gowinder.workers.dev",
  deploymentId: "28d1e022-d7f6-4e3a-b477-0db20cc06d7d",
  versionIds: ["50d98bfb-70a1-4ef2-95ea-d939b01acf01"],
  sourceDeploySha256: "c09181f3d87c02bb4d4696cebb5b7f7fe39906badadc2fd8350a01de9099c67a",
};

const API_KEY = "ak2_99887766554433221100aabbccddeeff";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "phase0-scripts-"));
}

function writeArtifact(dir: string, name: string, obj: unknown) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("runContract 失败安全", () => {
  it("fetch 返回 1102 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runContract({
      deployPath,
      apiKey: API_KEY,
      fetchImpl: async () => new Response("1102", { status: 1102 }),
    });
    expect(res).toMatchObject({ passed: false });
    expect(res.http1102Count).toBeGreaterThan(0);
  });

  it("deploy artifact 缺失 → 抛错", async () => {
    await expect(runContract({ deployPath: "/nonexistent/deploy.json", apiKey: API_KEY })).rejects.toThrow();
  });

  it("deploy artifact passed:false → 抛错", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", { ...PROBES, passed: false });
    await expect(runContract({ deployPath, apiKey: API_KEY })).rejects.toThrow("DEPLOY_NOT_PASSED");
  });

  it("deploy artifact profile 非 probes → 抛错", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu" });
    await expect(runContract({ deployPath, apiKey: API_KEY })).rejects.toThrow("DEPLOY_PROFILE_MISMATCH");
  });
});

describe("runAiProbe 失败安全", () => {
  it("非 JSON 响应 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runAiProbe({
      deployPath,
      apiKey: API_KEY,
      fetchImpl: async () => new Response("not json", { status: 200 }),
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("model 不匹配锁定模型 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runAiProbe({
      deployPath,
      apiKey: API_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify({ model: "other-model", validated: true, tags: ["a"], description: null, errorType: null, passed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("HTTP 非 200 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runAiProbe({ deployPath, apiKey: API_KEY, fetchImpl: async () => new Response("err", { status: 500 }) });
    expect(res).toMatchObject({ passed: false });
  });
});

type ResumeEvent = { kind: string; attempt: number; requested_delay_seconds: number | null; occurred_at: string };
type MockAudit = {
  invocationId: string;
  scheduledAt: string;
  selectedCount: number;
  sentCount: number;
  failedCount: number;
  jobs: { jobId: string; sendResult: string; sendDelaySeconds: number | null; errorCode?: string }[];
};

/** mock spawn：按 SQL 内容返回模拟 D1 结果。 */
function mockResumeSpawn({ events, jobStatus = "dead", tagging = "failure", invocations, audits }: {
  events: ResumeEvent[];
  jobStatus?: string;
  tagging?: string;
  invocations: { invocation_id: string }[];
  audits: Record<string, MockAudit>;
}) {
  return (cmd: string, args: string[]) => {
    const sql = String(args[args.length - 1] ?? "");
    let results: unknown[] = [];
    if (sql.includes("queue_probe_events")) {
      results = events;
    } else if (sql.includes("SELECT status FROM enrichment_jobs")) {
      results = [{ status: jobStatus }];
    } else if (sql.includes("tagging_status")) {
      results = [{ tagging_status: tagging }];
    } else if (sql.includes("SELECT invocation_id FROM cron_invocations")) {
      results = invocations;
            } else if (sql.includes("FROM cron_invocations i")) {
      const m = /invocation_id = '([^']+)'/.exec(sql);
      const audit = m ? audits[m[1]] : undefined;
      results = audit
        ? [
            { invocation_id: audit.invocationId, scheduled_at: audit.scheduledAt, selected_count: audit.selectedCount, sent_count: audit.sentCount, failed_count: audit.failedCount, job_id: null, send_result: null, send_delay_seconds: null, error_code: null },
            ...audit.jobs.map((j: MockAudit["jobs"][number]) => ({ invocation_id: audit.invocationId, scheduled_at: audit.scheduledAt, selected_count: audit.sentCount + audit.failedCount, sent_count: audit.sentCount, failed_count: audit.failedCount, job_id: j.jobId, send_result: j.sendResult, send_delay_seconds: j.sendDelaySeconds, error_code: j.errorCode ?? null })),
          ]
        : [];
    }
    return { stdout: JSON.stringify([{ results }]), status: 0, stderr: "" };
  };
}

const RETRY_EVENTS = [
  { kind: "consumer_retry", attempt: 1, requested_delay_seconds: 30, occurred_at: "2026-09-03T08:33:51.261Z" },
  { kind: "consumer_retry", attempt: 2, requested_delay_seconds: 300, occurred_at: "2026-09-03T08:34:21.909Z" },
  { kind: "consumer_retry", attempt: 3, requested_delay_seconds: 1800, occurred_at: "2026-09-03T08:39:23.211Z" },
  { kind: "consumer_failed", attempt: 4, requested_delay_seconds: null, occurred_at: "2026-09-03T09:09:24.148Z" },
  { kind: "dlq_received", attempt: 1, requested_delay_seconds: null, occurred_at: "2026-09-03T09:09:27.589Z" },
];

const FAIL_JOB_ID = "eda03f53-ce75-4646-99e5-e797c6098885";

describe("runResume 证据组装", () => {
  it("完整证据 → passed:true 且 resumed 记录 job id", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const spawn = mockResumeSpawn({
      events: RETRY_EVENTS,
      invocations: [{ invocation_id: "i2" }, { invocation_id: "i1" }],
      audits: {
        i1: {
          invocationId: "i1",
          scheduledAt: "2026-09-03T09:00:26.400Z",
          selectedCount: 10,
          sentCount: 9,
          failedCount: 1,
          jobs: [{ jobId: FAIL_JOB_ID, sendResult: "failed", sendDelaySeconds: 86401, errorCode: "10210" }],
        },
        i2: {
          invocationId: "i2",
          scheduledAt: "2026-09-03T10:00:26.400Z",
          selectedCount: 10,
          sentCount: 10,
          failedCount: 0,
          jobs: [{ jobId: FAIL_JOB_ID, sendResult: "sent", sendDelaySeconds: null }],
        },
      },
    });
    const res = await runResume({
      deployPath,
      apiKey: API_KEY,
      jobId: "a1d3b38e-07d0-4583-970d-86947066ee8f",
      failJobId: FAIL_JOB_ID,
      spawn,
      awaitSecondMs: 100,
    });
    expect(res.passed).toBe(true);
    expect(res.checks.retryDlq).toMatchObject({ attempts: [1, 2, 3, 4], requestedDelays: [30, 300, 1800], finalJobStatus: "dead", finalTaggingStatus: "failure", dlqReceived: true });
    const cronChecks = res.checks.cron as { invalidDelayRejected?: boolean; nextCronSentWithoutOptions?: boolean };
    expect(cronChecks.invalidDelayRejected ?? res.checks.invalidDelayRejected).toBe(true);
    const cronChecks2 = res.checks.cron as { nextCronSentWithoutOptions?: boolean };
    expect(cronChecks2.nextCronSentWithoutOptions ?? res.checks.nextCronSentWithoutOptions).toBe(true);
    expect(res.resumed).toEqual({ jobId: "a1d3b38e-07d0-4583-970d-86947066ee8f", failJobId: FAIL_JOB_ID });
  });

  it("第一周期未找到 fail failed+86401 → 抛错", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const spawn = mockResumeSpawn({
      events: RETRY_EVENTS,
      invocations: [{ invocation_id: "i1" }],
      audits: {
        i1: {
          invocationId: "i1",
          scheduledAt: "2026-09-03T09:00:26.400Z",
          selectedCount: 10,
          sentCount: 10,
          failedCount: 0,
          jobs: [{ jobId: FAIL_JOB_ID, sendResult: "sent", sendDelaySeconds: null }],
        },
      },
    });
    await expect(
      runResume({ deployPath, apiKey: API_KEY, jobId: "a1d3b38e", failJobId: FAIL_JOB_ID, spawn, awaitSecondMs: 100 }),
    ).rejects.toThrow("CRON_FIRST_AUDIT_NOT_FOUND");
  });

  it("第二周期超时 → 抛错", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const spawn = mockResumeSpawn({
      events: RETRY_EVENTS,
      invocations: [{ invocation_id: "i1" }],
      audits: {
        i1: {
          invocationId: "i1",
          scheduledAt: "2026-09-03T09:00:26.400Z",
          selectedCount: 10,
          sentCount: 9,
          failedCount: 1,
          jobs: [{ jobId: FAIL_JOB_ID, sendResult: "failed", sendDelaySeconds: 86401, errorCode: "10210" }],
        },
      },
    });
    await expect(
      runResume({ deployPath, apiKey: API_KEY, jobId: "a1d3b38e", failJobId: FAIL_JOB_ID, spawn, awaitSecondMs: 100 }),
    ).rejects.toThrow("CRON_SECOND_AUDIT_TIMEOUT");
  });

  it("attempts 缺失 dlq → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const spawn = mockResumeSpawn({
      events: RETRY_EVENTS.slice(0, 3),
      invocations: [{ invocation_id: "i2" }, { invocation_id: "i1" }],
      audits: {
        i1: {
          invocationId: "i1",
          scheduledAt: "2026-09-03T09:00:26.400Z",
          selectedCount: 10,
          sentCount: 9,
          failedCount: 1,
          jobs: [{ jobId: FAIL_JOB_ID, sendResult: "failed", sendDelaySeconds: 86401, errorCode: "10210" }],
        },
        i2: {
          invocationId: "i2",
          scheduledAt: "2026-09-03T10:00:26.400Z",
          selectedCount: 10,
          sentCount: 10,
          failedCount: 0,
          jobs: [{ jobId: FAIL_JOB_ID, sendResult: "sent", sendDelaySeconds: null }],
        },
      },
    });
    const res = await runResume({
      deployPath,
      apiKey: API_KEY,
      jobId: "a1d3b38e",
      failJobId: FAIL_JOB_ID,
      spawn,
      awaitSecondMs: 100,
    });
    expect(res.passed).toBe(false);
    const retryChecks = res.checks.retryDlq as { timedOut?: boolean };
    expect(retryChecks.timedOut).toBe(true);
  });
});

describe("runQueue 失败安全", () => {
  it("poll 永不达 DLQ → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runQueue({
      deployPath,
      apiKey: API_KEY,
      poll: async () => ({
        attempts: [1, 2],
        requestedDelays: [30],
        actualGaps: [30],
        finalJobStatus: "pending",
        finalTaggingStatus: "pending",
        dlqReceived: false,
      }),
      cronAudit: { selectedCount: 3, sentCount: 3, failedCount: 0, invocationId: "i1", scheduledAt: "2026-09-03T05:00:00Z", jobs: [] },
      secondCron: { selectedCount: 3, sentCount: 3, failedCount: 0, invocationId: "i2", scheduledAt: "2026-09-03T06:00:00Z", jobs: [] },
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("cronAudit selectedCount 11 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runQueue({
      deployPath,
      apiKey: API_KEY,
      poll: async () => ({
        attempts: [1, 2, 3, 4],
        requestedDelays: [30, 300, 1800],
        actualGaps: [30, 300, 1800],
        finalJobStatus: "dead",
        finalTaggingStatus: "failure",
        dlqReceived: true,
      }),
      cronAudit: { selectedCount: 11, sentCount: 10, failedCount: 1, invocationId: "i1", scheduledAt: "2026-09-03T05:00:00Z", jobs: [] },
      secondCron: { selectedCount: 3, sentCount: 3, failedCount: 0, invocationId: "i2", scheduledAt: "2026-09-03T06:00:00Z", jobs: [] },
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("cronAudit 恒等式不成立 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runQueue({
      deployPath,
      apiKey: API_KEY,
      poll: async () => ({
        attempts: [1, 2, 3, 4],
        requestedDelays: [30, 300, 1800],
        actualGaps: [30, 300, 1800],
        finalJobStatus: "dead",
        finalTaggingStatus: "failure",
        dlqReceived: true,
      }),
      cronAudit: { selectedCount: 5, sentCount: 3, failedCount: 1, invocationId: "i1", scheduledAt: "2026-09-03T05:00:00Z", jobs: [] },
      secondCron: { selectedCount: 3, sentCount: 3, failedCount: 0, invocationId: "i2", scheduledAt: "2026-09-03T06:00:00Z", jobs: [] },
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("secondCron sendDelaySeconds 86401 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-probes.json", PROBES);
    const res = await runQueue({
      deployPath,
      apiKey: API_KEY,
      poll: async () => ({
        attempts: [1, 2, 3, 4],
        requestedDelays: [30, 300, 1800],
        actualGaps: [30, 300, 1800],
        finalJobStatus: "dead",
        finalTaggingStatus: "failure",
        dlqReceived: true,
      }),
      cronAudit: { selectedCount: 3, sentCount: 3, failedCount: 0, invocationId: "i1", scheduledAt: "2026-09-03T05:00:00Z", jobs: [] },
      secondCron: { selectedCount: 3, sentCount: 3, failedCount: 0, invocationId: "i2", scheduledAt: "2026-09-03T06:00:00Z", jobs: [{ jobId: "j", sendResult: "sent", sendDelaySeconds: 86401, errorCode: null }] },
    });
    expect(res).toMatchObject({ passed: false });
  });
});

const CPU_SPAWN = () => ({
  stdout: JSON.stringify({ id: "cpu-deploy-1", versions: [{ version_id: "cpu-version-1" }] }),
  status: 0,
});

describe("runCpu 失败安全", () => {
  it("GraphQL 无数据 → {passed:false, reason:no_cpu_data}", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu", deploymentId: "cpu-deploy-1", versionIds: ["cpu-version-1"] });
    const res = await runCpu({
      deployPath,
      graphql: async () => ({ rows: [] }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
      spawn: CPU_SPAWN,
    });
    expect(res).toMatchObject({ passed: false, reason: "no_cpu_data" });
  });

  it("GraphQL 权限不足 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu", deploymentId: "cpu-deploy-1", versionIds: ["cpu-version-1"] });
    const res = await runCpu({
      deployPath,
      graphql: async () => {
        throw new Error("GRAPHQL_FORBIDDEN");
      },
      fetchImpl: async () => new Response("{}", { status: 200 }),
      spawn: CPU_SPAWN,
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("requests<1000 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu", deploymentId: "cpu-deploy-1", versionIds: ["cpu-version-1"] });
    const res = await runCpu({
      deployPath,
      graphql: async () => ({ rows: [{ requests: 999, errors: 0, cpuTimeP50: 50, cpuTimeP99: 100 }] }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
      spawn: CPU_SPAWN,
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("errors>0 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu", deploymentId: "cpu-deploy-1", versionIds: ["cpu-version-1"] });
    const res = await runCpu({
      deployPath,
      graphql: async () => ({ rows: [{ requests: 1000, errors: 1, cpuTimeP50: 50, cpuTimeP99: 100 }] }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
      spawn: CPU_SPAWN,
    });
    expect(res).toMatchObject({ passed: false });
  });

  it("cpuTimeP99>=8000 → passed:false", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu", deploymentId: "cpu-deploy-1", versionIds: ["cpu-version-1"] });
    const res = await runCpu({
      deployPath,
      graphql: async () => ({ rows: [{ requests: 1000, errors: 0, cpuTimeP50: 50, cpuTimeP99: 8000 }] }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
      spawn: CPU_SPAWN,
    });
    expect(res).toMatchObject({ passed: false });
  });
});

describe("loadDeployArtifact 失败安全", () => {
  it("缺失文件 → 抛错", () => {
    expect(() => loadDeployArtifact("/nonexistent.json", "probes")).toThrow();
  });

  it("passed:false → 抛错", () => {
    const dir = tmpDir();
    const p = writeArtifact(dir, "a.json", { ...PROBES, passed: false });
    expect(() => loadDeployArtifact(p, "probes")).toThrow("DEPLOY_NOT_PASSED");
  });

  it("profile 不匹配 → 抛错", () => {
    const dir = tmpDir();
    const p = writeArtifact(dir, "a.json", { ...PROBES, profile: "cpu" });
    expect(() => loadDeployArtifact(p, "probes")).toThrow("DEPLOY_PROFILE_MISMATCH");
  });

  it("versionIds 未排序 → 抛错", () => {
    const dir = tmpDir();
    const p = writeArtifact(dir, "a.json", { ...PROBES, versionIds: ["b", "a"] });
    expect(() => loadDeployArtifact(p, "probes")).toThrow("VERSION_IDS_NOT_SORTED");
  });

  it("缺五字段 → 抛错", () => {
    const dir = tmpDir();
    const p = writeArtifact(dir, "a.json", { profile: "probes", passed: true });
    expect(() => loadDeployArtifact(p, "probes")).toThrow();
  });
});

describe("loadApiKey 失败安全", () => {
  it(".dev.vars 非 0600 → 抛错", () => {
    const dir = tmpDir();
    const p = join(dir, ".dev.vars");
    writeFileSync(p, `PHASE0_API_KEY=${API_KEY}\n`);
    chmodSync(p, 0o644);
    expect(() => loadApiKey(p)).toThrow("DEV_VARS_MODE_NOT_0600");
  });

  it("key 格式非法 → 抛错", () => {
    const dir = tmpDir();
    const p = join(dir, ".dev.vars");
    writeFileSync(p, "PHASE0_API_KEY=ak2_short\n");
    chmodSync(p, 0o600);
    expect(() => loadApiKey(p)).toThrow("PHASE0_API_KEY_FORMAT_INVALID");
  });

  it("缺 PHASE0_API_KEY → 抛错", () => {
    const dir = tmpDir();
    const p = join(dir, ".dev.vars");
    writeFileSync(p, "OTHER=1\n");
    chmodSync(p, 0o600);
    expect(() => loadApiKey(p)).toThrow("PHASE0_API_KEY_MISSING");
  });
});

describe("assertNoDrift 失败安全", () => {
  it("deploymentId 漂移 → 抛错", () => {
    const dir = tmpDir();
    const p = writeArtifact(dir, "a.json", PROBES);
    const artifact = loadDeployArtifact(p, "probes");
    expect(() =>
      assertNoDrift(
        () => ({ stdout: JSON.stringify({ id: "other", versions: [{ version_id: "50d98bfb-70a1-4ef2-95ea-d939b01acf01" }] }), status: 0 }),
        artifact,
        "START",
      ),
    ).toThrow("DEPLOYMENT_DRIFT");
  });

  it("versionIds 漂移 → 抛错", () => {
    const dir = tmpDir();
    const p = writeArtifact(dir, "a.json", PROBES);
    const artifact = loadDeployArtifact(p, "probes");
    expect(() =>
      assertNoDrift(
        () => ({ stdout: JSON.stringify({ id: "28d1e022-d7f6-4e3a-b477-0db20cc06d7d", versions: [{ version_id: "other" }] }), status: 0 }),
        artifact,
        "START",
      ),
    ).toThrow("VERSION_DRIFT");
  });
});

describe("runFreeLimit 失败安全", () => {
  it("deploy-cpu.json 缺失 → 抛错", async () => {
    await expect(
      runFreeLimit({
        deployPath: "/nonexistent/deploy-cpu.json",
        cpuRunPath: "/tmp/x.json",
        queueInvocationsPath: "/tmp/y.json",
        cpuPath: "/tmp/z.json",
        cleanupOut: "/tmp/cleanup.json",
        out: "/tmp/free-limit.json",
      }),
    ).rejects.toThrow();
  });

  it("finally 无条件调用 cleanup（主流程抛错也调用）", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu" });
    let cleanupCalled = false;
    const res = await runFreeLimit({
      deployPath,
      cpuRunPath: join(dir, "cpu-invocation-run.json"),
      queueInvocationsPath: join(dir, "queue-invocations.json"),
      cpuPath: join(dir, "cpu.json"),
      cleanupOut: join(dir, "deploy-cleanup.json"),
      out: join(dir, "free-limit.json"),
      handoffPath: join(dir, "handoff"),
      cleanup: async () => {
        cleanupCalled = true;
        return { passed: true };
      },
      fetchImpl: async () => new Response("1102", { status: 1102 }),
      telemetry: async () => ({ events: [] }),
    });
    expect(cleanupCalled).toBe(true);
    expect(res).toMatchObject({ passed: false });
  });

  it("secret 明文不得进入 argv/stdout", async () => {
    const dir = tmpDir();
    const deployPath = writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu" });
    const secret = "s".repeat(64);
    const handoffPath = join(dir, "handoff");
    writeFileSync(handoffPath, JSON.stringify({ secret, pathSegment: "seg", sessionNonce: "nonce" }));
    chmodSync(handoffPath, 0o600);
    const argvSeen: string[] = [];
    const res = await runFreeLimit({
      deployPath,
      cpuRunPath: join(dir, "cpu-invocation-run.json"),
      queueInvocationsPath: join(dir, "queue-invocations.json"),
      cpuPath: join(dir, "cpu.json"),
      cleanupOut: join(dir, "deploy-cleanup.json"),
      out: join(dir, "free-limit.json"),
      handoffPath,
      cleanup: async (argv) => {
        argvSeen.push(...argv);
        return { passed: true };
      },
      fetchImpl: async () => new Response("1102", { status: 1102 }),
      telemetry: async () => ({ events: [] }),
    });
    expect(argvSeen.join(" ")).not.toContain(secret);
    expect(res).toMatchObject({ passed: false });
  });
});

describe("verifyArtifacts 失败安全", () => {
  it("跨 profile 拼接 → passed:false", async () => {
    const dir = tmpDir();
    const res = await verifyArtifacts({
      regularOnly: true,
      artifactsDir: dir,
      deployProbesPath: writeArtifact(dir, "deploy-probes.json", PROBES),
      deployCpuPath: writeArtifact(dir, "deploy-cpu.json", { ...PROBES, profile: "cpu" }),
      remoteContractPath: writeArtifact(dir, "remote-contract.json", { ...PROBES, passed: true }),
      aiPath: writeArtifact(dir, "ai.json", { ...PROBES, passed: true }),
      queuePath: writeArtifact(dir, "queue.json", { ...PROBES, passed: true }),
      cpuInvocationRunPath: writeArtifact(dir, "cpu-invocation-run.json", { ...PROBES, profile: "cpu", passed: true }),
      queueInvocationsPath: writeArtifact(dir, "queue-invocations.json", { ...PROBES, profile: "cpu", passed: true }),
      cpuPath: writeArtifact(dir, "cpu.json", { ...PROBES, profile: "cpu", passed: true }),
    });
    expect(res).toMatchObject({ passed: false });
  });
});
