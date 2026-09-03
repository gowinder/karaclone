import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAndroidPackage, ANDROID_LOCK, redactToolOutput } from "../scripts/phase0/verify-android-package.mjs";
import { verifyExtensionPackage, verifyCrxProof, deriveExtensionId, EXTENSION_LOCK } from "../scripts/phase0/verify-extension-package.mjs";
import { canonicalJsonHash } from "../scripts/phase0/canonical-json.mjs";

/* =========================== Android fixtures =========================== */

const FAKE_APK = Buffer.from("PK\u0003\u0004fake-apk-content-for-testing-only", "utf8");

function makeAssetsApi(size = FAKE_APK.length, id = ANDROID_LOCK.assetId) {
  return JSON.stringify({
    tag_name: "1.11.0",
    assets: [{ id, size, browser_download_url: ANDROID_LOCK.url }],
  });
}

const androidFetchOk = () => async (url: string) => {
  if (url === ANDROID_LOCK.url) return { status: 200, finalUrl: ANDROID_LOCK.url, body: FAKE_APK };
  if (url.includes("api.github.com")) {
    return { status: 200, finalUrl: url, body: new TextEncoder().encode(makeAssetsApi()) };
  }
  throw new Error(`unexpected url ${url}`);
};

function fakeAndroidTools(opts: { certFp?: string; appId?: string; vname?: string; vcode?: string; failApksigner?: boolean } = {}) {
  const {
    certFp = ANDROID_LOCK.signingCertificateSha256,
    appId = ANDROID_LOCK.packageId,
    vname = ANDROID_LOCK.versionName,
    vcode = String(ANDROID_LOCK.versionCode),
    failApksigner = false,
  } = opts;
  return (_tool: string, args: string[]): { status: number; stdout: string; stderr: string } => {
    const cmd = args[0];
    if (cmd === "verify") {
      if (failApksigner) return { status: 2, stdout: "", stderr: "DOES NOT VERIFY" };
      return { status: 0, stdout: `Verifies\nSigner #1 certificate SHA-256 digest:\n${certFp}\n`, stderr: "" };
    }
    if (cmd === "manifest") {
      if (args[1] === "application-id") return { status: 0, stdout: `${appId}\n`, stderr: "" };
      if (args[1] === "version-name") return { status: 0, stdout: `${vname}\n`, stderr: "" };
      if (args[1] === "version-code") return { status: 0, stdout: `${vcode}\n`, stderr: "" };
    }
    return { status: 2, stdout: "", stderr: "unexpected invocation" };
  };
}

/* =========================== Extension fixtures =========================== */

// 构造最小 CRX3：Cr24 + version=3 + protobuf header + zip。
// SignedData { bytes public_key = 1; bytes signature = 2; }（CrxFileHeader 字段 1）
// 签名覆盖 "CRX3 SignedData\x00" + archive（本构造无 signed_header_data）。
function varintLen(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
function buildCrx3For(keyPair: { publicKey: Buffer; privateKey: string }) {
  const zipContent = Buffer.from("PK\u0003\u0004fake-extension-zip", "utf8");
  const pubBytes = keyPair.publicKey;
  const signedContext = Buffer.from("CRX3 SignedData\x00", "latin1");
  const toSign = Buffer.concat([signedContext, zipContent]);
  const signature = sign("RSA-SHA256", toSign, keyPair.privateKey);
  // SignedData { public_key = 1 (0x0a); signature = 2 (0x12) }
  const signedDataFull = Buffer.concat([
    Buffer.from([0x0a]),
    varintLen(pubBytes.length),
    pubBytes,
    Buffer.from([0x12]),
    varintLen(signature.length),
    signature,
  ]);
  // CrxFileHeader 字段 2 = sha256_with_rsa（tag 0x12）
  const headerFull = Buffer.concat([Buffer.from([0x12]), varintLen(signedDataFull.length), signedDataFull]);
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(headerFull.length, 0);
  return Buffer.concat([Buffer.from("Cr24", "latin1"), version, headerLen, headerFull, zipContent]);
}

async function makeExtensionFixture(opts: { badSig?: boolean } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const crx = buildCrx3For({ publicKey: pubDer, privateKey: privPem });
  if (opts.badSig) crx[crx.length - 1]! ^= 0xff;

  const derivedId = deriveExtensionId(pubDer);
  const storeEvidence: Record<string, unknown> = {
    extensionId: derivedId,
    version: EXTENSION_LOCK.version,
    publisher: EXTENSION_LOCK.publisher,
    storeUrl: EXTENSION_LOCK.storeUrl,
    fetchedAt: "2026-09-02T00:00:00.000Z",
    canonicalSha256: null,
    passed: true,
  };
  storeEvidence.canonicalSha256 = await canonicalJsonHash(storeEvidence);
  return { crx, derivedId, storeEvidence };
}

function crxFetch(crx: Buffer, redirectHost = "storage.googleapis.com") {
  return async (url: string) => {
    if (url.startsWith(EXTENSION_LOCK.updateUrl)) {
      return { status: 302, headers: new Headers({ location: `https://${redirectHost}/x.crx` }), body: new Uint8Array() };
    }
    if (url === `https://${redirectHost}/x.crx`) {
      return { status: 200, headers: new Headers({ "content-type": "application/x-chrome-extension" }), body: crx };
    }
    throw new Error(`unexpected url ${url}`);
  };
}

async function makeStoreEvidenceWithScreenshot(tmpDir: string, extensionId: string) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngPath = join(tmpDir, "extension-store-evidence.png");
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(pngPath, png);
  const sha = createHash("sha256").update(png).digest("hex");
  const evidence: Record<string, unknown> = {
    extensionId,
    version: EXTENSION_LOCK.version,
    publisher: EXTENSION_LOCK.publisher,
    storeUrl: EXTENSION_LOCK.storeUrl,
    fetchedAt: "2026-09-02T00:00:00.000Z",
    screenshot: { file: "extension-store-evidence.png", sha256: sha },
    reviewedBy: "human-reviewer",
    reviewedAt: "2026-09-02T00:00:00.000Z",
    canonicalSha256: null,
    passed: true,
  };
  evidence.canonicalSha256 = await canonicalJsonHash(evidence);
  return { evidence, pngPath };
}

/* =========================== Tests =========================== */

describe("redactToolOutput", () => {
  it("只保留验证相关行", () => {
    const out = redactToolOutput(
      "Verifies\nSigner #1 certificate SHA-256 digest:\n0A:9F:4A:6B:90:0B:DA:E4:D4:AD:7E:F3:E7:D7:73:90:1D:87:08:84:1A:DB:29:4C:49:4B:18:2A:1E:81:C3:D9\nWarning: /Users/gowinder/secret\n",
    );
    expect(out).toContain("Signer #1 certificate SHA-256 digest:");
    expect(out).toContain("0A:9F:4A:6B");
    expect(out).not.toContain("/Users/gowinder");
    expect(out).not.toContain("secret");
  });
});

// 测试用 constants：size/hash 与 FAKE_APK 匹配；其余字段锁定不变
function testApkConstants() {
  return {
    ...ANDROID_LOCK,
    size: FAKE_APK.length,
    packageSha256: createHash("sha256").update(FAKE_APK).digest("hex"),
  };
}

describe("verify-android-package", () => {
  it("固定 APK 成功向量（下载+asset API+工具）", async () => {
    const manifest: any = await verifyAndroidPackage({
      fetchImpl: androidFetchOk(),
      runTool: fakeAndroidTools(),
      constants: testApkConstants(),
    });
    expect(manifest.passed).toBe(true);
    expect(manifest.packageSha256).toBe(createHash("sha256").update(FAKE_APK).digest("hex"));
    expect(manifest.packageSize).toBe(FAKE_APK.length);
    expect(manifest.packageId).toBe(ANDROID_LOCK.packageId);
    expect(manifest.version).toBe("1.11.0");
    expect(manifest.build).toBe("45");
    expect(manifest.signingCertificateSha256).toBe(ANDROID_LOCK.signingCertificateSha256);
    expect(manifest.assetId).toBe(ANDROID_LOCK.assetId);
    expect(manifest.verificationProjection).toBeTruthy();
  });

  it("拒绝非锁定 URL", async () => {
    await expect(
      verifyAndroidPackage({
        fetchImpl: androidFetchOk(),
        runTool: fakeAndroidTools(),
        constants: { ...testApkConstants(), url: "https://evil.example.com/karakeep.apk" },
      }),
    ).rejects.toThrow(/ANDROID_URL_MISMATCH|HOST_NOT_ALLOWED/);
  });

  it("错误版本号失败（工具投影不一致但工具以 0 退出）", async () => {
    const manifest: any = await verifyAndroidPackage({
      fetchImpl: androidFetchOk(),
      runTool: fakeAndroidTools({ vname: "1.10.0" }),
      constants: testApkConstants(),
    });
    expect(manifest.passed).toBe(false);
  });

  it("签名证书不一致 → passed false", async () => {
    const manifest: any = await verifyAndroidPackage({
      fetchImpl: androidFetchOk(),
      runTool: fakeAndroidTools({ certFp: "AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC" }),
      constants: testApkConstants(),
    });
    expect(manifest.passed).toBe(false);
  });

  it("apksigner 非零退出失败", async () => {
    await expect(
      verifyAndroidPackage({
        fetchImpl: androidFetchOk(),
        runTool: fakeAndroidTools({ failApksigner: true }),
        constants: testApkConstants(),
      }),
    ).rejects.toThrow(/APKSIGNER_FAILED/);
  });

  it("错误 asset id 失败", async () => {
    const badApi = async (url: string) => {
      if (url === ANDROID_LOCK.url) return { status: 200, finalUrl: ANDROID_LOCK.url, body: FAKE_APK };
      if (url.includes("api.github.com")) {
        return { status: 200, finalUrl: url, body: new TextEncoder().encode(makeAssetsApi(FAKE_APK.length, 999999)) };
      }
      throw new Error(`unexpected ${url}`);
    };
    await expect(
      verifyAndroidPackage({
        fetchImpl: badApi,
        runTool: fakeAndroidTools(),
        constants: testApkConstants(),
      }),
    ).rejects.toThrow(/ASSET_ID_MISMATCH|ASSET_NOT_FOUND/);
  });

  it("package hash 与锁定不符 → passed false", async () => {
    const wrongBytes = Buffer.from("different-bytes-longer-than-test");
    const wrongFetch = async (url: string) => {
      if (url === ANDROID_LOCK.url) return { status: 200, finalUrl: ANDROID_LOCK.url, body: wrongBytes };
      if (url.includes("api.github.com")) {
        return { status: 200, finalUrl: url, body: new TextEncoder().encode(makeAssetsApi(wrongBytes.length)) };
      }
      throw new Error(`unexpected ${url}`);
    };
    // 锁定值与实际字节不符（size 匹配、hash 不符）
    const manifest: any = await verifyAndroidPackage({
      fetchImpl: wrongFetch,
      runTool: fakeAndroidTools(),
      constants: { ...testApkConstants(), size: wrongBytes.length },
    });
    expect(manifest.passed).toBe(false);
  });

  it("size 不符拒绝", async () => {
    await expect(
      verifyAndroidPackage({
        fetchImpl: androidFetchOk(),
        runTool: fakeAndroidTools(),
        constants: { ...testApkConstants(), size: 99999999 },
      }),
    ).rejects.toThrow(/SIZE_MISMATCH/);
  });
});

describe("verify-extension-package / CRX3", () => {
  it("固定 CRX3 成功向量", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    const manifest: any = await verifyExtensionPackage({
      fetchImpl: crxFetch(crx),
      constants,
      storeEvidence,
      version: "1.0.0",
    });
    expect(manifest.passed).toBe(true);
    expect(manifest.extensionId).toBe(derivedId);
    expect(manifest.packageSha256).toBe(createHash("sha256").update(crx).digest("hex"));
    expect(manifest.packageSize).toBe(crx.length);
    expect(manifest.version).toBe("1.2.11");
    expect(manifest.verificationProjection.crxFormat).toBe("CRX3");
    expect(manifest.verificationProjection.redirectHostAllowList).toEqual(EXTENSION_LOCK.redirectHostAllowList);
    expect(manifest.observations.signerPublicKeySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.verificationProjection).not.toHaveProperty("signerAllowList");
    expect(manifest.verificationProjection).not.toHaveProperty("trustedSignerPublicKeySha256");
  });

  it("wrong redirect host 失败", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx, "evil.example.com"), constants, storeEvidence }),
    ).rejects.toThrow(/REDIRECT_HOST_NOT_ALLOWED/);
  });

  it("bad signature（CRX3 proof 失败）", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture({ badSig: true });
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    await expect(verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence })).rejects.toThrow(/CRX3_PROOF_FAILED/);
  });

  it("derived ID 与锁定 extensionId 不一致失败", async () => {
    const { crx, storeEvidence } = await makeExtensionFixture();
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx), storeEvidence }),
    ).rejects.toThrow(/EXTENSION_ID_MISMATCH|STORE_EVIDENCE_MISMATCH/);
  });

  it("store evidence 版本不符失败", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence: { ...storeEvidence, version: "1.2.10" } }),
    ).rejects.toThrow(/STORE_EVIDENCE_MISMATCH/);
  });

  it("unsigned ZIP 失败", () => {
    const zip = Buffer.from("PK\u0003\u0004unsigned-zip-not-crx", "utf8");
    expect(() => verifyCrxProof(zip)).toThrow(/BAD_MAGIC|CRX3/);
  });

  it("store screenshot 缺失/替换 hash 失败", async () => {
    const tmpDir = join(tmpdir(), `kara-phase0-evidence-${Date.now()}`);
    const { crx, derivedId } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    const { evidence, pngPath } = await makeStoreEvidenceWithScreenshot(tmpDir, derivedId);
    writeFileSync(pngPath, Buffer.from("tampered"), "utf8");
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence: evidence, evidenceDir: tmpDir }),
    ).rejects.toThrow(/SCREENSHOT_HASH_MISMATCH/);
    const screenshotEntry = evidence.screenshot as { file: string; sha256: string };
    const missing = { ...evidence, screenshot: { file: "nope.png", sha256: screenshotEntry.sha256 } };
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence: missing, evidenceDir: tmpDir }),
    ).rejects.toThrow(/SCREENSHOT_MISSING/);
  });

  it("扩展 trust section 禁止字段（signerAllowList）失败", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    const bad = { ...storeEvidence, signerAllowList: ["x"], trust: { signerAllowList: ["x"] } };
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence: bad }),
    ).rejects.toThrow(/FORBIDDEN_TRUST_FIELD/);
  });

  it("候选 package hash 写入 trust 失败", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    const bad = { ...storeEvidence, trust: { candidatePackageHashes: ["aa"] } };
    await expect(
      verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence: bad }),
    ).rejects.toThrow(/FORBIDDEN_TRUST_FIELD/);
  });

  it("store evidence 缺 canonicalSha256 失败", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    const { canonicalSha256: _drop, ...noHash } = storeEvidence as any;
    await expect(verifyExtensionPackage({ fetchImpl: crxFetch(crx), constants, storeEvidence: noHash })).rejects.toThrow(
      /STORE_EVIDENCE_MISMATCH/,
    );
  });

  it("工具版本与请求模板记录在投影中", async () => {
    const { crx, derivedId, storeEvidence } = await makeExtensionFixture();
    const constants = { ...EXTENSION_LOCK, extensionId: derivedId };
    const manifest: any = await verifyExtensionPackage({
      fetchImpl: crxFetch(crx),
      constants,
      storeEvidence,
      version: "1.0.0",
    });
    expect(manifest.verificationProjection.verifierVersion).toBe("1.0.0");
    expect(manifest.verificationProjection.crxRequestTemplate).toContain("prodversion=");
    expect(manifest.verificationProjection.crxRequestTemplate).toContain(derivedId);
  });
});
