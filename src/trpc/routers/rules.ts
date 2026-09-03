import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { TRPCError } from "@trpc/server";

const badRequest = () => new TRPCError({ code: "BAD_REQUEST", message: "NOT_IMPLEMENTED_IN_PHASE0" });

export const rulesRouter = router({
  list: protectedProcedure
    .output(z.object({ rules: z.array(z.unknown()) }))
    .query(() => ({ rules: [] })),
  create: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  update: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  delete: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
});
