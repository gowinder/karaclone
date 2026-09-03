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
        },
      },
    ],
  },
});
