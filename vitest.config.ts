import { defineConfig } from "vitest/config";

// Phase 0 A/B 段：证据脚本与 fail-closed 测试所需的最小配置。
// 业务依赖（@cloudflare/vitest-plugin、tRPC 等）通过后才替换为完整配置。
export default defineConfig({
  test: {
    maxWorkers: 1,
    noIsolate: true,
  },
});
