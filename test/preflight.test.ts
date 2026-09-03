import { describe, expect, it } from "vitest";
import { BILLING_URL_RE, projectPage, projectSubscription, runPreflight } from "../scripts/phase0/write-preflight.mjs";

/** 构造单条 billing subscription item（ratePlan 用 snake_case 原始字段）。 */
export function makeSub(id: string, opts: { price?: number; state?: string; planId?: string; scope?: string | null; sets?: string[]; isContract?: boolean; externallyManaged?: boolean } = {}) {
  return {
    id,
    price: opts.price ?? 0,
    state: opts.state ?? "Cancelled",
    ratePlan: {
      id: opts.planId ?? "plan_xyz",
      scope: opts.scope ?? null,
      sets: opts.sets ?? [],
      is_contract: opts.isContract ?? false,
      externally_managed: opts.externallyManaged ?? false,
    },
  };
}

export function makePage(page: number, perPage: number, totalCount: number, items: unknown[]) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: items,
    result_info: { page, per_page: perPage, count: items.length, total_count: totalCount },
  };
}

/** 生成 count 个不重复订阅（id 从 base 递增）。 */
export function makeNubs(base: string, count: number, opts: Parameters<typeof makeSub>[1] = {}) {
  return Array.from({ length: count }, (_, i) => makeSub(`${base}-${i}`, opts));
}

describe("BILLING_URL_RE", () => {
  it("只接受 /client/v4/accounts/{id}/subscriptions", () => {
    expect(BILLING_URL_RE.test("https://api.cloudflare.com/client/v4/accounts/f7d3f423eb00601dddeb1cb9999127f0/subscriptions")).toBe(true);
    expect(BILLING_URL_RE.test("https://api.cloudflare.com/client/v4/accounts/f7d3f423eb00601dddeb1cb9999127f0/subscriptions?page=2&per_page=100")).toBe(false);
    expect(BILLING_URL_RE.test("https://evil.example.com/subscriptions")).toBe(false);
    expect(BILLING_URL_RE.test("https://api.cloudflare.com/client/v4/accounts/abc/other")).toBe(false);
  });
});

describe("projectSubscription", () => {
  it("投影只含公开字段，sets 排序", () => {
    const proj = projectSubscription(makeSub("id-1", { sets: ["b", "a"], scope: "z" }));
    expect(proj).toEqual({
      subscriptionIdSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      ratePlanId: "plan_xyz",
      state: "Cancelled",
      price: 0,
      scope: "z",
      sets: ["a", "b"],
      isContract: false,
      externallyManaged: false,
    });
  });

  it("scope null 保留 null；无 sets 得空数组", () => {
    const proj = projectSubscription(makeSub("id-2", { scope: null }));
    expect(proj.scope).toBeNull();
    expect(proj.sets).toEqual([]);
  });
});

describe("projectPage", () => {
  it("合法页投影含 pageProjection 骨架", () => {
    const page = projectPage(1, 100, 100, 2, [makeSub("a"), makeSub("b")]);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(100);
    expect(page.totalCount).toBe(100);
    expect(page.count).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toHaveProperty("subscriptionIdSha256");
  });

  it("result 非数组抛 PAGE_SHAPE_INVALID", () => {
    expect(() => projectPage(1, 100, 100, 0, null as unknown as unknown[])).toThrow("PAGE_SHAPE_INVALID");
  });

  it("result 长度 != result_info.count 抛 PAGE_COUNT_MISMATCH", () => {
    expect(() => projectPage(1, 100, 100, 2, [makeSub("a")])).toThrow("PAGE_COUNT_MISMATCH");
  });

  it("未知 state 抛 SUBSCRIPTION_STATE_UNKNOWN", () => {
    expect(() => projectPage(1, 100, 100, 1, [makeSub("a", { state: "Whatever" })])).toThrow("SUBSCRIPTION_STATE_UNKNOWN");
  });

  it("缺 id 抛 SUBSCRIPTION_ID_MISSING", () => {
    const bad = { price: 0, state: "Cancelled", ratePlan: { id: "p", scope: null, sets: [], is_contract: false, externally_managed: false } };
    expect(() => projectPage(1, 100, 100, 1, [bad])).toThrow("SUBSCRIPTION_ID_MISSING");
  });

  it("缺 is_contract 抛 RATE_PLAN_IS_CONTRACT_MISSING", () => {
    const bad = makeSub("a") as Record<string, unknown>;
    delete (bad.ratePlan as Record<string, unknown>).is_contract;
    expect(() => projectPage(1, 100, 100, 1, [bad])).toThrow("RATE_PLAN_IS_CONTRACT_MISSING");
  });

  it("is_contract 非布尔抛 RATE_PLAN_IS_CONTRACT_MISSING", () => {
    const bad = makeSub("a") as Record<string, unknown>;
    (bad.ratePlan as Record<string, unknown>).is_contract = "yes";
    expect(() => projectPage(1, 100, 100, 1, [bad])).toThrow("RATE_PLAN_IS_CONTRACT_MISSING");
  });

  it("sets 非字符串数组抛 RATE_PLAN_SETS_INVALID", () => {
    const bad = makeSub("a") as Record<string, unknown>;
    (bad.ratePlan as Record<string, unknown>).sets = ["ok", 7];
    expect(() => projectPage(1, 100, 100, 1, [bad])).toThrow("RATE_PLAN_SETS_INVALID");
  });
});

describe("runPreflight 分页与闸门", () => {
  const ACCOUNT = "acc-123";
  function fakeWhoami(id = ACCOUNT) {
    return () => id;
  }
  function makeBillingApi(pages: Record<number, ReturnType<typeof makePage>>, opts: { badStatus?: number } = {}) {
    return async (url: string) => {
      if (!url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/subscriptions`)) {
        throw new Error(`unexpected url ${url}`);
      }
      const u = new URL(url);
      if (opts.badStatus) return new Response("bad", { status: opts.badStatus });
      const page = Number(u.searchParams.get("page"));
      const body = pages[page];
      if (!body) throw new Error(`no page ${page}`);
      return new Response(JSON.stringify(body), { status: 200 });
    };
  }
  function twoPageClosed() {
    return {
      1: makePage(1, 100, 150, makeNubs("a", 100)),
      2: makePage(2, 100, 150, makeNubs("b", 50)),
    };
  }

  async function withToken<T>(fn: () => Promise<T>): Promise<T> {
    const old = process.env.CLOUDFLARE_BILLING_READ_TOKEN;
    process.env.CLOUDFLARE_BILLING_READ_TOKEN = "test-token";
    try {
      return await fn();
    } finally {
      if (old === undefined) delete process.env.CLOUDFLARE_BILLING_READ_TOKEN;
      else process.env.CLOUDFLARE_BILLING_READ_TOKEN = old;
    }
  }

  it("闭合分页全 Cancel 订阅 → passed true 且投影总数一致", async () => {
    await withToken(async () => {
      const art = await runPreflight({ whoami: fakeWhoami(), fetchImpl: makeBillingApi(twoPageClosed()) });
      expect(art.passed).toBe(true);
      expect(art.pageCount).toBe(2);
      expect(art.totalCount).toBe(150);
      expect(art.uniqueSubscriptionIdCount).toBe(150);
      expect(art.subscriptionRiskFree).toBe(true);
      expect(art.activeOrPendingSubscriptionCount).toBe(0);
      expect(art.whoamiAccountIdSha256).toBe(art.billingRequestAccountIdSha256);
    });
  });

  it("存在 Paid 订阅 → passed false 且 active>0", async () => {
    await withToken(async () => {
      const art = await runPreflight({
        whoami: fakeWhoami(),
        fetchImpl: makeBillingApi({ 1: makePage(1, 100, 100, makeNubs("paid", 100, { state: "Paid", price: 5 })) } as never),
      });
      expect(art.passed).toBe(false);
      expect(art.activeOrPendingSubscriptionCount).toBe(100);
    });
  });

  it("isContract=true → passed false", async () => {
    await withToken(async () => {
      const art = await runPreflight({
        whoami: fakeWhoami(),
        fetchImpl: makeBillingApi({ 1: makePage(1, 100, 100, makeNubs("c", 100, { isContract: true })) } as never),
      });
      expect(art.passed).toBe(false);
      expect(art.contractOrExternallyManagedCount).toBe(100);
    });
  });

  it("HTTP 非 200 → BILLING_API_FAILED", async () => {
    await withToken(async () => {
      await expect(
        runPreflight({ whoami: fakeWhoami(), fetchImpl: makeBillingApi({}, { badStatus: 403 }) }),
      ).rejects.toThrow("BILLING_API_FAILED");
    });
  });

  it("缺 result_info → BILLING_RESULT_INFO_MISSING", async () => {
    await withToken(async () => {
      const fetchImpl = async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      await expect(runPreflight({ whoami: fakeWhoami(), fetchImpl })).rejects.toThrow("BILLING_RESULT_INFO_MISSING");
    });
  });

  it("分页不闭合（页数耗尽仍未收齐）→ 报错", async () => {
    await withToken(async () => {
      const pages: Record<number, ReturnType<typeof makePage>> = {
        1: makePage(1, 100, 1000, makeNubs("a", 100)),
        2: makePage(2, 100, 1000, makeNubs("b", 100)),
      };
      const fetchImpl = async (url: string) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get("page"));
        const body = pages[page];
        if (!body) throw new Error(`no page ${page}`);
        return new Response(JSON.stringify(body), { status: 200 });
      };
      await expect(runPreflight({ whoami: fakeWhoami(), fetchImpl })).rejects.toThrow(/no page 3|SUBSCRIPTION_COUNT_MISMATCH/);
    });
  });

  it("无 token → CLOUDFLARE_BILLING_READ_TOKEN_MISSING", async () => {
    const old = process.env.CLOUDFLARE_BILLING_READ_TOKEN;
    delete process.env.CLOUDFLARE_BILLING_READ_TOKEN;
    try {
      await expect(runPreflight({ whoami: fakeWhoami(), fetchImpl: makeBillingApi(twoPageClosed()) })).rejects.toThrow(
        "CLOUDFLARE_BILLING_READ_TOKEN_MISSING",
      );
    } finally {
      if (old === undefined) delete process.env.CLOUDFLARE_BILLING_READ_TOKEN;
      else process.env.CLOUDFLARE_BILLING_READ_TOKEN = old;
    }
  });
});
