#!/usr/bin/env node
/**
 * update-baseline.mjs —— 在确认兼容后，把协议基线推进到新的上游 commit。
 *
 * 前置条件（脚本会强制校验）：
 *   1. 漂移检测必须为 IN_SYNC（锁定客户端调用的 procedure 已全部实现）
 *   2. 目标 commit 必须存在于上游 clone 中
 *
 * 行为：
 *   - 更新 config/upstream-baseline.json 的 upstream.commit / commitDate
 *   - 把上游 clone 的 HEAD 移到该 commit（保持工作树与基线一致）
 *   - 不自动 commit：由调用者决定提交粒度
 *
 * 用法：
 *   node .claude/skills/karakeep-protocol-sync/scripts/update-baseline.mjs --to origin/main
 *   node .claude/skills/karakeep-protocol-sync/scripts/update-baseline.mjs --to <sha>
 *   node .claude/skills/karakeep-protocol-sync/scripts/update-baseline.mjs --to origin/main --dry-run
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const DEFAULT_UPSTREAM = path.join(REPO_ROOT, ".phase0/upstream/karakeep");
const BASELINE_FILE = path.join(REPO_ROOT, "config/upstream-baseline.json");
const CHECK_DRIFT = path.join(import.meta.dirname, "check-drift.mjs");

function parseArgs(argv) {
  const args = { to: null, upstream: DEFAULT_UPSTREAM, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") args.to = argv[++i];
    else if (a === "--upstream") args.upstream = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法: node update-baseline.mjs --to <ref> [--upstream <path>] [--dry-run]");
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (!args.to) {
    console.error("缺少 --to <ref>（例如 origin/main 或具体 commit sha）");
    process.exit(2);
  }
  return args;
}

function git(repo, ...cmd) {
  return execFileSync("git", ["-C", repo, ...cmd], { encoding: "utf8" }).trim();
}

function main() {
  const args = parseArgs(process.argv);
  const upstream = path.resolve(args.upstream);

  if (!existsSync(path.join(upstream, ".git"))) {
    console.error(`上游仓库不存在: ${upstream}`);
    process.exit(2);
  }

  // 1. 必须先 IN_SYNC
  let verdict = "UNKNOWN";
  try {
    const out = execFileSync("node", [CHECK_DRIFT, "--no-fetch", "--upstream", upstream], { encoding: "utf8" });
    verdict = JSON.parse(out).verdict;
  } catch (err) {
    // 退出码 1 = DRIFT，仍能拿到 stdout
    if (err.stdout) {
      try { verdict = JSON.parse(err.stdout).verdict; } catch { /* ignore */ }
    }
  }
  if (verdict !== "IN_SYNC") {
    console.error(`拒绝推进基线：漂移检测结果为 ${verdict}，必须先实现缺失的 procedure。`);
    console.error("先运行 check-drift.mjs 查看 missingForClients。");
    process.exit(1);
  }

  // 2. 解析目标 commit
  let target;
  try {
    target = git(upstream, "rev-parse", args.to);
  } catch (err) {
    console.error(`无法解析 --to ${args.to}: ${err.message}`);
    process.exit(2);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const oldCommit = baseline.upstream.commit;
  if (target === oldCommit) {
    console.log(`基线已是 ${target}，无需更新。`);
    process.exit(0);
  }

  const commitDate = git(upstream, "show", "-s", "--format=%cs", target);
  const behindCount = git(upstream, "rev-list", "--count", `${oldCommit}..${target}`);

  if (args.dryRun) {
    console.log(`[dry-run] ${oldCommit} → ${target} (${commitDate}), ${behindCount} 个提交`);
    process.exit(0);
  }

  baseline.upstream.commit = target;
  baseline.upstream.commitDate = commitDate;
  writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);

  // 3. 上游 clone 的 HEAD 跟随基线，使后续 diff 有意义
  git(upstream, "checkout", "--detach", target);

  console.log(`基线已推进：${oldCommit} → ${target} (${commitDate}, ${behindCount} 个提交)`);
  console.log(`已更新 ${path.relative(REPO_ROOT, BASELINE_FILE)}`);
  console.log("请单独提交此变更（与实现改动分开）。");
}

main();
