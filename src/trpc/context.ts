import { authenticateApiKey } from "../auth/api-key.js";

export type Context = {
  env: Env;
  req: Request;
  executionCtx: ExecutionContext;
  user: { id: string; name: string | null; email: string | null } | null;
};

export async function createContext(opts: {
  env: Env;
  req: Request;
  executionCtx: ExecutionContext;
}): Promise<Context> {
  const auth = opts.req.headers.get("Authorization");
  let user: Context["user"] = null;
  if (auth?.startsWith("Bearer ")) {
    const apiKey = auth.slice("Bearer ".length).trim();
    if (apiKey) {
      user = await authenticateApiKey(opts.env.DB, apiKey);
    }
  }
  return { env: opts.env, req: opts.req, executionCtx: opts.executionCtx, user };
}
