import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../base.js";
import { authenticateApiKey } from "../../auth/api-key.js";

export const configRouter = router({
  clientConfig: publicProcedure.query(({ ctx }) => {
    const origin = new URL(ctx.req.url).origin;
    return {
      publicUrl: origin,
      publicApiUrl: origin,
      auth: {
        disableSignups: true,
        disablePasswordAuth: true,
        oauthAutoRedirect: false,
      },
      turnstile: null,
      inference: {
        isConfigured: true,
        inferredTagLang: "zh-CN",
        enableAutoTagging: true,
        enableAutoSummarization: false,
      },
      chat: { enabled: false },
      search: { semanticSearchEnabled: false },
      stripe: { isConfigured: false },
      legal: {},
      serverVersion: ctx.env.SERVER_VERSION,
      disableNewReleaseCheck: true,
    };
  }),
});
