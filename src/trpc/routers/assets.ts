import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { TRPCError } from "@trpc/server";

const badRequest = () => new TRPCError({ code: "BAD_REQUEST", message: "NOT_IMPLEMENTED_IN_PHASE0" });

export const assetsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20), cursor: z.number().nullish() }))
    .output(
      z.object({
        assets: z.array(z.unknown()),
        nextCursor: z.number().nullish(),
        totalCount: z.number(),
      }),
    )
    .query(() => ({ assets: [], nextCursor: null, totalCount: 0 })),
  attachAsset: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  replaceAsset: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  detachAsset: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
});
