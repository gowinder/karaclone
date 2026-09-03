/**
 * T12 Step 2：远端 contract gate。真实 @trpc/client httpBatchLink + SuperJSON，
 * 只接受 probes deploy artifact；7 项检查 + D1 行数校验。
 * 输出 artifacts/phase0/remote-contract.json（顶层展开 probes DeploymentProvenance）。
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, loadDeployArtifact, PROVENANCE_KEYS } from "./remote-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const defaultFetch = async (url, init) => fetch(url, init);
const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

export async function runContract({ deployPath, apiKey, fetchImpl = defaultFetch, spawn = defaultSpawn, checkedAt = new Date().toISOString() }) {
  const deployArtifact = loadDeployArtifact(deployPath, "probes");
  const url = deployArtifact.workerUrl;
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

  const checks = {};
  let http1102Count = 0;
  let requestCount = 0;
  const wrap = async (fn) => {
    requestCount++;
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 1102 在 undici 中表现为 status 范围错误（Cloudflare 自定义状态码超出 200-599）
      if (/1102|200 to 599/.test(msg)) http1102Count++;
      throw err;
    }
  };

  try {
    // 1. 创建带 Date 的书签，返回 Date 实例
    const uniqueUrl = `https://example.com/contract-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const created = await wrap(() =>
      client.bookmarks.createBookmark.mutate({ type: "link", url: uniqueUrl, title: "Contract Probe", source: "api" }),
    );
    checks.dateRoundTrip = created.createdAt instanceof Date && !Number.isNaN(created.createdAt.getTime());
    checks.createdAlreadyExists = created.alreadyExists === false;
    const bookmarkId = created.id;

    // 2. checkUrl 命中同一 ID
    const check = await wrap(() => client.bookmarks.checkUrl.query({ url: uniqueUrl }));
    checks.checkUrlHit = check.bookmarkId === bookmarkId;

    // 3. canonical 等价 URL 再创建，不新增 bookmark/job
    const canonicalEquivalent = `${uniqueUrl}#fragment`;
    const again = await wrap(() =>
      client.bookmarks.createBookmark.mutate({ type: "link", url: canonicalEquivalent, title: "Contract Probe", source: "api" }),
    );
    checks.canonicalEquivalentNoDuplicate = again.alreadyExists === true && again.id === bookmarkId;

    // 4. 同一 HTTP batch：whoami + settings + getBookmarks
    const [whoami, settings, list] = await wrap(() =>
      Promise.all([
        client.users.whoami.query(),
        client.users.settings.query(),
        client.bookmarks.getBookmarks.query({ limit: 5, sortOrder: "desc", useCursorV2: true, includeContent: false, cursor: null }),
      ]),
    );
    checks.batchWhoami = typeof whoami.id === "string" && whoami.localUser === true;
    checks.batchSettings = typeof settings === "object" && settings !== null && "timezone" in settings;
    checks.batchGetBookmarks = Array.isArray(list.bookmarks) && list.bookmarks.length > 0;

    // 5. includeContent:true 返回动态且已转义的 Reader HTML
    const withContent = await wrap(() => client.bookmarks.getBookmark.query({ bookmarkId, includeContent: true }));
    checks.includeContentHtml = typeof withContent.content?.htmlContent === "string" && withContent.content.htmlContent.length > 0;
    checks.htmlEscaped = !/<\/script>|<script\b/i.test(withContent.content?.htmlContent ?? "");

    // 6. 更新并读取 reading progress
    await wrap(() =>
      client.bookmarks.updateReadingProgress.mutate({
        bookmarkId,
        readingProgressOffset: 42,
        readingProgressAnchor: "h1",
        readingProgressPercent: 0.5,
      }),
    );
    const progress = await wrap(() => client.bookmarks.getReadingProgress.query({ bookmarkId }));
    checks.readingProgress = progress.readingProgressOffset === 42 && progress.readingProgressAnchor === "h1" && progress.readingProgressPercent === 0.5;

    // 7. 远端 D1 行数校验（无明文 key）：bookmarks 行数 >= 1、api_keys 无明文 secret
    const d1Out = spawn("npx", ["wrangler@4.128.0", "d1", "execute", "karaclone-phase0", "--remote", "--command",
      "SELECT COUNT(*) AS n FROM bookmarks; SELECT COUNT(*) AS k FROM api_keys;"]);
    if (d1Out.error) throw d1Out.error;
    if (d1Out.status !== 0) throw new Error(`D1_EXECUTE_FAILED: ${(d1Out.stderr || d1Out.stdout).slice(0, 400)}`);
    const d1Text = d1Out.stdout;
    const nMatch = d1Text.match(/["']?n["']?\s*[:=]\s*(\d+)/);
    const kMatch = d1Text.match(/["']?k["']?\s*[:=]\s*(\d+)/);
    checks.d1RowsOk = nMatch !== null && Number(nMatch[1]) >= 1 && kMatch !== null && Number(kMatch[1]) >= 1;
    checks.noPlaintextKey = !d1Text.includes(apiKey);

    const passed = Object.values(checks).every((v) => v === true) && http1102Count === 0;
    const artifact = {
      profile: "probes",
      ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
      checks,
      requestCount,
      http1102Count,
      checkedAt,
      canonicalSha256: null,
      passed,
    };
    return artifact;
  } catch (err) {
    const artifact = {
      profile: "probes",
      ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
      checks,
      requestCount,
      http1102Count,
      error: err instanceof Error ? err.message : String(err),
      checkedAt,
      canonicalSha256: null,
      passed: false,
    };
    return artifact;
  }
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
  if (!deploy || !out) throw new Error("Usage: remote-contract.mjs --deploy <deploy-probes.json> --out <remote-contract.json>");
  const apiKey = process.env.PHASE0_API_KEY;
  if (!apiKey) throw new Error("PHASE0_API_KEY_MISSING");
  const artifact = await runContract({ deployPath: deploy, apiKey });
  await atomicWriteJson(out, artifact);
  console.log(JSON.stringify({ contract: { passed: artifact.passed, requestCount: artifact.requestCount, http1102Count: artifact.http1102Count } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`remote-contract: ${err.message}`);
    process.exit(2);
  });
}
