#!/usr/bin/env node
/**
 * check-drift.mjs —— 比对上游 Karakeep tRPC 协议 与 KaraClone 实现，输出漂移报告。
 *
 * 输出 JSON（stdout），退出码：
 *   0 = 无漂移（锁定客户端调用的 procedure 已被完整覆盖）
 *   1 = 有漂移（客户端会调用但本仓库未实现的 procedure）
 *   2 = 检测失败（上游仓库不可用、基线文件缺失等）
 *
 * 用法：
 *   node scripts/check-drift.mjs                    # 先 git fetch origin main 再比对
 *   node scripts/check-drift.mjs --no-fetch         # 离线，用已 fetch 的 origin/main
 *   node scripts/check-drift.mjs --upstream <path>  # 指定上游仓库路径
 *
 * 设计要点：上游 commit 变了不等于本仓库要改代码。真正会让客户端崩溃的是
 * 「锁定客户端会调用的 procedure，本仓库没实现」。因此只有这类差异判为
 * breaking；内部实现调整、与客户端无关的 router 变更仅作为 info 列出。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// 脚本位于 <repo>/.claude/skills/karakeep-protocol-sync/scripts/
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const DEFAULT_UPSTREAM = path.join(REPO_ROOT, ".phase0/upstream/karakeep");
const BASELINE_FILE = path.join(REPO_ROOT, "config/upstream-baseline.json");

function parseArgs(argv) {
  const args = { fetch: true, upstream: DEFAULT_UPSTREAM };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-fetch") args.fetch = false;
    else if (a === "--upstream") args.upstream = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/check-drift.mjs [--no-fetch] [--upstream <path>]");
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function git(repo, ...cmd) {
  return execFileSync("git", ["-C", repo, ...cmd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** 锁定客户端实际调用的 tRPC procedure 集合。 */
function extractClientSurface(upstream) {
  const out = execFileSync(
    "grep",
    [
      "-rhoE", "api\\.[a-zA-Z]+\\.[a-zA-Z]+",
      path.join(upstream, "apps/mobile"),
      path.join(upstream, "apps/browser-extension"),
      "--include=*.ts", "--include=*.tsx",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const set = new Set();
  for (const line of out.split("\n")) {
    const m = /^api\.([a-zA-Z]+)\.([a-zA-Z]+)$/.exec(line.trim());
    if (!m || m[1] === "v1" || m[1] === "trpc") continue;
    set.add(`${m[1]}.${m[2]}`);
  }
  return [...set].sort();
}

/**
 * 本仓库实现的 procedure 集合。
 * router.ts 是权威注册表：`<upstreamRouterName>: <localRouterVar>`，
 * 配合各 router 文件的 import 路径，即可把文件名映射回上游 router 名，
 * 无需硬编码或猜测（api-keys.ts → apiKeys、imports.ts → imports）。
 */
function extractImplementedSurface(repoRoot) {
  const routerSrc = readFileSync(path.join(repoRoot, "src/trpc/router.ts"), "utf8");

  // `<localVar>: <upstreamName>` —— 从 `router({...})` 注册块里取
  const registrations = new Map();
  for (const m of routerSrc.matchAll(/^\s{2}([a-zA-Z]+):\s*([a-zA-Z]+),$/gm)) {
    registrations.set(m[2], m[1]); // localVar → upstreamName
  }

  // `<localVar>` ← import { <localVar> } from "./routers/<file>.js"
  const impl = new Set();
  for (const m of routerSrc.matchAll(/import\s*\{\s*([a-zA-Z]+)\s*\}\s*from\s*"\.\/routers\/([a-zA-Z-]+)\.js"/g)) {
    const [, localVar, file] = m;
    const upstreamName = registrations.get(localVar);
    if (!upstreamName) continue; // 未注册进 appRouter 的模块不算
    const body = readFileSync(path.join(repoRoot, "src/trpc/routers", `${file}.ts`), "utf8");
    for (const p of body.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*):\s*[a-zA-Z]+[Pp]rocedure/gm)) {
      impl.add(`${upstreamName}.${p[1]}`);
    }
  }
  return [...impl].sort();
}

function main() {
  const args = parseArgs(process.argv);
  const upstream = path.resolve(args.upstream);

  if (!existsSync(path.join(upstream, ".git"))) {
    console.error(`上游仓库不存在或不是 git 仓库: ${upstream}`);
    process.exit(2);
  }
  if (!existsSync(BASELINE_FILE)) {
    console.error(`缺少基线文件: ${BASELINE_FILE}`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const pinned = baseline.upstream.commit;

  if (args.fetch) {
    try {
      git(upstream, "fetch", "origin", "main");
    } catch (err) {
      console.error(`git fetch 失败（可用 --no-fetch 跳过）: ${err.message}`);
      process.exit(2);
    }
  }

  const latest = git(upstream, "rev-parse", "origin/main");
  const behind = Number(git(upstream, "rev-list", "--count", `${pinned}..origin/main`)) || 0;

  // 协议相关文件是否变更（info 级）
  const protocolFilesChanged = git(
    upstream, "diff", "--name-only", pinned, "origin/main",
    "--", "packages/trpc/routers/", "packages/shared/types/",
  ).split("\n").filter(Boolean);

  const clientNeeds = extractClientSurface(upstream);
  const implemented = extractImplementedSurface(REPO_ROOT);
  const implementedSet = new Set(implemented);
  const missing = clientNeeds.filter((p) => !implementedSet.has(p));

  const report = {
    baselinePinnedCommit: pinned,
    upstreamLatestCommit: latest,
    commitsBehind: behind,
    protocolFilesChanged,
    clientSurfaceTotal: clientNeeds.length,
    clientSurface: clientNeeds,
    implementedTotal: implemented.length,
    implemented,
    missingForClients: missing,
    verdict: missing.length ? "DRIFT" : "IN_SYNC",
  };
  console.log(JSON.stringify(report, null, 2));

  if (missing.length) {
    console.error(`\n⚠️  锁定客户端会调用、但本仓库未实现的 procedure (${missing.length}):`);
    for (const p of missing) console.error(`   - ${p}`);
    console.error("\n客户端可能报错。修复流程见 REFERENCE.md。");
    process.exit(1);
  }
  process.exit(0);
}

main();
