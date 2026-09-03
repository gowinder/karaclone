/**
 * T12 Step 3：真实 Workers AI gate。POST /__phase0/ai-json 一次，
 * 要求 HTTP 200、model 精确等于锁定模型、validated===true、1-8 个非空 tags、
 * description 为字符串或 null。输出 artifacts/phase0/ai.json。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, loadDeployArtifact, PROVENANCE_KEYS } from "./remote-common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const LOCKED_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const defaultFetch = async (url, init) => fetch(url, init);

export async function runAiProbe({ deployPath, apiKey, fetchImpl = defaultFetch, checkedAt = new Date().toISOString() }) {
  const deployArtifact = loadDeployArtifact(deployPath, "probes");
  const url = deployArtifact.workerUrl;
  const checks = {};
  let http1102Count = 0;
  let body = null;
  let error = null;

  try {
    const res = await fetchImpl(`${url}/__phase0/ai-json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 1102) http1102Count++;
    checks.http200 = res.status === 200;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
      checks.validJson = false;
    }
    if (body) {
      checks.validJson = true;
      checks.modelExact = body.model === LOCKED_MODEL;
      checks.validated = body.validated === true;
      checks.tagsCount = Array.isArray(body.tags) ? body.tags.length : 0;
      checks.tagsInRange = checks.tagsCount >= 1 && checks.tagsCount <= 8;
      checks.tagsNonEmpty = Array.isArray(body.tags) && body.tags.every((t) => typeof t === "string" && t.trim().length > 0);
      checks.descriptionOk = body.description === null || typeof body.description === "string";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const passed =
    checks.http200 === true &&
    checks.validJson === true &&
    checks.modelExact === true &&
    checks.validated === true &&
    checks.tagsInRange === true &&
    checks.tagsNonEmpty === true &&
    checks.descriptionOk === true &&
    http1102Count === 0;

  const artifact = {
    profile: "probes",
    ...Object.fromEntries(PROVENANCE_KEYS.map((k) => [k, deployArtifact[k]])),
    checks,
    model: body?.model ?? null,
    tags: body?.tags ?? [],
    description: body?.description ?? null,
    http1102Count,
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
  const { deploy, out } = args;
  if (!deploy || !out) throw new Error("Usage: run-ai-probe.mjs --deploy <deploy-probes.json> --out <ai.json>");
  const apiKey = process.env.PHASE0_API_KEY;
  if (!apiKey) throw new Error("PHASE0_API_KEY_MISSING");
  const artifact = await runAiProbe({ deployPath: deploy, apiKey });
  await atomicWriteJson(out, artifact);
  console.log(JSON.stringify({ ai: { passed: artifact.passed, model: artifact.model, tags: artifact.tags?.length ?? 0 } }));
  process.exit(artifact.passed ? 0 : 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv).catch((err) => {
    console.error(`run-ai-probe: ${err.message}`);
    process.exit(2);
  });
}
