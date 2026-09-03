/**
 * T15 Step 3：本地最终验证。按顺序执行 npm test、npm run typecheck、
 * npx wrangler deploy --dry-run，完整 stdout/stderr 追加到 local-tests.txt，
 * 同时原子生成 local-tests.json。JSON 为每条命令记录 command/exitCode，
 * 并为 dry-run 记录解析后的 D1/Queues/AI bindings、禁止资源检查、
 * limits.cpu_ms 缺失断言和 0 * * * * Cron 检查，顶层含 passed。
 * 任一命令非零、必需 binding/Cron 缺失、出现 limits.cpu_ms 或出现
 * KV/R2/Browser/Container 时 passed:false 并非零退出。
 * G1 和 decide 只读取 local-tests.json；txt 仅供人工诊断。
 *
 * 用法：node scripts/phase0/run-local-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonHash } from "./canonical-json.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");

const REQUIRED_BINDINGS = ["D1 Database", "Queue", "AI"];
const FORBIDDEN_RESOURCES = ["KV", "R2", "Browser", "Container"];
const REQUIRED_CRON = "0 * * * *";

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { exitCode: res.status, stdout, stderr, combined: `${stdout}\n${stderr}` };
}

function parseDryRun(text) {
  const bindings = [];
  const forbidden = [];
  let cpuMsPresent = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("limits.cpu_ms")) cpuMsPresent = true;
    for (const b of REQUIRED_BINDINGS) {
      if (trimmed.includes(b) && !bindings.includes(b)) bindings.push(b);
    }
    for (const f of FORBIDDEN_RESOURCES) {
      if (trimmed.includes(f) && !forbidden.includes(f)) forbidden.push(f);
    }
  }

  return {
    bindings,
    forbiddenResources: forbidden,
    cpuMsPresent,
  };
}

/** Cron 从 wrangler.jsonc 配置读取（dry-run 输出不含 triggers 段）。 */
function readCronFromConfig(configPath) {
  try {
    const raw = readFileSync(configPath, "utf8");
    // 只匹配 crons 数组字面量，避免 JSONC 注释剥离破坏 URL 中的 //
    return new RegExp(`["']crons["']\\s*:\\s*\\[[^\\]]*["']${REQUIRED_CRON.replace(/[*]/g, "\\*")}["']`).test(raw);
  } catch {
    return false;
  }
}

export async function main(argv) {
  const outPath = argv[2] ?? join(ARTIFACTS, "local-tests.json");
  const txtPath = argv[3] ?? join(ARTIFACTS, "local-tests.txt");
  mkdirSync(dirname(outPath), { recursive: true });

  const commands = [
    { command: "npm test", bin: "npm", args: ["test"] },
    { command: "npm run typecheck", bin: "npm", args: ["run", "typecheck"] },
    { command: "npx wrangler deploy --dry-run", bin: "npx", args: ["--yes", "wrangler@4.128.0", "deploy", "--dry-run"] },
  ];

  const results = [];
  const txtLines = [];
  for (const c of commands) {
    const r = run(c.bin, c.args);
    results.push({ command: c.command, exitCode: r.exitCode, combined: r.combined });
    txtLines.push(`=== ${c.command} ===`);
    txtLines.push(r.combined);
  }

  const dryRun = results[2];
  const dryParsed = parseDryRun(dryRun.exitCode === 0 ? dryRun.combined : "");
  const cronOk = readCronFromConfig(join(REPO_ROOT, "wrangler.jsonc"));

  const bindingsOk = REQUIRED_BINDINGS.every((b) => dryParsed.bindings.includes(b));
  const forbiddenOk = dryParsed.forbiddenResources.length === 0;
  const cpuMsOk = !dryParsed.cpuMsPresent;
  const allExitOk = results.every((r) => r.exitCode === 0);

  const passed = allExitOk && bindingsOk && forbiddenOk && cronOk && cpuMsOk;

  const artifact = {
    commands: results,
    dryRun: {
      bindings: dryParsed.bindings,
      forbiddenResources: dryParsed.forbiddenResources,
      cronOk,
      cpuMsPresent: dryParsed.cpuMsPresent,
      bindingsOk,
      forbiddenOk,
      cpuMsOk,
    },
    passed,
    checkedAt: new Date().toISOString(),
    canonicalSha256: null,
  };
  artifact.canonicalSha256 = await canonicalJsonHash(artifact);

  // 原子写 JSON
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n");
  renameSync(tmp, outPath);

  // txt 追加（仅供人工诊断）
  appendFileSync(txtPath, txtLines.join("\n") + "\n");

  console.log(JSON.stringify({ passed, exitCodes: results.map((r) => r.exitCode), out: outPath }));
  process.exit(passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`run-local-tests: ${err.message}`);
    process.exit(3);
  });
}
