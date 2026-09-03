// 非 secret Wrangler var：扩展 Origin 白名单（来自 client-lock 的 Store ID 确定性推导）。
// 通过 global interface merge 扩展生成的 Env，不得手改 worker-configuration.d.ts。
declare global {
  interface Env {
    ALLOWED_EXTENSION_ORIGIN: string;
  }
}

export {};
