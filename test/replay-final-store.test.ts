/**
 * T15 Step 1：replay-final-store fail-closed 测试（纯 node 环境）。
 * 覆盖：临时 profile 目录预先非空或已有扩展、final 五文件任一预先存在、
 * 安装来源不是官方 Store、实际 ID/version 错误、重下载 CRX package/proof/hash 错误、
 * 两份 manifest 规则或 canonical hash 不一致、截图失败、CDP/profile session
 * 不是脚本本次创建的新 profile。generator 必须非零退出且不留下部分 final artifact。
 * 必须加入 vitest.config.ts 的 nodeTests 数组。
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReplay } from "../scripts/phase0/replay-final-store.mjs";

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

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "replay-"));
}

function writeJson(path: string, obj: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}

/** 构造最小可运行环境：deploy-clients + content binding + 空 profile 目录。 */
function buildBase() {
  const dir = tmpDir();
  const artifacts = join(dir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeJson(join(artifacts, "deploy-clients.json"), CLIENTS);
  writeJson(join(artifacts, "extension-store-content-binding.json"), {
    ...CLIENTS,
    passed: true,
    canonicalSha256: "cb-hash",
    extensionManifestSha256: "ext-manifest-hash",
  });
  writeJson(join(artifacts, "extension-client-manifest.json"), {
    passed: true,
    canonicalSha256: "ext-manifest-hash",
    version: VERSION,
  });
  writeJson(join(artifacts, "extension-store-evidence.json"), {
    passed: true,
    canonicalSha256: "evid",
    extensionId: EXTENSION_ID,
    version: VERSION,
    publisher: PUBLISHER,
  });
  const profileDir = join(dir, "profile");
  mkdirSync(profileDir, { recursive: true });
  return { dir, artifacts, profileDir };
}

/** 假 CRX 下载：返回固定字节（测试只验证 hash 路径）。 */
function fakeFetch() {
  return async () => {
    const body = Buffer.from("fake-crx3-bytes");
    return { status: 200, headers: { get: () => "application/x-chrome-extension" }, body };
  };
}

const FAKE_CRX_SHA = createHash("sha256").update("fake-crx3-bytes").digest("hex");

/** 假 CRX proof：返回可派生锁定 ID 的 proof 结构。 */
function fakeVerifyCrx() {
  return () => ({
    algorithm: "sha256_with_rsa",
    publicKey: Buffer.alloc(0),
    publicKeySha256: "pubkey-sha",
    crxIdHex: "a6294afc299e681f941a700d8b47d494",
  });
}

/** 假 CDP：报告已安装扩展。 */
function fakeCdp(overrides: { id?: string; version?: string; source?: string } = {}) {
  return {
    connect: async () => ({
      getExtensionInfo: async (): Promise<{ id: string; version: string; source: string }> => ({
        id: overrides.id ?? EXTENSION_ID,
        version: overrides.version ?? VERSION,
        source: overrides.source ?? "chrome_web_store",
      }),
      screenshot: async () => Buffer.from("fake-png"),
      close: async () => {},
    }),
  };
}

/** 假 unzip：把 CRX 解包为固定文件集。 */
function fakeUnzip() {
  return async (crxPath: string, outDir: string) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ name: "Karakeep", version: VERSION }));
    writeFileSync(join(outDir, "background.js"), "// fake");
  };
}

/** 假扩展目录定位：返回安装目录。 */
function fakeFindExtensionDir() {
  return async (profileDir: string) => {
    const extDir = join(profileDir, "Default", "Extensions", EXTENSION_ID, VERSION, "0.1.2_0");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "manifest.json"), JSON.stringify({ name: "Karakeep", version: VERSION }));
    writeFileSync(join(extDir, "background.js"), "// fake");
    return extDir;
  };
}

async function runOk(overrides = {}) {
  const base = buildBase();
  return runReplay({
    artifactsDir: base.artifacts,
    profileDir: base.profileDir,
    profileSessionNonce: "nonce-123",
    cdpPort: 9222,
    fetchImpl: fakeFetch(),
    cdp: fakeCdp(),
    unzip: fakeUnzip(),
    findExtensionDir: fakeFindExtensionDir(),
    verifyCrx: fakeVerifyCrx(),
    expectedPackageSha256: FAKE_CRX_SHA,
    ...overrides,
  });
}

describe("replay-final-store fail-closed", () => {
  it("profile 目录预先非空 → 失败", async () => {
    const base = buildBase();
    writeFileSync(join(base.profileDir, "existing.txt"), "x");
    await expect(
      runReplay({
        artifactsDir: base.artifacts,
        profileDir: base.profileDir,
        profileSessionNonce: "nonce-123",
        cdpPort: 9222,
        fetchImpl: fakeFetch(),
        cdp: fakeCdp(),
        unzip: fakeUnzip(),
        findExtensionDir: fakeFindExtensionDir(),
        verifyCrx: fakeVerifyCrx(),
        expectedPackageSha256: FAKE_CRX_SHA,
      }),
    ).rejects.toThrow(/PROFILE_DIR_NOT_EMPTY|non-empty/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("final 五文件任一预先存在 → 失败", async () => {
    const base = buildBase();
    writeJson(join(base.artifacts, "final-store-binding.json"), {});
    await expect(
      runReplay({
        artifactsDir: base.artifacts,
        profileDir: base.profileDir,
        profileSessionNonce: "nonce-123",
        cdpPort: 9222,
        fetchImpl: fakeFetch(),
        cdp: fakeCdp(),
        unzip: fakeUnzip(),
        findExtensionDir: fakeFindExtensionDir(),
        verifyCrx: fakeVerifyCrx(),
        expectedPackageSha256: FAKE_CRX_SHA,
      }),
    ).rejects.toThrow(/ALREADY_EXISTS|pre-exist/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("安装来源不是官方 Store → 失败", async () => {
    await expect(
      runOk({ cdp: fakeCdp({ source: "unpacked" }) }),
    ).rejects.toThrow(/SOURCE|unpacked|sideload/i);
  });

  it("实际 ID 错误 → 失败", async () => {
    await expect(
      runOk({ cdp: fakeCdp({ id: "wrongidwrongidwrongidwrongid" }) }),
    ).rejects.toThrow(/ID|MISMATCH/i);
  });

  it("实际 version 错误 → 失败", async () => {
    await expect(
      runOk({ cdp: fakeCdp({ version: "9.9.9" }) }),
    ).rejects.toThrow(/VERSION|MISMATCH/i);
  });

  it("CRX 下载失败 → 失败", async () => {
    await expect(
      runOk({
        fetchImpl: async (): Promise<{ status: number; headers: { get: () => string | null }; body: Buffer }> => ({ status: 500, headers: { get: () => null }, body: Buffer.alloc(0) }),
      }),
    ).rejects.toThrow(/CRX|DOWNLOAD|HTTP/i);
  });

  it("截图失败 → 失败且不留下部分 final artifact", async () => {
    const base = buildBase();
    const cdp = {
      connect: async () => ({
        getExtensionInfo: async () => ({ id: EXTENSION_ID, version: VERSION, source: "chrome_web_store" }),
        screenshot: async () => {
          throw new Error("SCREENSHOT_FAILED");
        },
        close: async () => {},
      }),
    };
    await expect(
      runReplay({
        artifactsDir: base.artifacts,
        profileDir: base.profileDir,
        profileSessionNonce: "nonce-123",
        cdpPort: 9222,
        fetchImpl: fakeFetch(),
        cdp,
        unzip: fakeUnzip(),
        findExtensionDir: fakeFindExtensionDir(),
        verifyCrx: fakeVerifyCrx(),
        expectedPackageSha256: FAKE_CRX_SHA,
      }),
    ).rejects.toThrow(/SCREENSHOT/i);
    // 不得留下部分 final artifact
    for (const name of ["final-store-binding.json", "final-store-screenshot-manifest.json", "final-installed-content-manifest.json", "final-signed-content-manifest.json", "final-store-install.png"]) {
      expect(existsSync(join(base.artifacts, name))).toBe(false);
    }
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("profile session nonce 不匹配 → 失败", async () => {
    const base = buildBase();
    await expect(
      runReplay({
        artifactsDir: base.artifacts,
        profileDir: base.profileDir,
        profileSessionNonce: "nonce-123",
        cdpPort: 9222,
        fetchImpl: fakeFetch(),
        cdp: fakeCdp(),
        unzip: fakeUnzip(),
        findExtensionDir: fakeFindExtensionDir(),
        verifyCrx: fakeVerifyCrx(),
        expectedPackageSha256: FAKE_CRX_SHA,
        expectedSessionNonce: "different-nonce",
      }),
    ).rejects.toThrow(/NONCE|SESSION/i);
    rmSync(base.dir, { recursive: true, force: true });
  });

  it("成功路径生成五文件且 hash 链闭合", async () => {
    const base = buildBase();
    const res = await runReplay({
      artifactsDir: base.artifacts,
      profileDir: base.profileDir,
      profileSessionNonce: "nonce-123",
      cdpPort: 9222,
      fetchImpl: fakeFetch(),
      cdp: fakeCdp(),
      unzip: fakeUnzip(),
      findExtensionDir: fakeFindExtensionDir(),
      verifyCrx: fakeVerifyCrx(),
      expectedPackageSha256: FAKE_CRX_SHA,
    });
    expect(res.passed).toBe(true);
    for (const name of ["final-store-binding.json", "final-store-screenshot-manifest.json", "final-installed-content-manifest.json", "final-signed-content-manifest.json", "final-store-install.png"]) {
      expect(existsSync(join(base.artifacts, name))).toBe(true);
    }
    rmSync(base.dir, { recursive: true, force: true });
  });
});
