import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../base.js";
import { authenticateApiKey } from "../../auth/api-key.js";

export const apiKeysRouter = router({
  validate: publicProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const user = await authenticateApiKey(ctx.env.DB, input.apiKey);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
      return { success: true };
    }),
  exchange: publicProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "Password authentication is disabled" });
  }),
  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.env.DB.prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
        .bind(Date.now(), input.id, ctx.user.id)
        .run();
    }),
});
