import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../base.js";
import { authenticateApiKey } from "../../auth/api-key.js";
import { verifyPassword } from "../../auth/password.js";
import { findUserByEmail, generateKeyId, generateKeySecret, insertApiKey } from "../../db/users.js";
import { sha256Hex } from "../../auth/api-key.js";

export const apiKeysRouter = router({
  validate: publicProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const user = await authenticateApiKey(ctx.env.DB, input.apiKey);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
      return { success: true };
    }),
  exchange: publicProcedure
    .input(
      z.object({
        keyName: z.string(),
        email: z.string(),
        password: z.string(),
        scopes: z.array(z.string()).optional(),
      }),
    )
    .output(
      z.object({
        id: z.string(),
        name: z.string(),
        key: z.string(),
        createdAt: z.date(),
        scopes: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const user = await findUserByEmail(ctx.env.DB, input.email);
      if (!user || !user.passwordHash || !user.passwordSalt) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const valid = await verifyPassword(input.password, user.passwordHash, user.passwordSalt);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const scopes = input.scopes ?? ["fullaccess"];
      const keyId = generateKeyId();
      const secret = generateKeySecret();
      const secretHash = await sha256Hex(secret);
      const id = crypto.randomUUID();
      await insertApiKey(ctx.env.DB, {
        id,
        userId: user.id,
        keyId,
        secretHash,
        name: input.keyName,
        scope: "fullaccess",
      });
      return { id, name: input.keyName, key: `ak2_${keyId}_${secret}`, createdAt: new Date(), scopes };
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
