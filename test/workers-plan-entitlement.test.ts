import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCanonicalUrl,
  EXTRACTION_RULES_VERSION,
  extractAccountIdFromDom,
  extractWorkersFreeEvidence,
  HTML_NAME,
  JSON_NAME,
  PNG_NAME,
  runCollector,
  SCHEMA_VERSION,
  scanDomForSecrets,
  SECRET_PATTERNS,
  SELECTOR_VERSION,
  verifyAccountTrio,
  verifyCanonicalUrl,
  verifySession,
} from "../scripts/phase0/capture-workers-plan-entitlement.mjs";

const ACCOUNT = "f7d3f423eb00601dddeb1cb9999127f0";
const ACCOUNT_SHA = createHash("sha256").update(ACCOUNT).digest("hex");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "entitlement-test-"));

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
});

function readFileSyncStr(path: string) {
  return readFileSync(path, "utf8");
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("buildCanonicalUrl", () => {
  it("官方 workers plans URL", () => {
    expect(buildCanonicalUrl(ACCOUNT)).toBe(`https://dash.cloudflare.com/${ACCOUNT}/workers/plans`);
  });
});

describe("verifyCanonicalUrl", () => {
  it("正确 host/path/account 通过", () => {
    expect(verifyCanonicalUrl(`https://dash.cloudflare.com/${ACCOUNT}/workers/plans`, ACCOUNT_SHA)).toBe(
      `https://dash.cloudflare.com/${ACCOUNT}/workers/plans`,
    );
  });

  it("wrong host → HOST_NOT_ALLOWED", () => {
    expect(() => verifyCanonicalUrl(`https://evil.example.com/${ACCOUNT}/workers/plans`, ACCOUNT_SHA)).toThrow("HOST_NOT_ALLOWED");
    expect(() => verifyCanonicalUrl(`http://dash.cloudflare.com/${ACCOUNT}/workers/plans`, ACCOUNT_SHA)).toThrow("HOST_NOT_ALLOWED");
  });

  it("wrong path → PATH_INVALID", () => {
    expect(() => verifyCanonicalUrl(`https://dash.cloudflare.com/${ACCOUNT}/settings`, ACCOUNT_SHA)).toThrow("PATH_INVALID");
    expect(() => verifyCanonicalUrl(`https://dash.cloudflare.com/${ACCOUNT}/workers`, ACCOUNT_SHA)).toThrow("PATH_INVALID");
  });

  it("wrong account（hash 不等）→ ACCOUNT_MISMATCH", () => {
    const other = "11111111111111111111111111111111";
    expect(() => verifyCanonicalUrl(`https://dash.cloudflare.com/${other}/workers/plans`, ACCOUNT_SHA)).toThrow("ACCOUNT_MISMATCH");
  });
});

describe("extractWorkersFreeEvidence", () => {
  it("单行 Workers Free 通过", () => {
    expect(extractWorkersFreeEvidence("Your plan: Workers Free")).toBe("Your plan: Workers Free");
    expect(extractWorkersFreeEvidence("Workers Free")).toBe("Workers Free");
  });

  it("缺失 → SELECTOR_MISSING", () => {
    expect(() => extractWorkersFreeEvidence("Your plan: Paid")).toThrow("SELECTOR_MISSING");
    expect(() => extractWorkersFreeEvidence("")).toThrow("SELECTOR_MISSING");
    expect(() => extractWorkersFreeEvidence(null as never)).toThrow("SELECTOR_MISSING");
  });

  it("多行不同 → SELECTOR_AMBIGUOUS", () => {
    expect(() => extractWorkersFreeEvidence("Workers Free\nWorkers Free - Enterprise")).toThrow("SELECTOR_AMBIGUOUS");
  });

  it("同一规范化行多行出现视为唯一", () => {
    expect(extractWorkersFreeEvidence("Workers Free\nWorkers Free\nother")).toBe("Workers Free");
  });
});

describe("extractAccountIdFromDom", () => {
  it("URL 与 DOM 都含 account → 通过", () => {
    expect(extractAccountIdFromDom(`/${ACCOUNT}/workers/plans`, `hello ${ACCOUNT} world`)).toBe(ACCOUNT);
  });

  it("URL 无 account → ACCOUNT_ID_NOT_IN_URL", () => {
    expect(() => extractAccountIdFromDom("/workers/plans", ACCOUNT)).toThrow("ACCOUNT_ID_NOT_IN_URL");
  });

  it("DOM 无 account → ACCOUNT_ID_NOT_IN_DOM", () => {
    expect(() => extractAccountIdFromDom(`/${ACCOUNT}/workers/plans`, "no account here")).toThrow("ACCOUNT_ID_NOT_IN_DOM");
  });
});

describe("scanDomForSecrets / SECRET_PATTERNS", () => {
  it("secret 形态 → DOM_SECRET_FOUND", () => {
    expect(() => scanDomForSecrets("token: abc123")).toThrow("DOM_SECRET_FOUND");
    expect(() => scanDomForSecrets("api_key=secretvalue")).toThrow("DOM_SECRET_FOUND");
  });

  it("无 secret 通过", () => {
    expect(scanDomForSecrets(`Workers Free ${ACCOUNT}`)).toBe(true);
  });

  it("SECRET_PATTERNS 非空", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("verifySession", () => {
  const base = {
    chromePid: 4242,
    launchArgs: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", `--user-data-dir=/tmp/kc-abc123`, `--remote-debugging-port=22222`],
    endpointUrl: "ws://127.0.0.1:22222/devtools/browser/x",
    expectedUserDataDir: "/tmp/kc-abc123",
    expectedNonce: "abc123",
    actualProfilePath: "/tmp/kc-abc123/Default",
    port: 22222,
  };

  it("全部匹配 → 无错误", () => {
    expect(verifySession(base)).toEqual([]);
  });

  it("wrong PID → PID_INVALID", () => {
    expect(verifySession({ ...base, chromePid: -1 })).toContain("PID_INVALID");
    expect(verifySession({ ...base, chromePid: 0 })).toContain("PID_INVALID");
  });

  it("缺 user-data-dir/port 启动参数 → ARGS_*", () => {
    expect(verifySession({ ...base, launchArgs: ["chrome"] })).toEqual(expect.arrayContaining(["ARGS_MISSING_USER_DATA_DIR", "ARGS_PORT_NOT_FOUND"]));
  });

  it("nonce 不在 user-data-dir → NONCE_NOT_IN_USER_DATA_DIR", () => {
    expect(verifySession({ ...base, expectedNonce: "different" })).toContain("NONCE_NOT_IN_USER_DATA_DIR");
  });

  it("non-current endpoint → ENDPOINT_NOT_CURRENT", () => {
    expect(verifySession({ ...base, endpointUrl: "ws://127.0.0.1:99999/devtools/browser/old" })).toContain("ENDPOINT_NOT_CURRENT");
  });

  it("Profile Path 非本次目录 → PROFILE_NOT_IN_SESSION", () => {
    expect(verifySession({ ...base, actualProfilePath: "/Users/me/Library/Application Support/Google/Chrome/Default" })).toContain(
      "PROFILE_NOT_IN_SESSION",
    );
  });
});

describe("verifyAccountTrio", () => {
  it("Dashboard==API、deploy null → 通过", () => {
    expect(verifyAccountTrio({ dashboardAccountIdSha256: ACCOUNT_SHA, apiAccountIdSha256: ACCOUNT_SHA, deployAccountIdSha256: null })).toBe(
      true,
    );
  });

  it("Dashboard==API==deploy → 通过", () => {
    expect(
      verifyAccountTrio({ dashboardAccountIdSha256: ACCOUNT_SHA, apiAccountIdSha256: ACCOUNT_SHA, deployAccountIdSha256: ACCOUNT_SHA }),
    ).toBe(true);
  });

  it("Dashboard≠API → DASHBOARD_API_ACCOUNT_MISMATCH", () => {
    expect(() =>
      verifyAccountTrio({ dashboardAccountIdSha256: "a".repeat(64), apiAccountIdSha256: ACCOUNT_SHA, deployAccountIdSha256: null }),
    ).toThrow("DASHBOARD_API_ACCOUNT_MISMATCH");
  });

  it("deploy≠API → DEPLOY_ACCOUNT_MISMATCH", () => {
    expect(() =>
      verifyAccountTrio({ dashboardAccountIdSha256: ACCOUNT_SHA, apiAccountIdSha256: ACCOUNT_SHA, deployAccountIdSha256: "b".repeat(64) }),
    ).toThrow("DEPLOY_ACCOUNT_MISMATCH");
  });
});

/** 构造 fake deps：成功路径 + 可注入故障。 */
function makeFakeDeps(overrides = {}) {
  const state = { userDataDir: null as string | null, port: 0 };
  const outputs: string[] = [];
  const defaults = {
    makeTempDir: (prefix: string) => {
      state.userDataDir = join(TMP_ROOT, prefix);
      mkdirSync(state.userDataDir, { recursive: true });
      return state.userDataDir;
    },
    spawnChrome: ({ port }: { userDataDir: string; port: number }) => {
      state.port = port;
      return 4242;
    },
    getJson: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${state.port}/devtools/browser/abc` }),
    getProcessArgs: () => [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `--user-data-dir=${state.userDataDir}`,
      `--remote-debugging-port=${state.port}`,
      "--no-first-run",
      "about:blank",
    ],
    promptUser: async () => {},
    killChrome: () => {},
    cleanupTemp: (dir: string) => {
      rmSync(dir, { recursive: true, force: true });
    },
    writeFile: (path: string, content: string | Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      outputs.push(path);
    },
    cdpEvaluate: async () => ({
      url: `https://dash.cloudflare.com/${ACCOUNT}/workers/plans`,
      dom: `<div>account ${ACCOUNT}</div><div>Workers Free</div>`,
      text: `Workers Free\n${ACCOUNT}`,
      accountPath: `/${ACCOUNT}/workers/plans`,
    }),
    cdpScreenshot: async () => PNG_1PX,
  };
  return { state, outputs, deps: { ...defaults, ...overrides } };
}

async function withAccountSource<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(TMP_ROOT, "src-"));
  const path = join(dir, "preflight.json");
  writeFileSync(path, JSON.stringify({ whoamiAccountIdSha256: ACCOUNT_SHA }));
  try {
    return await fn(path);
  } catch (err) {
    return Promise.reject(err);
  }
}

describe("runCollector 成功与失败路径", () => {
  it("成功：三件套生成、canonical 校验、字段齐备", async () => {
    await withAccountSource(async (srcPath) => {
      const { state, outputs, deps } = makeFakeDeps();
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      const art = await runCollector({ deps, accountIdSourcePath: srcPath, outDir, reviewedBy: "test" });
      expect(art.passed).toBe(true);
      expect(art.schemaVersion).toBe(SCHEMA_VERSION);
      expect(art.extractionRulesVersion).toBe(EXTRACTION_RULES_VERSION);
      expect(art.selectorVersion).toBe(SELECTOR_VERSION);
      expect(art.canonicalDashboardUrl).toBe(`https://dash.cloudflare.com/${ACCOUNT}/workers/plans`);
      expect(art.normalizedSelectorText).toBe("Workers Free");
      expect(art.accountIdSha256).toBe(ACCOUNT_SHA);
      expect(art.urlSha256).toBe(createHash("sha256").update(art.canonicalDashboardUrl).digest("hex"));
      expect(art.session.sessionValidated).toBe(true);
      expect(art.session.chromePid).toBe(4242);
      expect(art.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
      // 三件套原子写出
      for (const name of [JSON_NAME, HTML_NAME, PNG_NAME]) {
        expect(outputs).toContain(join(outDir, name));
        expect(existsSync(join(outDir, name))).toBe(true);
      }
      // HTML 是脱敏 DOM
      const html = readFileSyncStr(join(outDir, HTML_NAME));
      expect(html).toContain("Workers Free");
      expect(html).not.toMatch(/token/i);
    });
  });

  it("stale/prebuilt JSON → 非零退出且不生成", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps();
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      writeFileSync(join(outDir, JSON_NAME), "{}");
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("STALE_OUTPUT_PRESENT");
      expect(outputs).toHaveLength(0);
    });
  });

  it("selector 缺失 → SELECTOR_MISSING，无产出", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({ cdpEvaluate: async () => ({ url: `https://dash.cloudflare.com/${ACCOUNT}/workers/plans`, dom: `<div>${ACCOUNT}</div>`, text: "Paid", accountPath: `/${ACCOUNT}/workers/plans` }) });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("SELECTOR_MISSING");
      expect(outputs).toHaveLength(0);
    });
  });

  it("含糊 Free 文本 → SELECTOR_AMBIGUOUS", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({
        cdpEvaluate: async () => ({ url: `https://dash.cloudflare.com/${ACCOUNT}/workers/plans`, dom: `<div>${ACCOUNT}</div>`, text: "Workers Free\nWorkers Free - Enterprise", accountPath: `/${ACCOUNT}/workers/plans` }),
      });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("SELECTOR_AMBIGUOUS");
      expect(outputs).toHaveLength(0);
    });
  });

  it("DOM 含 secret → DOM_SECRET_FOUND", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({
        cdpEvaluate: async () => ({ url: `https://dash.cloudflare.com/${ACCOUNT}/workers/plans`, dom: `token: supersekrit ${ACCOUNT}`, text: "Workers Free", accountPath: `/${ACCOUNT}/workers/plans` }),
      });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("DOM_SECRET_FOUND");
      expect(outputs).toHaveLength(0);
    });
  });

  it("截图失败（空）→ CAPTURE_SCREENSHOT_EMPTY", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({ cdpScreenshot: async () => Buffer.alloc(0) });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("CAPTURE_SCREENSHOT_EMPTY");
      expect(outputs).toHaveLength(0);
    });
  });

  it("wrong PID → SESSION_VERIFY_FAILED", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({ spawnChrome: () => -5 });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("SESSION_VERIFY_FAILED");
      expect(outputs).toHaveLength(0);
    });
  });

  it("启动参数不含本次 profile → SESSION_VERIFY_FAILED", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({ getProcessArgs: () => ["/Apps/Chrome", "--flag=nope"] });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("SESSION_VERIFY_FAILED");
      expect(outputs).toHaveLength(0);
    });
  });

  it("non-current CDP endpoint → SESSION_VERIFY_FAILED", async () => {
    await withAccountSource(async (srcPath) => {
      const { deps, outputs } = makeFakeDeps({ getJson: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:11111/devtools/browser/old" }) });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("SESSION_VERIFY_FAILED");
      expect(outputs).toHaveLength(0);
    });
  });

  it("同账户但非本次 profile（session nonce 不等）→ SESSION_VERIFY_FAILED", async () => {
    await withAccountSource(async (srcPath) => {
      // makeTempDir 返回带 nonce 的目录；伪造 getProcessArgs 用别的目录
      const { deps, outputs } = makeFakeDeps({
        makeTempDir: () => `/tmp/kc-${randomBytes(8).toString("hex")}`,
        cleanupTemp: () => {},
      });
      const outDir = mkdtempSync(join(TMP_ROOT, "out-"));
      await expect(runCollector({ deps, accountIdSourcePath: srcPath, outDir })).rejects.toThrow("SESSION_VERIFY_FAILED");
      expect(outputs).toHaveLength(0);
    });
  });
});
