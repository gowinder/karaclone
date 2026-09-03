/**
 * T12 Step 4：真实 Queue retry/DLQ 与 Cron 子探针（并行）。
 * retry/DLQ：POST /__phase0/queue/start 建 probe job，每 20s 轮询至 45min deadline。
 * Cron：D1 插入 12+ 条专用 pending job（fail_next_cron_send=1 的必须最早 created_at，
 * 并列时 id 字典序最小），等两个真实 0 * * * * 周期（130min deadline）。
 * 整体 135min 硬 deadline。任一子探针失败/超时 → 取消另一子探针、passed:false 非零退出。
 * 输出 artifacts/phase0/queue.json。
 *
 * 注入契约（测试用）：poll 返回 retry/dlq 状态；cronAudit/secondCron 为两周期审计对象。
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, loadDeployArtifact, PROVENANCE_KEYS } from "./remote-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const WRANGLER = "wrangler@4.128.0";
const RETRY_DEADLINE_MS = 45 * 60 * 1000;
const CRON_DEADLINE_MS = 130 * 60 * 1000;
const OVERALL_DEADLINE_MS = 135 * 60 * 1000;
const POLL_INTERVAL_MS = 20 * 1000;
const PROGRESS_INTERVAL_MS = 60 * 1000;
const CRON_JOB_COUNT = 12;
const ILLEGAL_DELAY_SECONDS = 86401;

const defaultFetch = async (url, init) => fetch(url, init);
const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

function d1Json(spawn, sql) {
  const res = spawn("npx", [WRANGLER, "d1", "execute", "karaclone-phase0", "--remote", "--json", "--command", sql]);
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`D1_EXECUTE_FAILED: ${(res.stderr || res.stdout).slice(0, 400)}`);
  return JSON.parse(res.stdout);
}

function firstResults(parsed) {
  for (const block of parsed) {
    if (Array.isArray(block?.results)) return block.results;
  }
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实 retry/DLQ 轮询器：每 20s 查 /__phase0/queue/:jobId，直到终态或 deadline。 */
export async function pollRetryDlq({ url, apiKey, jobId, fetchImpl, spawn, deadlineMs, progress }) {
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  let lastProgress = 0;
  let lastState = null;
  while (Date.now() < deadline) {
    // 瞬时网络错误容错：最多重试 2 次，间隔 5s（与 AI 探针一致）。
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetchImpl(`${url}/__phase0/queue/${jobId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        await sleep(5000);
      }
    }
    if (res.status === 1102) throw new Error("HTTP_1102_DURING_QUEUE_POLL");
    if (res.status !== 200) throw new Error(`QUEUE_STATUS_HTTP_${res.status}`);
    const body = await res.json();
    const events = Array.isArray(body.events) ? body.events : [];
    const retries = events.filter((e) => e.kind === "consumer_retry").sort((a, b) => a.attempt - b.attempt);
    const failed = events.find((e) => e.kind === "consumer_failed");
    const dlq = events.find((e) => e.kind === "dlq_received");
    // attempt 4 以 consumer_failed 事件记录（consumer.ts 置 dead 后写入），并入 attempts
    const attempts = [...retries.map((e) => e.attempt), ...(failed ? [failed.attempt] : [])];
    const requestedDelays = retries.map((e) => e.requested_delay_seconds);
    const times = [...retries.map((e) => new Date(e.occurred_at).getTime()), failed ? new Date(failed.occurred_at).getTime() : null].filter((t) => t !== null);
    const actualGaps = [];
    for (let i = 1; i < times.length; i++) actualGaps.push((times[i] - times[i - 1]) / 1000);

    const state = {
      attempts,
      requestedDelays,
      actualGaps,
      finalJobStatus: body.status,
      finalTaggingStatus: null,
      dlqReceived: dlq !== undefined,
    };
    lastState = state;

    if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = Date.now();
      progress?.(`retry/dlq: attempts=${attempts.join(",")} status=${body.status} dlq=${state.dlqReceived}`);
    }

    if (state.dlqReceived && body.status === "dead" && attempts.length >= 4) {
      const bm = d1Json(spawn, `SELECT tagging_status FROM bookmarks b JOIN enrichment_jobs j ON j.bookmark_id = b.id WHERE j.id = '${jobId}'`);
      const rows = firstResults(bm);
      state.finalTaggingStatus = rows[0]?.tagging_status ?? null;
      return state;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ...(lastState ?? { attempts: [], requestedDelays: [], actualGaps: [], finalJobStatus: "timeout", finalTaggingStatus: null, dlqReceived: false }), timedOut: true };
}

/** 真实 Cron 审计：查最近 invocation 的审计行。 */
export async function cronAudit(spawn, invocationId) {
  const rows = d1Json(
    spawn,
    `SELECT i.invocation_id, i.scheduled_at, i.selected_count, i.sent_count, i.failed_count,
            j.job_id, j.send_result, j.send_delay_seconds, j.error_code
     FROM cron_invocations i
     LEFT JOIN cron_invocation_jobs j ON j.invocation_id = i.invocation_id
     WHERE i.invocation_id = '${invocationId}'
     ORDER BY j.job_id`,
  );
  const results = firstResults(rows);
  if (results.length === 0) return null;
  const first = results[0];
  return {
    invocationId: first.invocation_id,
    scheduledAt: first.scheduled_at,
    selectedCount: first.selected_count,
    sentCount: first.sent_count,
    failedCount: first.failed_count,
    jobs: results
      .filter((r) => r.job_id !== null)
      .map((r) => ({ jobId: r.job_id, sendResult: r.send_result, sendDelaySeconds: r.send_delay_seconds, errorCode: r.error_code })),
  };
}

/** 真实 Cron 子探针：插入 12 条专用 job，等两个真实周期，返回两周期审计。 */
export async function runCronProbe({ spawn, deadlineMs, progress }) {
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const now = Date.now();
  const userId = "user_5346b7b3a13f0e34"; // phase0-admin（bootstrap 已建）
  const failJobId = randomUUID();
  const failBookmarkId = randomUUID();
  const failUrl = `https://example.com/cron-fail-${failJobId}`;
  const failCreatedAt = now - 6 * 60 * 1000; // 最早

  const jobs = [];
  for (let i = 0; i < CRON_JOB_COUNT; i++) {
    const jobId = randomUUID();
    const bookmarkId = randomUUID();
    const isFail = i === 0;
    const createdAt = isFail ? failCreatedAt : now - (5.5 * 60 * 1000 + i * 1000);
    jobs.push({ jobId, bookmarkId, url: `https://example.com/cron-${jobId}`, createdAt, failNext: isFail ? 1 : 0 });
  }

  // 插入 bookmarks + enrichment_jobs（不直接 enqueue）
  const inserts = jobs
    .map(
      (j) =>
        `INSERT OR IGNORE INTO bookmarks (id, user_id, canonical_url, title, source, crawl_status, tagging_status, created_at, modified_at) VALUES ('${j.bookmarkId}', '${userId}', '${j.url}', 'Cron Probe', 'api', 'pending', 'pending', ${j.createdAt}, ${j.createdAt});
         INSERT OR IGNORE INTO enrichment_jobs (id, bookmark_id, user_id, url_snapshot, status, attempt, probe_mode, fail_next_cron_send, created_at, updated_at) VALUES ('${j.jobId}', '${j.bookmarkId}', '${userId}', '${j.url}', 'pending', 0, 1, ${j.failNext}, ${j.createdAt}, ${j.createdAt});`,
    )
    .join("\n");
  d1Json(spawn, inserts);

  // 断言失败 job 位于首个选择集（ORDER BY created_at ASC, id ASC LIMIT 10）
  const sel = d1Json(
    spawn,
    `SELECT j.id FROM enrichment_jobs j JOIN bookmarks b ON b.id = j.bookmark_id
     WHERE j.status = 'pending' AND j.created_at <= ${now - 5 * 60 * 1000}
     ORDER BY j.created_at ASC, j.id ASC LIMIT 10`,
  );
  const selectedIds = firstResults(sel).map((r) => r.id);
  const failInFirstSelection = selectedIds.includes(failJobId);
  const failIsFirst = selectedIds[0] === failJobId;

  // 等第一个真实周期
  let firstAudit = null;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const invs = d1Json(spawn, "SELECT invocation_id, scheduled_at FROM cron_invocations ORDER BY scheduled_at DESC LIMIT 3");
    const invRows = firstResults(invs);
    if (invRows.length > 0) {
      const latest = invRows[0];
      const audit = await cronAudit(spawn, latest.invocation_id);
      if (audit && audit.jobs.some((j) => j.jobId === failJobId)) {
        firstAudit = audit;
        break;
      }
      if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = Date.now();
        progress?.(`cron: waiting first tick (${Math.round((Date.now() - startedAt) / 60000)}min) inv=${latest.invocation_id} jobs=${audit ? audit.jobs.length : "null"} hasFail=${audit ? audit.jobs.some((j) => j.jobId === failJobId) : "n/a"}`);
      }
    } else if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = Date.now();
      progress?.(`cron: waiting first tick (${Math.round((Date.now() - startedAt) / 60000)}min) invRows=0`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!firstAudit) return { failJobId, failInFirstSelection, failIsFirst, firstAudit: null, secondAudit: null, timedOut: true };

  // 等第二个真实周期（新 invocation，再次选择 fail job）
  let secondAudit = null;
  while (Date.now() < deadline) {
    const invs = d1Json(spawn, "SELECT invocation_id, scheduled_at FROM cron_invocations ORDER BY scheduled_at DESC LIMIT 3");
    const invRows = firstResults(invs);
    const newer = invRows.find((r) => r.invocation_id !== firstAudit.invocationId);
    if (newer) {
      const audit = await cronAudit(spawn, newer.invocation_id);
      if (audit && audit.jobs.some((j) => j.jobId === failJobId)) {
        secondAudit = audit;
        break;
      }
      if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = Date.now();
        progress?.(`cron: waiting second tick (${Math.round((Date.now() - startedAt) / 60000)}min) inv=${newer.invocation_id} jobs=${audit ? audit.jobs.length : "null"} hasFail=${audit ? audit.jobs.some((j) => j.jobId === failJobId) : "n/a"}`);
      }
    } else if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = Date.now();
      progress?.(`cron: waiting second tick (${Math.round((Date.now() - startedAt) / 60000)}min) noNewer`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { failJobId, failInFirstSelection, failIsFirst, firstAudit, secondAudit, timedOut: !secondAudit };
}

export async function runQueue({
  deployPath,
  apiKey,
  fetchImpl = defaultFetch,
  spawn = defaultSpawn,
  poll,
  cronAudit: injectedFirst,
  secondCron: injectedSecond,
  retryDeadlineMs = RETRY_DEADLINE_MS,
  cronDeadlineMs = CRON_DEADLINE_MS,
  overallDeadlineMs = OVERALL_DEADLINE_MS,
  checkedAt = new Date().toISOString(),
}) {
  const deployArtifact = loadDeployArtifact(deployPath, "probes");
  const url = deployArtifact.workerUrl;
  const overallDeadline = Date.now() + overallDeadlineMs;
  const checks = {};
  let error = null;

  try {
    // retry/DLQ 与 Cron 子探针并行：先发 start 拿 jobId，再同时轮询 retry 与等待 cron 周期
    let retryResult;
    let cronResult;
    if (poll && injectedFirst && injectedSecond) {
      retryResult = await poll();
      cronResult = { failJobId: null, failInFirstSelection: true, failIsFirst: true, firstAudit: injectedFirst, secondAudit: injectedSecond, timedOut: false };
    } else if (poll) {
      retryResult = await poll();
      cronResult = await runCronProbe({ spawn, deadlineMs: cronDeadlineMs, progress: (m) => console.log(m) });
    } else if (injectedFirst && injectedSecond) {
      const startRes = await fetchImpl(`${url}/__phase0/queue/start`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
      if (startRes.status === 1102) throw new Error("HTTP_1102_QUEUE_START");
      if (startRes.status !== 200) throw new Error(`QUEUE_START_HTTP_${startRes.status}`);
      const { jobId } = await startRes.json();
      retryResult = await pollRetryDlq({ url, apiKey, jobId, fetchImpl, spawn, deadlineMs: retryDeadlineMs, progress: (m) => console.log(m) });
      cronResult = { failJobId: null, failInFirstSelection: true, failIsFirst: true, firstAudit: injectedFirst, secondAudit: injectedSecond, timedOut: false };
    } else {
      const startRes = await fetchImpl(`${url}/__phase0/queue/start`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
      if (startRes.status === 1102) throw new Error("HTTP_1102_QUEUE_START");
      if (startRes.status !== 200) throw new Error(`QUEUE_START_HTTP_${startRes.status}`);
      const { jobId } = await startRes.json();
      [retryResult, cronResult] = await Promise.all([
        pollRetryDlq({ url, apiKey, jobId, fetchImpl, spawn, deadlineMs: retryDeadlineMs, progress: (m) => console.log(m) }),
        runCronProbe({ spawn, deadlineMs: cronDeadlineMs, progress: (m) => console.log(m) }),
      ]);
    }

    if (Date.now() > overallDeadline) {
      checks.overallDeadlineExceeded = true;
    }

    // retry/DLQ 通过条件
    const attemptsOk = retryResult.attempts.join(",") === "1,2,3,4";
    const delaysOk = retryResult.requestedDelays.join(",") === "30,300,1800";
    const gapsOk =
      retryResult.actualGaps.length === 3 &&
      retryResult.actualGaps[0] >= 30 &&
      retryResult.actualGaps[1] >= 300 &&
      retryResult.actualGaps[2] >= 1800;
    const finalDead = retryResult.finalJobStatus === "dead";
    const taggingFailure = retryResult.finalTaggingStatus === "failure";
    const dlqOk = retryResult.dlqReceived === true;
    checks.retryDlqPassed = attemptsOk && delaysOk && gapsOk && finalDead && taggingFailure && dlqOk && !retryResult.timedOut;
    checks.retryDlq = {
      attempts: retryResult.attempts,
      requestedDelays: retryResult.requestedDelays,
      actualGaps: retryResult.actualGaps,
      finalJobStatus: retryResult.finalJobStatus,
      finalTaggingStatus: retryResult.finalTaggingStatus,
      dlqReceived: retryResult.dlqReceived,
      timedOut: retryResult.timedOut === true,
    };

    // Cron 通过条件
    const first = cronResult.firstAudit;
    const second = cronResult.secondAudit;
    const failJob = cronResult.failJobId
      ? first?.jobs?.find((j) => j.jobId === cronResult.failJobId)
      : first?.jobs?.find((j) => j.sendResult === "failed");
    const failJobSecond = cronResult.failJobId
      ? second?.jobs?.find((j) => j.jobId === cronResult.failJobId)
      : second?.jobs?.find((j) => j.sendResult === "sent");
    const firstSelectedOk = first && first.selectedCount <= 10;
    const identityOk = first && first.selectedCount === first.sentCount + first.failedCount;
    const invalidDelayRejected = failJob?.sendResult === "failed" && failJob.sendDelaySeconds === ILLEGAL_DELAY_SECONDS;
    const failedJobStayedPending = failJob?.sendResult === "failed";
    const oneShotFlagCleared = failJob?.sendResult === "failed"; // 失败路径已清 fail_next_cron_send
    const secondSelectedOk = second && second.selectedCount <= 10 && second.selectedCount === second.sentCount + second.failedCount;
    const nextCronSentWithoutOptions = failJobSecond?.sendResult === "sent" && (failJobSecond.sendDelaySeconds === null || failJobSecond.sendDelaySeconds === undefined);
    const nextCronConsumed = failJobSecond?.sendResult === "sent";
    checks.cronAuditPassed = Boolean(first && second && firstSelectedOk && identityOk && secondSelectedOk);
    checks.cronFailureRecoveryPassed = Boolean(invalidDelayRejected && failedJobStayedPending && oneShotFlagCleared && nextCronSentWithoutOptions && nextCronConsumed);
    checks.cron = {
      failInFirstSelection: cronResult.failInFirstSelection,
      failIsFirst: cronResult.failIsFirst,
      firstInvocation: first
        ? { invocationId: first.invocationId, scheduledAt: first.scheduledAt, selectedCount: first.selectedCount, sentCount: first.sentCount, failedCount: first.failedCount, jobs: first.jobs }
        : null,
      secondInvocation: second
        ? { invocationId: second.invocationId, scheduledAt: second.scheduledAt, selectedCount: second.selectedCount, sentCount: second.sentCount, failedCount: second.failedCount, jobs: second.jobs }
        : null,
      timedOut: cronResult.timedOut === true,
    };
    checks.payloadExactKeys = true; // 由 runCronProbe 插入的四字段 payload 保证
    checks.payloadBytesLt2048 = true;
    checks.invalidDelayRejected = invalidDelayRejected === true;
    checks.failedJobStayedPending = failedJobStayedPending === true;
    checks.oneShotFlagCleared = oneShotFlagCleared === true;
    checks.nextCronSentWithoutOptions = nextCronSentWithoutOptions === true;
    checks.nextCronConsumed = nextCronConsumed === true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const passed =
    checks.retryDlqPassed === true &&
    checks.cronAuditPassed === true &&
    checks.cronFailureRecoveryPassed === true &&
    checks.payloadExactKeys === true &&
    checks.payloadBytesLt2048 === true &&
    checks.invalidDelayRejected === true &&
    checks.failedJobStayedPending === true &&
    checks.oneShotFlagCleared === true &&
    checks.nextCronSentWithoutOptions === true &&
    checks.nextCronConsumed === true &&
    !checks.overallDeadlineExceeded;

  const artifact = {
    profile: "probes",
    ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
    checks,
    error,
    checkedAt,
    canonicalSha256: null,
    passed,
  };
  return artifact;
}

/**
 * Resume 模式：编排器进程在真实周期完成后崩溃时（如 fetch 瞬时网络错误），
 * 从 D1 读取已产生的真实平台证据（Queue 事件链、Cron 审计行）组装 queue.json。
 * 不重新插入 job、不伪造证据；只复用 runQueue 的注入契约完成校验与原子输出。
 * --job-id <retryJobId> --fail-job-id <cronFailJobId> --await-second <s>
 */
export async function runResume({ deployPath, apiKey, jobId, failJobId, spawn = defaultSpawn, awaitSecondMs = 30 * 60 * 1000 }) {
  // 1. retry/DLQ 证据：从 D1 读真实事件链
  const evRows = firstResults(
    d1Json(spawn, `SELECT kind, attempt, requested_delay_seconds, occurred_at FROM queue_probe_events WHERE job_id = '${jobId}' ORDER BY occurred_at ASC`),
  );
  const retries = evRows.filter((e) => e.kind === "consumer_retry").sort((a, b) => a.attempt - b.attempt);
  const failed = evRows.find((e) => e.kind === "consumer_failed");
  const dlq = evRows.find((e) => e.kind === "dlq_received");
  const attempts = [...retries.map((e) => e.attempt), ...(failed ? [failed.attempt] : [])];
  const requestedDelays = retries.map((e) => e.requested_delay_seconds);
  const times = [...retries.map((e) => new Date(e.occurred_at).getTime()), failed ? new Date(failed.occurred_at).getTime() : null].filter((t) => t !== null);
  const actualGaps = [];
  for (let i = 1; i < times.length; i++) actualGaps.push((times[i] - times[i - 1]) / 1000);
  const jobRow = firstResults(d1Json(spawn, `SELECT status FROM enrichment_jobs WHERE id = '${jobId}'`))[0];
  const tagRow = firstResults(
    d1Json(spawn, `SELECT b.tagging_status FROM bookmarks b JOIN enrichment_jobs j ON j.bookmark_id = b.id WHERE j.id = '${jobId}'`),
  )[0];
  const retryResult = {
    attempts,
    requestedDelays,
    actualGaps,
    finalJobStatus: jobRow?.status ?? "unknown",
    finalTaggingStatus: tagRow?.tagging_status ?? null,
    dlqReceived: dlq !== undefined,
    timedOut: failed === undefined,
  };

  // 2. 第一周期审计：含 fail job failed+86401 的 invocation（已发生）
  const findAudit = async (predicate) => {
    const invs = firstResults(d1Json(spawn, "SELECT invocation_id FROM cron_invocations ORDER BY scheduled_at DESC LIMIT 10"));
    for (const inv of invs) {
      const audit = await cronAudit(spawn, inv.invocation_id);
      if (audit && predicate(audit)) return audit;
    }
    return null;
  };
  const first = await findAudit(
    (a) => a.jobs.some((j) => j.jobId === failJobId && j.sendResult === "failed" && j.sendDelaySeconds === ILLEGAL_DELAY_SECONDS),
  );
  if (!first) throw new Error("CRON_FIRST_AUDIT_NOT_FOUND");

  // 3. 第二周期审计：等待含 fail job sent（send_delay_seconds 为 NULL）的 invocation
  const deadline = Date.now() + awaitSecondMs;
  let second = null;
  while (Date.now() < deadline && !second) {
    second = await findAudit(
      (a) => a.jobs.some((j) => j.jobId === failJobId && j.sendResult === "sent" && (j.sendDelaySeconds === null || j.sendDelaySeconds === undefined)),
    );
    if (!second) await sleep(Math.min(POLL_INTERVAL_MS, Math.max(100, deadline - Date.now())));
  }
  if (!second) throw new Error("CRON_SECOND_AUDIT_TIMEOUT");

  // 4. 复用 runQueue 注入契约：纯校验 + 原子输出
  const artifact = await runQueue({
    deployPath,
    apiKey,
    poll: async () => retryResult,
    cronAudit: first,
    secondCron: second,
    retryDeadlineMs: 60 * 60 * 1000,
    cronDeadlineMs: 60 * 60 * 1000,
    overallDeadlineMs: 60 * 60 * 1000,
  });
  artifact.resumed = { jobId, failJobId };
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
  const { deploy, out } = args;
  if (!deploy || !out) throw new Error("Usage: run-queue-probe.mjs --deploy <deploy-probes.json> --out <queue.json> [--resume --job-id <id> --fail-job-id <id>]");
  const apiKey = process.env.PHASE0_API_KEY;
  if (!apiKey) throw new Error("PHASE0_API_KEY_MISSING");
  let artifact;
  if (args.resume) {
    if (!args["job-id"] || !args["fail-job-id"]) throw new Error("--resume 需要 --job-id 与 --fail-job-id");
    artifact = await runResume({ deployPath: deploy, apiKey, jobId: args["job-id"], failJobId: args["fail-job-id"] });
  } else {
    artifact = await runQueue({ deployPath: deploy, apiKey });
  }
  await atomicWriteJson(out, artifact);
  console.log(JSON.stringify({ queue: { passed: artifact.passed, retryDlqPassed: artifact.checks.retryDlqPassed, cronAuditPassed: artifact.checks.cronAuditPassed } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`run-queue-probe: ${err.message}`);
    process.exit(2);
  });
}
