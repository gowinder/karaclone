/**
 * Phase 0 freeze-capture：操作员确认客户端无在途请求后，
 * stop 前每 5 秒轮询目标 run 的 procedure/HTTP/route count，连续三次相同
 * （覆盖至少 10 秒）才构成静默窗口；随后调用 capture/stop，固定等待 5 秒
 * 查询第一次 status，再等待 5 秒查询第二次 status；两次都必须精确匹配
 * 目标 runId/client、enabled=false 且各项 count 相同。原子输出顶层记录
 * runId、client、Worker URL、deploymentId、稳定排序 versionIds、三类计数、
 * 时间戳、canonicalSha256 和 passed。
 *
 * 用法：node scripts/phase0/freeze-capture.mjs --client <c> --run-id <id>
 *       --deploy artifacts/phase0/deploy-clients.json --out <path>
 */
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJsonHash } from "./canonical-json.mjs";

const POLL_INTERVAL_MS = 5000;
const QUIET_WINDOW_POLLS = 3;
const STOP_QUERY_INTERVAL_MS = 5000;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${key}`);
      }
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
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv);
  const { client, "run-id": runId, deploy, out } = args;
  if (!client || !runId || !deploy || !out) {
    throw new Error("Usage: freeze-capture.mjs --client <c> --run-id <id> --deploy <path> --out <path>");
  }

  const deployArtifact = JSON.parse(await readFile(deploy, "utf8"));
  const passedClients = deployArtifact.clients ?? deployArtifact;
  const entry = Array.isArray(passedClients)
    ? passedClients.find((c) => c.client === client && c.passed)
    : passedClients[client];
  if (!entry) throw new Error(`No passed client entry for ${client} in ${deploy}`);
  const workerUrl = entry.workerUrl ?? entry.url;
  const deploymentId = entry.deploymentId;
  const versionIds = [...(entry.versionIds ?? [])].sort();
  if (!workerUrl || !deploymentId) throw new Error(`deploy artifact missing workerUrl/deploymentId for ${client}`);

  const base = `${workerUrl}/__phase0/capture`;
  const auth = { Authorization: `Bearer ${process.env.CLOUDFLARE_PHASE0_ADMIN_KEY}` };
  if (!process.env.CLOUDFLARE_PHASE0_ADMIN_KEY) throw new Error("CLOUDFLARE_PHASE0_ADMIN_KEY env required");

  // 1. 静默窗口：连续三次（间隔 5 秒）count 相同
  let prevCounts = null;
  let stablePolls = 0;
  for (let i = 0; i < 12; i++) {
    const status = await fetchJson(`${base}/status`, { headers: auth });
    if (status.runId !== runId || status.client !== client) {
      throw new Error(`Session mismatch: runId=${status.runId} client=${status.client}, expected ${runId}/${client}`);
    }
    const counts = status.counts;
    const key = JSON.stringify(counts);
    if (prevCounts === key) {
      stablePolls++;
      if (stablePolls >= QUIET_WINDOW_POLLS - 1) break;
    } else {
      stablePolls = 0;
      prevCounts = key;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (stablePolls < QUIET_WINDOW_POLLS - 1) {
    throw new Error("No quiet window: counts never stable for 3 consecutive polls");
  }

  // 2. stop
  await fetchJson(`${base}/stop`, { method: "POST", headers: auth });

  // 3. stop 后两次查询，间隔 5 秒，必须精确匹配
  const first = await fetchJson(`${base}/status`, { headers: auth });
  await sleep(STOP_QUERY_INTERVAL_MS);
  const second = await fetchJson(`${base}/status`, { headers: auth });
  for (const s of [first, second]) {
    if (s.enabled !== false || s.runId !== runId || s.client !== client) {
      throw new Error(`Post-stop status mismatch: ${JSON.stringify(s)}`);
    }
    if (JSON.stringify(s.counts) !== JSON.stringify(first.counts)) {
      throw new Error(`Post-stop counts changed: ${JSON.stringify(s.counts)} vs ${JSON.stringify(first.counts)}`);
    }
  }

  const freeze = {
    runId,
    client,
    workerUrl,
    deploymentId,
    versionIds,
    counts: first.counts,
    unknownProcedures: first.unknownProcedures,
    stoppedAt: new Date().toISOString(),
    quietWindowPassed: true,
    passed: true,
  };
  freeze.canonicalSha256 = await canonicalJsonHash(freeze);
  await writeFile(out, JSON.stringify(freeze, null, 2) + "\n");
  console.log(`freeze written to ${out}`);
}

main().catch((err) => {
  console.error(`freeze-capture failed: ${err.message}`);
  process.exit(1);
});
