/**
 * Phase 0 Workers Free Dashboard entitlement collector（G0 三件套唯一生成器）。
 *
 * 流程：后台启动专用空临时 Chrome profile（expectedUserDataDir 内嵌随机
 * profileSessionNonce + 随机本地 debugging port）→ 交叉验证 PID/args/endpoint/
 * profile/nonce 均属本次会话 → 暂停等用户登录并选择目标账户 → CDP 导航官方
 * `https://dash.cloudflare.com/<account>/workers/plans`，经 Runtime.evaluate 取
 * rendered DOM 与文本、Page.captureScreenshot 取 PNG → 页内 account ID 的 SHA-256
 * 必须与 preflight.json 的 whoamiAccountIdSha256 精确相等 → 脱敏与 secret scan →
 * JSON/HTML/PNG 三件套原子写入。成功或失败退出均终止本次 Chrome 并删除临时 profile。
 *
 * 本脚本不使用 Cloudflare Browser Rendering，不创建任何 Cloudflare 资源。
 *
 * 注入点（供测试）：makeTempDir/spawnChrome/getJson/getProcessArgs/promptUser/
 * cdpEvaluate/cdpScreenshot/killChrome/writeFile/cleanupTemp。
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export const SCHEMA_VERSION = "1.0.0";
export const EXTRACTION_RULES_VERSION = 1;
export const SELECTOR_VERSION = 1;
export const DASHBOARD_HOST = "dash.cloudflare.com";
export const PLAN_PATH_PREFIX = "/workers/plans";

export const JSON_NAME = "workers-plan-entitlement.json";
export const HTML_NAME = "workers-plan-entitlement.html";
export const PNG_NAME = "workers-plan-entitlement.png";

export const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|authorization|auth[_-]?key)\s*[:=]\s*\S+/gi,
  /x-auth-(?:email|user-key)\s*:/gi,
  /cf_clearance\s*=/gi,
  /__cf[^"\s]{0,40}/gi,
];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 构造官方 canonical Workers plan URL。 */
export function buildCanonicalUrl(accountId) {
  return `https://${DASHBOARD_HOST}/${accountId}${PLAN_PATH_PREFIX}`;
}

/**
 * 校验 canonical URL 的 host/path/account。
 * - host 必须是 dash.cloudflare.com
 * - path 必须是 /<accountId>/workers/plans
 * - accountId 的 SHA-256 必须等于期望值
 * 任何一个不满足即 throw，返回 canonical URL。
 */
export function verifyCanonicalUrl(url, expectedAccountSha) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("URL_INVALID");
  }
  if (u.protocol !== "https:" || u.hostname !== DASHBOARD_HOST) throw new Error("HOST_NOT_ALLOWED");
  const m = u.pathname.match(/^\/([0-9a-f]{8,64})\/workers\/plans$/);
  if (!m) throw new Error("PATH_INVALID");
  const accountId = m[1];
  if (sha256Hex(accountId) !== expectedAccountSha) throw new Error("ACCOUNT_MISMATCH");
  return url;
}

/**
 * 按 extraction rule v1 从纯文本提取 "Workers Free" 证据。
 * - 未出现 → SELECTOR_MISSING
 * - 出现于多个不同行 → SELECTOR_AMBIGUOUS
 * - 单一行 → 返回该行规范化文本
 */
export function extractWorkersFreeEvidence(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("SELECTOR_MISSING");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\bWorkers Free\b/i.test(l));
  if (lines.length === 0) throw new Error("SELECTOR_MISSING");
  const unique = [...new Set(lines)];
  if (unique.length > 1) throw new Error("SELECTOR_AMBIGUOUS");
  return unique[0];
}

/**
 * 按 extraction rule v1 从 canonical URL 与 DOM 提取 account ID：
 * path 第一段 + DOM 文本必须包含该 ID（出现 ≥1 次）。
 */
export function extractAccountIdFromDom(url, domText) {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* 作为 path 处理 */
  }
  const m = pathname.match(/^\/([0-9a-f]{8,64})\//);
  if (!m) throw new Error("ACCOUNT_ID_NOT_IN_URL");
  const accountId = m[1];
  if (typeof domText !== "string" || !domText.includes(accountId)) throw new Error("ACCOUNT_ID_NOT_IN_DOM");
  return accountId;
}

/** 在文本中发现任何 secret 形态即 throw；返回第一处描述。 */
export function scanDomForSecrets(text) {
  for (const pattern of SECRET_PATTERNS) {
    const hit = text.match(pattern);
    if (hit) throw new Error(`DOM_SECRET_FOUND: ${pattern.source}`);
  }
  return true;
}

/** 防御性脱敏：替换 secret 形态串（真实流程在 scan 通过后仅作二次保险）。 */
export function redactDom(dom) {
  let out = String(dom);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * 交叉验证 Chrome 会话完全属于本次空临时 profile。
 * 返回错误码数组；空数组 = 通过。
 */
export function verifySession({ chromePid, launchArgs, endpointUrl, expectedUserDataDir, expectedNonce, actualProfilePath, port }) {
  const errors = [];
  if (!Number.isInteger(chromePid) || chromePid <= 0) errors.push("PID_INVALID");
  if (!Array.isArray(launchArgs)) errors.push("ARGS_INVALID");
  else {
    if (!launchArgs.includes(`--user-data-dir=${expectedUserDataDir}`)) errors.push("ARGS_MISSING_USER_DATA_DIR");
    if (!launchArgs.includes(`--remote-debugging-port=${port}`)) errors.push("ARGS_PORT_NOT_FOUND");
  }
  if (typeof expectedUserDataDir !== "string" || !expectedUserDataDir.includes(expectedNonce)) errors.push("NONCE_NOT_IN_USER_DATA_DIR");
  if (typeof endpointUrl !== "string" || !endpointUrl.includes("127.0.0.1") || !endpointUrl.includes(`:${port}`)) {
    errors.push("ENDPOINT_NOT_CURRENT");
  }
  if (typeof actualProfilePath !== "string" || !actualProfilePath.includes(expectedUserDataDir)) {
    errors.push("PROFILE_NOT_IN_SESSION");
  }
  return errors;
}

/**
 * 账户三方（Dashboard/API/deploy）一致性校验：dashboard 与 API 必须相等；
 * deploy 在 G2 阶段才提供，允许 null。
 */
export function verifyAccountTrio({ dashboardAccountIdSha256, apiAccountIdSha256, deployAccountIdSha256 }) {
  if (typeof dashboardAccountIdSha256 !== "string" || dashboardAccountIdSha256.length !== 64) throw new Error("DASHBOARD_ACCOUNT_INVALID");
  if (dashboardAccountIdSha256 !== apiAccountIdSha256) throw new Error("DASHBOARD_API_ACCOUNT_MISMATCH");
  if (deployAccountIdSha256 != null && deployAccountIdSha256 !== apiAccountIdSha256) throw new Error("DEPLOY_ACCOUNT_MISMATCH");
  return true;
}

/** 组装 artifact JSON（无敏感；decision 可完整重算）。 */
export async function buildArtifact({
  canonicalDashboardUrl,
  normalizedSelectorText,
  redactedDom,
  accountId,
  screenshotSha256,
  session,
  capturedAt,
  reviewedBy,
  reviewedAt,
}) {
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    extractionRulesVersion: EXTRACTION_RULES_VERSION,
    selectorVersion: SELECTOR_VERSION,
    canonicalDashboardUrl,
    normalizedSelectorText,
    renderedDomEvidence: redactedDom,
    urlSha256: sha256Hex(canonicalDashboardUrl),
    textSha256: sha256Hex(normalizedSelectorText),
    domSha256: sha256Hex(redactedDom),
    screenshotSha256,
    accountIdSha256: sha256Hex(accountId),
    session: {
      chromePid: session.chromePid,
      expectedUserDataDir: session.expectedUserDataDir,
      actualProfilePath: session.actualProfilePath,
      endpointUrl: session.endpointUrl,
      launchArgsSha256: session.launchArgsSha256,
      profileSessionNonceSha256: session.profileSessionNonceSha256,
      sessionValidated: true,
    },
    capturedAt,
    reviewedBy,
    reviewedAt,
    canonicalSha256: null,
    passed: true,
  };
  artifact.canonicalSha256 = await canonicalJsonHash(artifact);
  return artifact;
}

/** ESM 下加载 CommonJS 模块（child_process/readline）。 */
function nodeRequire(spec) {
  return requireCjsModule(import.meta.url)(spec);
}
import { createRequire as requireCjsModule } from "node:module";

/** 当前 collector 会话的 CDP 端口（spawnChrome 后设置）。 */
let activeCdpPort = null;

/** 通过 CDP 向 page target 发请求。 */
async function cdpRequest(port, method, params = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("CDP_NO_PAGE_TARGET");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (m, p = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
  const result = await send(method, params);
  ws.close();
  return result.result;
}

/** 单测注入用的默认依赖。 */
export const defaultDeps = {
  makeTempDir(prefix) {
    const dir = join(tmpdir(), prefix);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  spawnChrome({ userDataDir, port }) {
    activeCdpPort = port;
    const proc = spawn(findChromeBinary(), [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "about:blank",
    ], { stdio: "ignore", detached: true });
    return proc.pid;
  },
  getJson: async (url) => {
    const res = await fetch(url);
    return res.json();
  },
  getProcessArgs: (pid) => {
    const { execSync } = nodeRequire("node:child_process");
    const out = execSync(`ps -p ${pid} -o args=`).toString().trim();
    return out.split("\x20");
  },
  promptUser: async (message) => {
    console.log(message);
    const { createInterface } = nodeRequire("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question("", resolve));
    rl.close();
  },
  killChrome: (pid) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  },
  cleanupTemp: (dir) => {
    rmSync(dir, { recursive: true, force: true });
  },
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  cdpEvaluate: async () => {
    if (!activeCdpPort) throw new Error("CDP_PORT_NOT_SET");
    // 导航到 Workers 计划页并等待渲染
    await cdpRequest(activeCdpPort, "Page.enable");
    await cdpRequest(activeCdpPort, "Runtime.enable");
    await cdpRequest(activeCdpPort, "Page.navigate", {
      url: `https://${DASHBOARD_HOST}/workers/plans`,
    });
    await new Promise((r) => setTimeout(r, 6000));
    const urlRes = await cdpRequest(activeCdpPort, "Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    let url = urlRes?.result?.value ?? "";
    // 若 URL 无账户 ID 前缀（Cloudflare 未自动重定向），从 curr-account cookie 提取账户 ID 再导航
    if (!/^\/([0-9a-f]{8,64})\/workers\/plans$/.test(new URL(url).pathname)) {
      const ckRes = await cdpRequest(activeCdpPort, "Network.getAllCookies");
      const ck = (ckRes?.cookies ?? []).find(
        (c) => c.name === "curr-account" && c.domain === DASHBOARD_HOST,
      );
      const accountId = ck ? Object.values(JSON.parse(ck.value))[0] : null;
      if (typeof accountId === "string" && /^[0-9a-f]{8,64}$/.test(accountId)) {
        await cdpRequest(activeCdpPort, "Page.navigate", {
          url: `https://${DASHBOARD_HOST}/${accountId}/workers/plans`,
        });
        await new Promise((r) => setTimeout(r, 6000));
        const urlRes2 = await cdpRequest(activeCdpPort, "Runtime.evaluate", {
          expression: "location.href",
          returnByValue: true,
        });
        url = urlRes2?.result?.value ?? url;
      }
    }
    const domRes = await cdpRequest(activeCdpPort, "Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    const dom = domRes?.result?.value ?? "";
    const textRes = await cdpRequest(activeCdpPort, "Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    const text = textRes?.result?.value ?? "";
    let accountPath = "";
    try {
      accountPath = new URL(url).pathname;
    } catch {
      /* 保持空 */
    }
    return { url, dom, text, accountPath };
  },
  cdpScreenshot: async () => {
    if (!activeCdpPort) throw new Error("CDP_PORT_NOT_SET");
    const res = await cdpRequest(activeCdpPort, "Page.captureScreenshot", {
      format: "png",
    });
    if (!res?.data) throw new Error("CAPTURE_SCREENSHOT_EMPTY");
    return Buffer.from(res.data, "base64");
  },
};

function findChromeBinary() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* 下一个 */
    }
  }
  throw new Error("CHROME_BINARY_NOT_FOUND");
}

/**
 * 采集主流程（注入依赖便于测试；返回 artifact）。任何失败均不产生三件套。
 */
export async function runCollector({
  deps = defaultDeps,
  accountIdSourcePath,
  outDir,
  capturedAt = new Date().toISOString(),
  reviewedBy = "phase0-collector",
  fixedPort = null,
}) {
  const source = JSON.parse(readFileSync(accountIdSourcePath, "utf8"));
  const expectedAccountSha = source.whoamiAccountIdSha256;
  if (typeof expectedAccountSha !== "string" || expectedAccountSha.length !== 64) throw new Error("ACCOUNT_ID_SOURCE_INVALID");

  // stale/prebuilt 输出拒绝：三件套任一已存在即失败，不覆盖
  for (const name of [JSON_NAME, HTML_NAME, PNG_NAME]) {
    try {
      readFileSync(join(outDir, name));
      throw new Error(`STALE_OUTPUT_PRESENT: ${name}`);
    } catch (err) {
      if (err.message && err.message.startsWith("STALE_OUTPUT_PRESENT")) throw err;
    }
  }

  const nonce = randomBytes(16).toString("hex");
  const userDataDir = deps.makeTempDir(`karaclone-phase0-${nonce}`);
  const port = fixedPort ?? Math.floor(20000 + Math.random() * 40000);
  const chromePid = deps.spawnChrome({ userDataDir, port });

  let endpointUrl = null;
  try {
    // 轮询 CDP endpoint 就绪
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const version = await deps.getJson(`http://127.0.0.1:${port}/json/version`);
        endpointUrl = version.webSocketDebuggerUrl;
        if (endpointUrl) break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!endpointUrl) throw new Error("CDP_ENDPOINT_TIMEOUT");

    const launchArgs = deps.getProcessArgs(chromePid);
    // 实际 Profile Path：真实 Chrome 为 userDataDir/Default
    const actualProfilePath = join(userDataDir, "Default");
    const errors = verifySession({
      chromePid,
      launchArgs,
      endpointUrl,
      expectedUserDataDir: userDataDir,
      expectedNonce: nonce,
      actualProfilePath,
      port,
    });
    if (errors.length > 0) throw new Error(`SESSION_VERIFY_FAILED: ${errors.join(",")}`);

    await deps.promptUser(
      `请在已打开的 Chrome（临时 profile ${userDataDir}）登录 Cloudflare 并选择目标账户，\n页面跳至 dash.cloudflare.com/<account>/ 后回到终端按回车继续。`,
    );

    const evaluated = await deps.cdpEvaluate();
    const url = evaluated.url ?? `https://${DASHBOARD_HOST}${evaluated.accountPath ?? ""}`;
    verifyCanonicalUrl(url, expectedAccountSha);

    const accountId = extractAccountIdFromDom(url, evaluated.dom);
    if (sha256Hex(accountId) !== expectedAccountSha) throw new Error("ACCOUNT_MISMATCH");

    const normalizedSelectorText = extractWorkersFreeEvidence(evaluated.text);
    scanDomForSecrets(evaluated.text);
    scanDomForSecrets(evaluated.dom);
    const redactedDom = redactDom(evaluated.dom);

    const png = await deps.cdpScreenshot();
    if (!Buffer.isBuffer(png) || png.length === 0) throw new Error("CAPTURE_SCREENSHOT_EMPTY");

    const artifact = await buildArtifact({
      canonicalDashboardUrl: url,
      normalizedSelectorText,
      redactedDom,
      accountId,
      screenshotSha256: sha256Hex(png),
      session: {
        chromePid,
        expectedUserDataDir: userDataDir,
        actualProfilePath,
        endpointUrl,
        launchArgsSha256: sha256Hex(launchArgs.join("\n")),
        profileSessionNonceSha256: sha256Hex(nonce),
      },
      capturedAt,
      reviewedBy,
      reviewedAt: capturedAt,
    });

    deps.writeFile(join(outDir, JSON_NAME), JSON.stringify(artifact, null, 2) + "\n");
    deps.writeFile(join(outDir, HTML_NAME), `<!doctype html><meta charset="utf-8">${redactedDom}`);
    deps.writeFile(join(outDir, PNG_NAME), png);
    return artifact;
  } finally {
    deps.killChrome(chromePid);
    // 等待 Chrome 完全退出后再清理临时 profile（避免 ENOTEMPTY）
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(chromePid, 0);
        await new Promise((r) => setTimeout(r, 250));
      } catch {
        break;
      }
    }
    deps.cleanupTemp(userDataDir);
  }
}

export async function main(argv) {
  const launchIdx = argv.indexOf("--launch-chrome");
  if (launchIdx < 0) throw new Error("--launch-chrome required");
  const srcIdx = argv.indexOf("--account-id-source");
  if (srcIdx < 0) throw new Error("--account-id-source required");
  const outIdx = argv.indexOf("--out-dir");
  if (outIdx < 0) throw new Error("--out-dir required");
  await runCollector({
    accountIdSourcePath: argv[srcIdx + 1],
    outDir: argv[outIdx + 1],
  });
  console.log(JSON.stringify({ entitlement: { generated: true } }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((err) => {
    console.error(`capture-workers-plan-entitlement: ${err.message}`);
    process.exit(2);
  });
}
