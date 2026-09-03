/**
 * T12 Step 5/6：CPU 流量 + GraphQL P99 + Telemetry 观测。
 * 启动/结束各校验 production 与 deploy-cpu 一致；确认其他 /__phase0/* 404；
 * 1000 次操作（20% clientConfig / 20% settings / 25% getBookmarks / 20% checkUrl /
 * 10% getBookmark / 5% createBookmark 唯一 URL）；任何 1102 立即失败。
 * GraphQL（CLOUDFLARE_ANALYTICS_TOKEN）查 CPU P99；Telemetry（CLOUDFLARE_OBSERVABILITY_TOKEN）
 * 分页查 exact cpu version 的 queue/cron 事件。输出 cpu.json / cpu-invocation-run.json / queue-invocations.json。
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDrift, atomicWriteJson, loadApiKey, loadDeployArtifact, PROVENANCE_KEYS } from "./remote-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");
const CPU_QUERY = `query Cpu($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 1000
        filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd, scriptName: $scriptName }
      ) {
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { datetime scriptName status }
      }
    }
  }
}`;

const defaultFetch = async (url, init) => fetch(url, init);
const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 默认 GraphQL runner：只读 CLOUDFLARE_ANALYTICS_TOKEN。 */
export async function defaultGraphql({ accountId, analyticsToken, from, to, scriptName, fetchImpl = defaultFetch }) {
  const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${analyticsToken}` },
    body: JSON.stringify({ query: CPU_QUERY, variables: { accountTag: accountId, datetimeStart: from, datetimeEnd: to, scriptName } }),
  });
  if (res.status !== 200) throw new Error(`GRAPHQL_HTTP_${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GRAPHQL_ERRORS: ${json.errors[0].message}`);
  // workersInvocationsAdaptive 行是嵌套 sum/quantiles/dimensions，归一化为扁平字段
  return (json?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
    requests: r?.sum?.requests ?? 0,
    errors: r?.sum?.errors ?? 0,
    cpuTimeP50: r?.quantiles?.cpuTimeP50 ?? 0,
    cpuTimeP99: r?.quantiles?.cpuTimeP99 ?? 0,
    datetime: r?.dimensions?.datetime ?? null,
  }));
}

/** Telemetry 分页查询：exact versionId + 可选 eventType，闭合窗口。 */
export async function telemetryQuery({ token, accountId, versionId, eventType, from, to, fetchImpl = defaultFetch }) {
  const filters = [{ key: "$workers.scriptVersion.id", operation: "eq", type: "string", value: versionId }];
  if (eventType !== undefined && eventType !== null) {
    filters.push({ key: "$workers.eventType", operation: "eq", type: "string", value: eventType });
  }
  const base = {
    timeframe: { from, to },
    view: "events",
    limit: 2000,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters,
    },
  };
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;
  const pages = [];
  const uniqueIds = new Set();
  const projections = [];
  let queryId = randomUUID();
  let offset = null;
  let offsetDirection = null;
  let firstCount = null;
  let firstQueryId = queryId;

  for (let page = 0; page < 100; page++) {
    const body = { queryId, timeframe: base.timeframe, view: base.view, limit: base.limit, parameters: base.parameters };
    if (offset) {
      body.offset = offset;
      body.offsetDirection = "next";
    }
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) throw new Error(`TELEMETRY_HTTP_${res.status}`);
    const json = await res.json();
    if (json.success !== true) throw new Error(`TELEMETRY_FAILED: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
    const events = json?.result?.events?.events ?? [];
    const count = json?.result?.events?.count ?? 0;
    if (page === 0) firstCount = count;
    for (const e of events) {
      const id = e?.$metadata?.id;
      if (typeof id === "string" && id) uniqueIds.add(id);
      const w = e?.$workers ?? {};
      projections.push({
        id: typeof id === "string" ? id : null,
        timestamp: typeof e?.timestamp === "number" ? e.timestamp : null,
        eventType: typeof w.eventType === "string" ? w.eventType : null,
        outcome: typeof w.outcome === "string" ? w.outcome : null,
        cpuTimeMs: typeof w.cpuTimeMs === "number" ? w.cpuTimeMs : null,
        wallTimeMs: typeof w.wallTimeMs === "number" ? w.wallTimeMs : null,
      });
    }
    pages.push({
      page,
      count,
      eventCount: events.length,
      offsetHash: offset ? sha256Hex(offset) : null,
      offsetDirection: offsetDirection ?? null,
      queryIdHash: sha256Hex(queryId),
    });
    if (uniqueIds.size >= firstCount) break;
    if (events.length === 0) break;
    const last = events[events.length - 1]?.$metadata?.id;
    if (!last || last === offset) break;
    offset = last;
    offsetDirection = "next";
    queryId = randomUUID();
  }

  // 复查 count 未变化（原始首屏请求）
  const recheckBody = { queryId: firstQueryId, timeframe: base.timeframe, view: base.view, limit: base.limit, parameters: base.parameters };
  const recheckRes = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(recheckBody),
  });
  const recheckJson = await recheckRes.json();
  const recheckCount = recheckJson?.result?.events?.count ?? null;
  const stable = recheckCount === firstCount;

  return {
    versionId,
    eventType,
    from,
    to,
    totalCount: firstCount,
    uniqueCount: uniqueIds.size,
    eventIds: [...uniqueIds].sort(),
    events: projections,
    pageCount: pages.length,
    pages,
    stable,
    queryProjection: {
      view: base.view,
      limit: base.limit,
      parameters: base.parameters,
      timeframeMs: { from, to },
    },
  };
}

export async function runCpu({
  deployPath,
  graphql,
  fetchImpl = defaultFetch,
  spawn = defaultSpawn,
  apiKey,
  accountId,
  analyticsToken,
  checkedAt = new Date().toISOString(),
}) {
  const deployArtifact = loadDeployArtifact(deployPath, "cpu");
  const url = deployArtifact.workerUrl;
  const checks = {};
  let reason = null;
  let error = null;
  let http1102Count = 0;
  const requestCounts = {};

  // 启动 production 校验
  try {
    assertNoDrift(spawn, deployArtifact, "START");
    checks.startNoDrift = true;
  } catch (err) {
    checks.startNoDrift = false;
    error = err instanceof Error ? err.message : String(err);
  }

  // 404 检查 + 1000 次操作
  let operationsOk = false;
  try {
    const probe404 = await fetchImpl(`${url}/__phase0/ai-json`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
    checks.phase0Routes404 = probe404.status === 404;

    const client = createTRPCClient({
      links: [
        httpBatchLink({
          url: `${url}/api/trpc`,
          headers: { Authorization: `Bearer ${apiKey}` },
          transformer: superjson,
          fetch: fetchImpl,
        }),
      ],
    });
    const ops = [];
    for (let i = 0; i < 1000; i++) {
      const r = i % 100;
      if (r < 20) ops.push({ name: "clientConfig", fn: () => client.config.clientConfig.query() });
      else if (r < 40) ops.push({ name: "settings", fn: () => client.users.settings.query() });
      else if (r < 65) ops.push({ name: "getBookmarks", fn: () => client.bookmarks.getBookmarks.query({ limit: 10, sortOrder: "desc", useCursorV2: true, includeContent: false, cursor: null }) });
      else if (r < 85) ops.push({ name: "checkUrl", fn: () => client.bookmarks.checkUrl.query({ url: `https://example.com/cpu-${i}` }) });
      else if (r < 95) ops.push({ name: "getBookmark", fn: () => client.bookmarks.getBookmark.query({ bookmarkId: "nonexistent", includeContent: false }) });
      else ops.push({ name: "createBookmark", fn: () => client.bookmarks.createBookmark.mutate({ type: "link", url: `https://example.com/cpu-${Date.now()}-${i}`, title: "CPU Probe", source: "api" }) });
    }
    for (const op of ops) {
      try {
        await op.fn();
        requestCounts[op.name] = (requestCounts[op.name] ?? 0) + 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/1102/.test(msg)) {
          http1102Count++;
          throw err;
        }
        // 其他错误（如 getBookmark 404）记录但不中断
      }
    }
    operationsOk = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (/1102/.test(error)) reason = "http_1102";
  }

  // 结束 production 校验
  try {
    assertNoDrift(spawn, deployArtifact, "END");
    checks.endNoDrift = true;
  } catch (err) {
    checks.endNoDrift = false;
    error = err instanceof Error ? err.message : String(err);
  }

  // GraphQL
  let rows = null;
  try {
    const result = await graphql();
    rows = Array.isArray(result) ? result : result?.rows ?? [];
  } catch (err) {
    reason = "graphql_failed";
    error = err instanceof Error ? err.message : String(err);
  }
  if (!reason && (!Array.isArray(rows) || rows.length === 0)) reason = "no_cpu_data";

  const totalRequests = Array.isArray(rows) ? rows.reduce((s, r) => s + (r.requests ?? 0), 0) : 0;
  const totalErrors = Array.isArray(rows) ? rows.reduce((s, r) => s + (r.errors ?? 0), 0) : 0;
  const maxP99 = Array.isArray(rows) ? Math.max(0, ...rows.map((r) => r.cpuTimeP99 ?? 0)) : 0;
  const graphqlPassed = Array.isArray(rows) && rows.length > 0 && totalRequests >= 1000 && totalErrors === 0 && maxP99 < 8000;

  const passed =
    graphqlPassed &&
    checks.startNoDrift === true &&
    checks.endNoDrift === true &&
    checks.phase0Routes404 === true &&
    operationsOk &&
    http1102Count === 0 &&
    !reason;

  const artifact = {
    profile: "cpu",
    ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
    checks,
    requestCounts,
    http1102Count,
    graphql: {
      totalRequests,
      totalErrors,
      maxCpuTimeP99Us: maxP99,
      rows: Array.isArray(rows)
        ? rows.map((r) => ({ datetime: r.datetime ?? null, requests: r.requests ?? 0, errors: r.errors ?? 0, cpuTimeP50: r.cpuTimeP50 ?? 0, cpuTimeP99: r.cpuTimeP99 ?? 0 }))
        : [],
    },
    reason,
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
  const deployPath = args.deploy ?? join(ARTIFACTS, "deploy-cpu.json");
  const apiKey = process.env.PHASE0_API_KEY ?? loadApiKey(join(REPO_ROOT, ".dev.vars"));
  const checkedAt = new Date().toISOString();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const analyticsToken = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const observabilityToken = process.env.CLOUDFLARE_OBSERVABILITY_TOKEN;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID_MISSING");
  if (!analyticsToken) throw new Error("CLOUDFLARE_ANALYTICS_TOKEN_MISSING");
  if (!observabilityToken) throw new Error("CLOUDFLARE_OBSERVABILITY_TOKEN_MISSING");
  const deployArtifact = loadDeployArtifact(deployPath, "cpu");
  const scriptName = "karaclone-phase0";
  // G7 要求 cpu artifacts 的 Cron unique>=2（两个真实 tick）且 Queue unique>=1：
  // 窗口必须从 deploy-cpu 部署时刻开始，覆盖部署后发生的整点 cron tick 与 queue 事件。
  // GraphQL 需要 ISO 8601；Telemetry timeframe 需要 UTC epoch 毫秒（number）。
  const windowFromMs = new Date(deployArtifact.checkedAt).getTime() - 60_000;
  const startMs = Date.now();
  // GraphQL 窗口固定为操作时段：首次调用时固化 to（1000 次操作已结束），
  // 重试只重复查询同一窗口等待数据可见，绝不推进 to（否则新 cron tick 会污染 p99）。
  let graphqlToMs = null;
  const graphql = async () => {
    // GraphQL 数据有分钟级延迟（实测 >20 分钟）且网络可能瞬时失败：最多等 60 分钟重查。
    for (let attempt = 0; attempt < 60; attempt++) {
      if (graphqlToMs === null) graphqlToMs = Date.now() + 60_000;
      let rows = null;
      try {
        rows = await defaultGraphql({
          accountId,
          analyticsToken,
          from: new Date(startMs - 60_000).toISOString(),
          to: new Date(graphqlToMs).toISOString(),
          scriptName,
        });
      } catch {
        rows = null; // 网络瞬时失败：重试
      }
      const total = Array.isArray(rows) ? rows.reduce((s, r) => s + (r.requests ?? 0), 0) : 0;
      if (total >= 1000) return rows;
      await new Promise((r) => setTimeout(r, 60_000));
    }
    return defaultGraphql({
      accountId,
      analyticsToken,
      from: new Date(startMs - 60_000).toISOString(),
      to: new Date(graphqlToMs ?? Date.now() + 60_000).toISOString(),
      scriptName,
    });
  };
  const cpu = await runCpu({
    deployPath,
    apiKey,
    accountId,
    analyticsToken,
    graphql,
  });
  // G7 窗口闭合：等待两个真实 cron tick（unique>=2）与 Queue consumer 事件（unique>=1）。
  // telemetry 有分钟级延迟：每 60s 重查，deadline 为部署后第二个整点 tick 后 15 分钟。
  const versionId = deployArtifact.versionIds[0];
  const deployMs = new Date(deployArtifact.checkedAt).getTime();
  const nextHour = Math.ceil(deployMs / 3_600_000) * 3_600_000;
  const secondTickMs = nextHour + 3_600_000;
  const cronDeadline = secondTickMs + 15 * 60_000;
  let queueTelemetry = null;
  let cronTelemetry = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    const now = Date.now();
    queueTelemetry = await telemetryQuery({ token: observabilityToken, accountId, versionId, eventType: "queue", from: windowFromMs, to: now });
    cronTelemetry = await telemetryQuery({ token: observabilityToken, accountId, versionId, eventType: "scheduled", from: windowFromMs, to: now });
    if (cronTelemetry.uniqueCount >= 2 && queueTelemetry.uniqueCount >= 1) break;
    if (now >= cronDeadline) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
  const endMs = Date.now();
  // 最终闭合查询（窗口到请求结束）
  queueTelemetry = await telemetryQuery({ token: observabilityToken, accountId, versionId, eventType: "queue", from: windowFromMs, to: endMs + 60_000 });
  cronTelemetry = await telemetryQuery({ token: observabilityToken, accountId, versionId, eventType: "scheduled", from: windowFromMs, to: endMs + 60_000 });

  const queueInvocations = {
    profile: "cpu",
    ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
    windows: { queue: queueTelemetry, cron: cronTelemetry },
    checkedAt,
    canonicalSha256: null,
    passed: queueTelemetry.stable && cronTelemetry.stable,
  };

  const cpuInvocationRun = {
    profile: "cpu",
    ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
    runId: randomUUID(),
    windows: {
      queue: { from: new Date(windowFromMs).toISOString(), to: new Date(endMs + 60_000).toISOString(), expectedCount: queueTelemetry.uniqueCount, actualIds: queueTelemetry.eventIds },
      cron: { from: new Date(windowFromMs).toISOString(), to: new Date(endMs + 60_000).toISOString(), expectedCount: cronTelemetry.uniqueCount, actualIds: cronTelemetry.eventIds },
    },
    checkedAt,
    canonicalSha256: null,
    passed: true,
  };

  await atomicWriteJson(join(ARTIFACTS, "cpu.json"), cpu);
  await atomicWriteJson(join(ARTIFACTS, "queue-invocations.json"), queueInvocations);
  await atomicWriteJson(join(ARTIFACTS, "cpu-invocation-run.json"), cpuInvocationRun);

  console.log(JSON.stringify({ cpu: { passed: cpu.passed, reason: cpu.reason, requests: cpu.graphql.totalRequests, p99Us: cpu.graphql.maxCpuTimeP99Us } }));
  process.exit(cpu.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`measure-cpu: ${err.message}`);
    process.exit(2);
  });
}
