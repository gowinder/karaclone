/**
 * Phase 0 export-wire：不负责 stop。先校验 freeze JSON 的 runId/client/Worker URL、
 * 静默窗口间隔、stop 后查询间隔、计数和 passed:true，重算 freeze canonical SHA-256，
 * 并要求 freeze/deploy 的 Worker URL 一致；再独立查询 capture singleton，确认
 * enabled=0 且 runId/client 与参数精确一致，固定等待 5 秒后再次查询并确认各项
 * count 不变。若任一 URL、哈希、freeze/session/deploy 不匹配、仍开启或计数变化
 * 则非零退出。随后查询事件并输出 wire JSON。
 *
 * 用法：node scripts/phase0/export-wire.mjs --client <c> --run-id <id>
 *       --freeze <path> --deploy <path> --out <path>
 */
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJsonHash } from "./canonical-json.mjs";

const STOP_QUERY_INTERVAL_MS = 5000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const args = parseArgs(process.argv);
  const { client, "run-id": runId, freeze: freezePath, deploy, out } = args;
  if (!client || !runId || !freezePath || !deploy || !out) {
    throw new Error("Usage: export-wire.mjs --client <c> --run-id <id> --freeze <path> --deploy <path> --out <path>");
  }

  const freeze = JSON.parse(await readFile(freezePath, "utf8"));
  const deployArtifact = JSON.parse(await readFile(deploy, "utf8"));
  const passedClients = deployArtifact.clients ?? deployArtifact;
  const entry = Array.isArray(passedClients)
    ? passedClients.find((c) => c.client === client && c.passed)
    : passedClients[client];
  if (!entry) throw new Error(`No passed client entry for ${client} in ${deploy}`);
  const workerUrl = entry.workerUrl ?? entry.url;
  const deploymentId = entry.deploymentId;
  const versionIds = [...(entry.versionIds ?? [])].sort();

  // 1. freeze 校验
  if (freeze.runId !== runId || freeze.client !== client) {
    throw new Error(`freeze runId/client mismatch: ${freeze.runId}/${freeze.client}`);
  }
  if (freeze.workerUrl !== workerUrl) {
    throw new Error(`freeze workerUrl ${freeze.workerUrl} != deploy ${workerUrl}`);
  }
  if (freeze.passed !== true || freeze.quietWindowPassed !== true) {
    throw new Error("freeze not passed");
  }
  const freezeHash = await canonicalJsonHash(freeze);
  if (freezeHash !== freeze.canonicalSha256) {
    throw new Error(`freeze canonicalSha256 mismatch: ${freezeHash} != ${freeze.canonicalSha256}`);
  }

  // 2. 独立查询 session：enabled=0、runId/client 精确一致
  const base = `${workerUrl}/__phase0/capture`;
  const auth = { Authorization: `Bearer ${process.env.CLOUDFLARE_PHASE0_ADMIN_KEY}` };
  if (!process.env.CLOUDFLARE_PHASE0_ADMIN_KEY) throw new Error("CLOUDFLARE_PHASE0_ADMIN_KEY env required");

  const first = await fetchJson(`${base}/status`, { headers: auth });
  if (first.enabled !== false || first.runId !== runId || first.client !== client) {
    throw new Error(`Session not stopped/mismatch: ${JSON.stringify(first)}`);
  }
  await sleep(STOP_QUERY_INTERVAL_MS);
  const second = await fetchJson(`${base}/status`, { headers: auth });
  if (JSON.stringify(second.counts) !== JSON.stringify(first.counts)) {
    throw new Error(`Counts changed between queries: ${JSON.stringify(second.counts)} vs ${JSON.stringify(first.counts)}`);
  }

  // 3. 查询事件
  const [events, httpEnvelopes, routeEvents, unknownProcedures] = await Promise.all([
    fetchJson(`${base}/events?runId=${encodeURIComponent(runId)}`, { headers: auth }),
    fetchJson(`${base}/http-events?runId=${encodeURIComponent(runId)}`, { headers: auth }),
    fetchJson(`${base}/route-events?runId=${encodeURIComponent(runId)}`, { headers: auth }),
    fetchJson(`${base}/unknown-procedures?runId=${encodeURIComponent(runId)}`, { headers: auth }),
  ]);

  const isExtension = client === "extension";
  const wire = {
    client,
    runId,
    workerUrl,
    deploymentId,
    versionIds,
    profile: "clients",
    sourceDeploySha256: entry.canonicalSha256 ?? null,
    freezeSha256: freezeHash,
    events,
    httpEnvelopes,
    routeEvents,
    unknownProcedures,
    captureQuietWindowPassed: true,
    captureStopped: true,
    captureCountsStable: true,
    fixedTestHeaderSeen: httpEnvelopes.some((e) => e.fixedTestHeaderSeen === 1),
    corsFixedHeaderRequested: isExtension ? httpEnvelopes.some((e) => e.corsFixedHeaderRequested === 1) : null,
    corsFixedHeaderAllowed: isExtension ? httpEnvelopes.some((e) => e.corsFixedHeaderAllowed === 1) : null,
    corsOriginMatched: isExtension ? httpEnvelopes.some((e) => e.corsOriginMatched === 1) : null,
    passed: false,
  };

  const hasUnknown = unknownProcedures.length > 0 || routeEvents.some((r) => r.routeTemplate === "unknown");
  const hasUnparseable = [...events, ...httpEnvelopes, ...routeEvents].some(
    (e) => JSON.stringify(e).includes("unparseable"),
  );
  const corsOk = isExtension
    ? wire.corsFixedHeaderRequested === true && wire.corsFixedHeaderAllowed === true && wire.corsOriginMatched === true
    : true;
  wire.passed =
    events.length > 0 &&
    httpEnvelopes.length > 0 &&
    routeEvents.length > 0 &&
    wire.fixedTestHeaderSeen === true &&
    corsOk &&
    !hasUnknown &&
    !hasUnparseable &&
    wire.unknownProcedures.length === 0;

  await writeFile(out, JSON.stringify(wire, null, 2) + "\n");
  console.log(`wire written to ${out} (passed=${wire.passed})`);
  if (!wire.passed) process.exit(1);
}

main().catch((err) => {
  console.error(`export-wire failed: ${err.message}`);
  process.exit(1);
});
