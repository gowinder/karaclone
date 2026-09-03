import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleDashboard } from "../src/http/dashboard";

describe("dashboard 面板", () => {
  it("GET /dashboard 返回 HTML 面板", async () => {
    const res = await handleDashboard(env as unknown as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("KaraClone");
    expect(html).toContain("login");
    expect(html).toContain("bookmarks");
  });

  it("面板包含登录与注册表单", async () => {
    const res = await handleDashboard(env as unknown as Env);
    const html = await res.text();
    expect(html).toContain('id="login-form"');
    expect(html).toContain('id="signup-form"');
    expect(html).toContain('id="login-email"');
    expect(html).toContain('id="login-password"');
  });

  it("面板包含书签列表与保存表单", async () => {
    const res = await handleDashboard(env as unknown as Env);
    const html = await res.text();
    expect(html).toContain('id="bookmark-list"');
    expect(html).toContain('id="save-url"');
    expect(html).toContain('id="save-title"');
  });
});
