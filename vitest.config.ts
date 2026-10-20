import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// B 段证据脚本测试需要真实文件系统/外部二进制（apksigner、unzip），
// 必须在纯 node 环境运行；业务测试（T2 起）需要 D1/Queue/AI bindings，
// 在 cloudflareTest（workerd）环境运行。用 projects 拆分。
const nodeTests = [
  "test/canonical-json.test.ts",
  "test/package-verifiers.test.ts",
  "test/preflight.test.ts",
  "test/workers-plan-entitlement.test.ts",
  "test/phase0-scripts.test.ts",
  "test/decision.test.ts",
  "test/replay-final-store.test.ts",
  "test/extension-store-content-binding.test.ts",
];

export default defineConfig({
  test: {
    maxWorkers: 1,
    noIsolate: true,
    projects: [
      {
        test: {
          name: "node",
          include: nodeTests,
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            // 测试全部跑在 miniflare 本地（D1/Queue/AI 均为本地模拟）。
            // 关闭 remoteBindings 以免插件要求 Cloudflare 认证启动远程代理会话；
            // 需要真实远程绑定的场景一律用 wrangler/curl 单独验证。
            remoteBindings: false,
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
              },
            },
          })),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: nodeTests,
          setupFiles: ["./test/apply-migrations.ts"],
          // createBookmark 会真实抓取页面 meta（page-meta.ts 自带 5s AbortSignal 超时）。
          // 出网不可用/缓慢时每次抓取要耗掉 2~3s，建 2~3 条书签的用例就会顶破 vitest
          // 默认的 5000ms（正好等于该抓取自身的超时，属于潜在的必然 flake）。
          testTimeout: 30000,
        },
      },
    ],
  },
});
