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

  it("面板包含重试失败标签入口与失败计数徽标", async () => {
    const res = await handleDashboard(env as unknown as Env);
    const html = await res.text();
    expect(html).toContain('data-mtn="retry-tagging"');
    expect(html).toContain('id="mtn-retry-count"');
    expect(html).toContain("imports.retryFailedTagging");
    expect(html).toContain("imports.failedTaggingCount");
  });

  it("面板包含导出 URL 的入口，且覆盖全部筛选视图", async () => {
    const res = await handleDashboard(env as unknown as Env);
    const html = await res.text();
    expect(html).toContain('id="export-urls"');
    expect(html).toContain("tags.exportBookmarks");
    // 默认隐藏：列表未筛选时不该出现导出按钮
    expect(html).toContain('id="export-urls" title');
    // 三种筛选视图都要能导出，归档视图也要把 archived 传给端点
    expect(html).toContain('payload.favourited = true');
    expect(html).toContain('payload.archived = true');
  });

  it("页脚版本号来自 SERVER_VERSION，不是写死的", async () => {
    const res = await handleDashboard(env as unknown as Env);
    const html = await res.text();
    expect(html).not.toContain("__SERVER_VERSION__");
    expect(html).toContain(`v${(env as unknown as Env).SERVER_VERSION}`);
  });
});
