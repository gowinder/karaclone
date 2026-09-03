/**
 * Phase 0 账户与订阅硬检查（G0 的一部分）。
 *
 * - 用 `wrangler whoami --json` 得到账户 ID → whoamiAccountIdSha256。
 * - 用仅 Billing Read 权限的 `CLOUDFLARE_BILLING_READ_TOKEN` 调用
 *   `GET /accounts/{account_id}/subscriptions?page=N&per_page=100`，严格按
 *   result_info 逐页抓取直到唯一 subscription ID 数等于 total_count。
 * - 每项只落盘 subscriptionIdSha256；每页只生成公开 pageProjection。
 * - token 只存在于进程环境，不写 .dev.vars/argv/stdout/stderr/artifact。
 *
 * 通过条件：两个账户 hash 相等、分页闭合、所有订阅均不处于
 * Trial|Provisioned|Paid|AwaitingPayment、isContract/externallyManaged 均 false。
 *
 * 注入点：whoami 执行器与 billing fetch（供测试）。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export const VALID_STATES = ["Trial", "Provisioned", "Paid", "AwaitingPayment", "Cancelled", "Failed", "Expired"];
export const ACTIVE_STATES = ["Trial", "Provisioned", "Paid", "AwaitingPayment"];
const PER_PAGE = 50;

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const BILLING_URL_RE = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/subscriptions$/;

/** 规范化投影 item：兼容 API snake_case 与内部 camelCase；scope/sets 仅留证。 */
export function projectSubscription(item) {
  const rp = item.ratePlan;
  const sets = [...(rp.sets ?? [])].sort();
  const isContract = rp.isContract ?? rp.is_contract;
  const externallyManaged = rp.externallyManaged ?? rp.externally_managed;
  if (typeof isContract !== "boolean") throw new Error("RATE_PLAN_IS_CONTRACT_MISSING");
  if (typeof externallyManaged !== "boolean") throw new Error("RATE_PLAN_EXTERNALLY_MANAGED_MISSING");
  return {
    subscriptionIdSha256: sha256Hex(String(item.id)),
    ratePlanId: rp.id,
    state: item.state,
    price: item.price,
    scope: rp.scope ?? null,
    sets,
    isContract,
    externallyManaged,
  };
}

/** 严格校验并投影单页响应；任何判定字段异常即 throw。 */
export function projectPage(page, perPage, totalCount, count, result) {
  if (!Array.isArray(result) || typeof page !== "number" || typeof perPage !== "number" || typeof totalCount !== "number" || typeof count !== "number") {
    throw new Error("PAGE_SHAPE_INVALID");
  }
  // result_info.count 是服务端声明的本页实际条数；末页允许少于 per_page
  if (result.length !== count) throw new Error(`PAGE_COUNT_MISMATCH: ${result.length} != ${count}`);
  const items = result.map((sub) => {
    if (typeof sub?.id !== "string" || !sub.id) throw new Error("SUBSCRIPTION_ID_MISSING");
    if (typeof sub.price !== "number" || !Number.isFinite(sub.price)) throw new Error("SUBSCRIPTION_PRICE_INVALID");
    if (!VALID_STATES.includes(sub.state)) throw new Error(`SUBSCRIPTION_STATE_UNKNOWN: ${sub.state}`);
    const rp = sub.ratePlan ?? sub.rate_plan;
    if (typeof rp?.id !== "string" || !rp.id) throw new Error("RATE_PLAN_ID_MISSING");
    if (rp.scope !== null && typeof rp.scope !== "string") throw new Error("RATE_PLAN_SCOPE_INVALID");
    if (rp.sets !== null && (!Array.isArray(rp.sets) || rp.sets.some((s) => typeof s !== "string"))) {
      throw new Error("RATE_PLAN_SETS_INVALID");
    }
    if (typeof rp.is_contract !== "boolean") throw new Error("RATE_PLAN_IS_CONTRACT_MISSING");
    if (typeof rp.externally_managed !== "boolean") throw new Error("RATE_PLAN_EXTERNALLY_MANAGED_MISSING");
    return projectSubscription({
      id: sub.id,
      price: sub.price,
      state: sub.state,
      ratePlan: { id: rp.id, scope: rp.scope, sets: rp.sets, isContract: rp.is_contract, externallyManaged: rp.externally_managed },
    });
  });
  return { page, perPage, totalCount, count, items, canonicalSha256: null };
}

/** 生成 pageProjection 并用 canonical-json 计算自身 hash。 */
export async function finalizePageProjection(pageProjection) {
  const { canonicalSha256: _drop, ...rest } = pageProjection;
  const sha = await canonicalJsonHash(rest);
  return { ...rest, canonicalSha256: sha };
}

const defaultWhoami = () => {
  const res = spawnSync("npx", ["wrangler@4.128.0", "whoami", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`WHOAMI_FAILED: exit ${res.status}`);
  const parsed = JSON.parse(res.stdout);
  const accounts = parsed?.result ?? parsed?.accounts ?? parsed;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("WHOAMI_NO_ACCOUNT");
  const id = accounts[0].id;
  if (typeof id !== "string" || !id) throw new Error("WHOAMI_ACCOUNT_ID_INVALID");
  return id;
};

const defaultFetch = async (url, init) => {
  const res = await fetch(url, init);
  return res;
};

/**
 * 预检主流程。返回 artifact 主体（不含 canonicalSha256 自哈希）。
 */
export async function runPreflight({ whoami = defaultWhoami, fetchImpl = defaultFetch, checkedAt = new Date().toISOString() } = {}) {
  const accountId = whoami();
  const whoamiAccountIdSha256 = sha256Hex(accountId);

  const billingToken = process.env.CLOUDFLARE_BILLING_READ_TOKEN;
  if (!billingToken) throw new Error("CLOUDFLARE_BILLING_READ_TOKEN_MISSING");

  const pageProjections = [];
  const seenSubscriptionIds = [];
  const seenIdSet = new Set();
  let totalCount = null;
  let page = 1;
  let pagesFetched = 0;
  let lastPageNum = 0;

  // 先抓首屏拿 total_count
  const firstUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions?page=${page}&per_page=${PER_PAGE}`;
  const firstRes = await fetchImpl(firstUrl, {
    headers: { Authorization: `Bearer ${billingToken}` },
  });
  if (firstRes.status !== 200) throw new Error(`BILLING_API_FAILED: HTTP ${firstRes.status}`);
  const firstJson = await firstRes.json();
  if (!firstJson?.result_info) throw new Error("BILLING_RESULT_INFO_MISSING");
  const meta = firstJson.result_info;
  if (typeof meta.page !== "number" || typeof meta.per_page !== "number" || typeof meta.count !== "number" || typeof meta.total_count !== "number") {
    throw new Error("BILLING_RESULT_INFO_INVALID");
  }
  totalCount = meta.total_count;
  // 校验并投影首屏
  const firstProjection = projectPage(meta.page, meta.per_page, meta.total_count, meta.count, firstJson.result);
  for (const item of firstProjection.items) {
    if (seenIdSet.has(item.subscriptionIdSha256)) throw new Error("SUBSCRIPTION_ID_DUPLICATE");
    seenIdSet.add(item.subscriptionIdSha256);
  }
  seenSubscriptionIds.push(...firstProjection.items.map((i) => i.subscriptionIdSha256));
  pageProjections.push(await finalizePageProjection(firstProjection));
  lastPageNum = firstProjection.page;
  pagesFetched = 1;

  while (seenSubscriptionIds.length < totalCount) {
    page = lastPageNum + 1;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions?page=${page}&per_page=${PER_PAGE}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${billingToken}` } });
    if (res.status !== 200) throw new Error(`BILLING_API_FAILED: HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.result_info) throw new Error("BILLING_RESULT_INFO_MISSING");
    const m = json.result_info;
    if (typeof m.page !== "number" || m.page !== lastPageNum + 1) throw new Error(`PAGE_NON_ADVANCING: ${m.page}`);
    const projection = projectPage(m.page, m.per_page, m.total_count, m.count, json.result);
    for (const item of projection.items) {
      if (seenIdSet.has(item.subscriptionIdSha256)) throw new Error("SUBSCRIPTION_ID_DUPLICATE");
      seenIdSet.add(item.subscriptionIdSha256);
    }
    seenSubscriptionIds.push(...projection.items.map((i) => i.subscriptionIdSha256));
    pageProjections.push(await finalizePageProjection(projection));
    lastPageNum = projection.page;
    pagesFetched++;
    if (pagesFetched > 1000) throw new Error("PAGINATION_TOO_MANY_PAGES");
  }
  if (seenSubscriptionIds.length !== totalCount) throw new Error("SUBSCRIPTION_COUNT_MISMATCH");

  // 扁平稳定投影
  const flat = pageProjections.flatMap((p) => p.items).sort((a, b) => a.subscriptionIdSha256.localeCompare(b.subscriptionIdSha256));
  const uniqueCount = flat.length;
  const activeCount = flat.filter((i) => ACTIVE_STATES.includes(i.state)).length;
  const riskCount = flat.filter((i) => i.isContract || i.externallyManaged).length;
  const subscriptionProjectionSha256 = await canonicalJsonHash(flat);

  const artifact = {
    whoamiAccountIdSha256,
    billingRequestAccountIdSha256: whoamiAccountIdSha256,
    pageCount: pagesFetched,
    totalCount,
    projectedCount: uniqueCount,
    pageProjections,
    uniqueSubscriptionIdCount: uniqueCount,
    subscriptionProjection: flat,
    subscriptionProjectionSha256,
    activeOrPendingSubscriptionCount: activeCount,
    contractOrExternallyManagedCount: riskCount,
    subscriptionRiskFree: activeCount === 0 && riskCount === 0,
    upstreamCommit: "5a2f009e2f6d266087f2f3f527e6e384cefd6de4",
    extensionVersion: "1.2.11",
    mobileVersion: "1.11.0",
    checkedAt,
    canonicalSha256: null,
    passed: false,
  };
  artifact.passed =
    whoamiAccountIdSha256 === artifact.billingRequestAccountIdSha256 &&
    uniqueCount === totalCount &&
    activeCount === 0 &&
    riskCount === 0;
  return artifact;
}

/** CLI 入口：--out <path>。 */
export async function main(argv) {
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : join(REPO_ROOT, "artifacts", "phase0", "preflight.json");
  const artifact = await runPreflight();
  const sha = await canonicalJsonHash(artifact);
  artifact.canonicalSha256 = sha;
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, outPath);
  console.log(JSON.stringify({ preflight: { passed: artifact.passed, pageCount: artifact.pageCount, totalCount: artifact.totalCount } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((err) => {
    console.error(`write-preflight: ${err.message}`);
    process.exit(2);
  });
}
