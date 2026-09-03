/**
 * T12 Step 4 编排器：启动时校验 production 与 deploy-probes 精确一致，
 * 依次生成 contract/AI，再并行执行 Queue 子探针（135min 硬 deadline）。
 * 输出 remote-contract.json / ai.json / queue.json。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDrift, atomicWriteJson, loadApiKey, loadDeployArtifact } from "./remote-common.mjs";
import { runContract } from "./remote-contract.mjs";
import { runAiProbe } from "./run-ai-probe.mjs";
import { runQueue } from "./run-queue-probe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ARTIFACTS = join(REPO_ROOT, "artifacts", "phase0");
const defaultSpawn = (cmd, args) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: REPO_ROOT });

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
  const deployPath = args.deploy ?? join(ARTIFACTS, "deploy-probes.json");
  const apiKey = process.env.PHASE0_API_KEY ?? loadApiKey(join(REPO_ROOT, ".dev.vars"));

  const deployArtifact = loadDeployArtifact(deployPath, "probes");
  // 启动时 production 漂移检查
  assertNoDrift(defaultSpawn, deployArtifact, "START");

  // 1. contract
  const contract = await runContract({ deployPath, apiKey });
  if (!contract.passed) {
    console.error(JSON.stringify({ contract: { passed: false, error: contract.error } }));
    process.exit(2);
  }

  // 2. AI（模型冷启动瞬时失败 → 最多重试 2 次）
  let ai = await runAiProbe({ deployPath, apiKey });
  for (let attempt = 0; !ai.passed && attempt < 2; attempt++) {
    console.error(JSON.stringify({ ai: { passed: false, error: ai.error, retry: attempt + 1 } }));
    await new Promise((r) => setTimeout(r, 5000));
    ai = await runAiProbe({ deployPath, apiKey });
  }
  if (!ai.passed) {
    await atomicWriteJson(join(ARTIFACTS, "ai.json"), ai);
    console.error(JSON.stringify({ ai: { passed: false, error: ai.error } }));
    process.exit(2);
  }

  // 3. Queue（并行子探针，135min）
  const queue = await runQueue({ deployPath, apiKey });

  await atomicWriteJson(join(ARTIFACTS, "remote-contract.json"), contract);
  await atomicWriteJson(join(ARTIFACTS, "ai.json"), ai);
  await atomicWriteJson(join(ARTIFACTS, "queue.json"), queue);

  console.log(JSON.stringify({ gates: { contract: contract.passed, ai: ai.passed, queue: queue.passed } }));
  process.exit(contract.passed && ai.passed && queue.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`run-remote-gates: ${err.message}`);
    process.exit(2);
  });
}
