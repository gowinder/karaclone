// 测试专用 binding：由 vitest.config.ts 的 miniflare bindings 注入，
// 不在 wrangler.jsonc 中（避免污染远端部署配置）。
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}
export {};
