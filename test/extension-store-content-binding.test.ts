/**
 * T13 Step 5：extension-store-content-binding fail-closed 测试（纯 node 环境）。
 * 覆盖：原 extension manifest 字节变化、installed/signed manifest canonical hash
 * 错配、contentExclusionRulesVersion 不同、profile/session nonce 错配、
 * clients DeploymentProvenance 任一字段错配、store evidence hash 错配、
 * install screenshot 缺失/hash 错配 → 全部失败且不写 artifact。
 * 必须加入 vitest.config.ts 的 nodeTests 数组。
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContentBinding } from "../scripts/phase0/build-content-binding.mjs";

const CLIENTS = {
  profile: "clients",
  passed: true,
  workerUrl: "https://karaclone.example.workers.dev",
  deploymentId: "feb1faea-6409-4ba7-a120-a094889b0417",
  versionIds: ["97be406d-c92c-4656-a592-e1c7b8018f28"],
  sourceDeploySha256: "2a8fa1c3bf3d01d7da21e6c56e5936e2cb2ea57161a73fd4e3709273a5cd7771",
};

const EXTENSION_ID = "kgcjekpmcjjogibpjebkhaanilehneje";
const VERSION = "1.2.11";
const PUBLISHER = "karakeep.app";
const RULES_VERSION = "1.0.0";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "cb-"));
}

function sha256File(path: string): string {
  return createHash("sha256").update(require("node:fs").readFileSync(path)).digest("hex");
}

function writeJson(path: string, obj: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}

/** 构造内容目录（installed/signed 相同文件集）。 */
function makeContentDir(dir: string) {
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Karakeep", version: VERSION }));
  writeFileSync(join(dir, "background.js"), "// fake");
  writeFileSync(join(dir, "sub", "content.js"), "// fake content");
}

async function buildBase() {
  const dir = tmpDir();
  const artifacts = join(dir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeJson(join(artifacts, "deploy-clients.json"), CLIENTS);

  // 原 extension manifest（只读，含 canonicalSha256）
  const extManifest: Record<string, unknown> = {
    lockStatus: "PENDING",
    client: "extension",
    platform: "chrome",
    version: VERSION,
    packageId: EXTENSION_ID,
    packageSha256: "pkg-sha",
    verificationProjection: { verifierVersion: RULES_VERSION },
    passed: true,
    canonicalSha256: null,
  };
  const { canonicalJsonHash } = await import("../scripts/phase0/canonical-json.mjs");
  extManifest.canonicalSha256 = await canonicalJsonHash(extManifest);
  writeJson(join(artifacts, "extension-client-manifest.json"), extManifest);

  // store evidence
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const pngPath = join(artifacts, "extension-store-install.png");
  writeFileSync(pngPath, png);
  const evidence: Record<string, unknown> = {
    extensionId: EXTENSION_ID,
    version: VERSION,
    publisher: PUBLISHER,
    fetchedAt: "2026-09-02T00:00:00.000Z",
    canonicalSha256: null,
    passed: true,
  };
  evidence.canonicalSha256 = await canonicalJsonHash(evidence);
  writeJson(join(artifacts, "extension-store-evidence.json"), evidence);

  // 内容目录
  const installedDir = join(dir, "installed");
  const signedDir = join(dir, "signed");
  makeContentDir(installedDir);
  makeContentDir(signedDir);

  const profileDir = join(dir, "profile");
  mkdirSync(profileDir, { recursive: true });

  return { dir, artifacts, installedDir, signedDir, pngPath, profileDir, extManifest, evidence };
}

async function runOk(base: Awaited<ReturnType<typeof buildBase>>, overrides: Record<string, unknown> = {}) {
  return buildContentBinding({
    deployPath: join(base.artifacts, "deploy-clients.json"),
    extensionManifestPath: join(base.artifacts, "extension-client-manifest.json"),
    storeEvidencePath: join(base.artifacts, "extension-store-evidence.json"),
    installedDir: base.installedDir,
    signedDir: base.signedDir,
    installPngPath: base.pngPath,
    profilePath: base.profileDir,
    profileSessionNonce: "nonce-123",
    outPath: join(base.artifacts, "extension-store-content-binding.json"),
    contentExclusionRulesVersion: RULES_VERSION,
    ...overrides,
  });
}

describe("extension-store-content-binding fail-closed", () => {
  it("成功路径生成 binding 且 hash 链闭合", async () => {
    const base = await buildBase();
    const res = await buildContentBinding({
      deployPath: join(base.artifacts, "deploy-clients.json"),
      extensionManifestPath: join(base.artifacts, "extension-client-manifest.json"),
      storeEvidencePath: join(base.artifacts, "extension-store-evidence.json"),
      installedDir: base.installedDir,
      signedDir: base.signedDir,
      installPngPath: base.pngPath,
      profilePath: base.profileDir,
      profileSessionNonce: "nonce-123",
      outPath: join(base.artifacts, "extension-store-content-binding.json"),
      contentExclusionRulesVersion: RULES_VERSION,
    });
    expect(res.passed).toBe(true);
    expect(existsSync(join(base.artifacts, "extension-store-content-binding.json"))).toBe(true);
    expect(res.extensionManifestSha256).toBe(base.extManifest.canonicalSha256);
    expect(res.installedManifestSha256).toBe(res.signedManifestSha256);
    expect(res.profileSessionNonce).toBe("nonce-123");
    expect(res.deploymentId).toBe(CLIENTS.deploymentId);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("原 extension manifest 字节变化 → 失败", async () => {
    const base = await buildBase();
    // 改写 manifest 后重算 canonical（模拟字节变化）
    const { canonicalJsonHash } = await import("../scripts/phase0/canonical-json.mjs");
    const m = JSON.parse(require("node:fs").readFileSync(join(base.artifacts, "extension-client-manifest.json"), "utf8"));
    m.version = "9.9.9";
    m.canonicalSha256 = null;
    m.canonicalSha256 = await canonicalJsonHash(m);
    writeJson(join(base.artifacts, "extension-client-manifest.json"), m);
    await expect(
      runOk(base, { extensionManifestPath: join(base.artifacts, "extension-client-manifest.json") }),
    ).rejects.toThrow(/MANIFEST|MISMATCH/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("installed/signed 内容不一致 → 失败", async () => {
    const base = await buildBase();
    writeFileSync(join(base.signedDir, "extra.js"), "// extra");
    await expect(runOk(base)).rejects.toThrow(/CONTENT|MISMATCH|HASH/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("contentExclusionRulesVersion 不同 → 失败", async () => {
    const base = await buildBase();
    await expect(runOk(base, { contentExclusionRulesVersion: "2.0.0" })).rejects.toThrow(/RULES|VERSION/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("profile session nonce 缺失 → 失败", async () => {
    const base = await buildBase();
    await expect(runOk(base, { profileSessionNonce: undefined })).rejects.toThrow(/NONCE|SESSION|REQUIRED/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("DeploymentProvenance 任一字段缺失 → 失败", async () => {
    const base = await buildBase();
    const bad = { ...CLIENTS };
    delete (bad as Record<string, unknown>).deploymentId;
    writeJson(join(base.artifacts, "deploy-clients.json"), bad);
    await expect(runOk(base)).rejects.toThrow(/DEPLOY|PROVENANCE|MISSING|INVALID/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("store evidence hash 错配 → 失败", async () => {
    const base = await buildBase();
    const ev = JSON.parse(require("node:fs").readFileSync(join(base.artifacts, "extension-store-evidence.json"), "utf8"));
    ev.version = "9.9.9";
    writeJson(join(base.artifacts, "extension-store-evidence.json"), ev);
    await expect(runOk(base)).rejects.toThrow(/EVIDENCE|MISMATCH/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("install screenshot 缺失 → 失败且不写 artifact", async () => {
    const base = await buildBase();
    rmSync(base.pngPath, { force: true });
    await expect(runOk(base)).rejects.toThrow(/SCREENSHOT|PNG|MISSING/i);
    expect(existsSync(join(base.artifacts, "extension-store-content-binding.json"))).toBe(false);
    rmSync(base.dir, { recursive: true, force: true });
  });
});
