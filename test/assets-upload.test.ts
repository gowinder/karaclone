import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/trpc/context";
import { appRouter } from "../src/trpc/router";
import { handleAssetUpload, handleAssetGet } from "../src/http/assets";

async function caller(bearer?: string) {
  const req = new Request("https://example.com/trpc/x", {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  const ctx = await createContext({ env: env as unknown as Env, req, executionCtx: {} as ExecutionContext });
  return appRouter.createCaller(ctx);
}

async function signupAndKey(email: string) {
  const c = await caller();
  await c.users.create({ name: "Asset User", email, password: "password123", confirmPassword: "password123" });
  const { key } = await c.apiKeys.exchange({ keyName: "K", email, password: "password123" });
  return key;
}

describe("POST /api/assets 上传", () => {
  it("上传 text/html 返回 assetId，可下载回原文", async () => {
    const key = await signupAndKey("asset-upload@test.com");
    const html = "<html><body>singlefile archive</body></html>";
    const form = new FormData();
    form.append("file", new File([html], "page.html", { type: "text/html" }));

    const req = new Request("https://example.com/api/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const res = await handleAssetUpload(req, env as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assetId: string; contentType: string; size: number; fileName: string };
    expect(body.assetId).toBeTruthy();
    expect(body.contentType).toBe("text/html");
    expect(body.size).toBe(html.length);
    expect(body.fileName).toBe("page.html");

    // 下载回原文
    const getReq = new Request(`https://example.com/api/assets/${body.assetId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const getRes = await handleAssetGet(getReq, env as unknown as Env, body.assetId);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(html);
  });

  it("无认证 → 401", async () => {
    const form = new FormData();
    form.append("file", new File(["x"], "x.html", { type: "text/html" }));
    const req = new Request("https://example.com/api/assets", { method: "POST", body: form });
    const res = await handleAssetUpload(req, env as unknown as Env);
    expect(res.status).toBe(401);
  });

  it("不支持的类型 → 400", async () => {
    const key = await signupAndKey("asset-badtype@test.com");
    const form = new FormData();
    form.append("file", new File(["x"], "x.exe", { type: "application/x-msdownload" }));
    const req = new Request("https://example.com/api/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const res = await handleAssetUpload(req, env as unknown as Env);
    expect(res.status).toBe(400);
  });

  it("缺 file 字段 → 400", async () => {
    const key = await signupAndKey("asset-nofile@test.com");
    const form = new FormData();
    form.append("other", "x");
    const req = new Request("https://example.com/api/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const res = await handleAssetUpload(req, env as unknown as Env);
    expect(res.status).toBe(400);
  });

  it("他人资产下载 → 404", async () => {
    const keyA = await signupAndKey("asset-owner@test.com");
    const form = new FormData();
    form.append("file", new File(["secret"], "s.html", { type: "text/html" }));
    const upReq = new Request("https://example.com/api/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${keyA}` },
      body: form,
    });
    const up = (await (await handleAssetUpload(upReq, env as unknown as Env)).json()) as { assetId: string };

    const keyB = await signupAndKey("asset-thief@test.com");
    const getReq = new Request(`https://example.com/api/assets/${up.assetId}`, {
      headers: { Authorization: `Bearer ${keyB}` },
    });
    const res = await handleAssetGet(getReq, env as unknown as Env, up.assetId);
    expect(res.status).toBe(404);
  });

  it("元数据落 D1：asset_type=user-uploaded", async () => {
    const key = await signupAndKey("asset-meta@test.com");
    const form = new FormData();
    form.append("file", new File(["<p>hi</p>"], "m.html", { type: "text/html" }));
    const upReq = new Request("https://example.com/api/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const up = (await (await handleAssetUpload(upReq, env as unknown as Env)).json()) as { assetId: string };
    const row = await env.DB.prepare("SELECT asset_type, content_type, file_name, size FROM assets WHERE id = ?")
      .bind(up.assetId)
      .first<{ asset_type: string; content_type: string; file_name: string; size: number }>();
    expect(row?.asset_type).toBe("user-uploaded");
    expect(row?.content_type).toBe("text/html");
    expect(row?.file_name).toBe("m.html");
    expect(row?.size).toBe(9);
  });
});
