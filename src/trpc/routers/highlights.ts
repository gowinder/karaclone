import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { TRPCError } from "@trpc/server";

const badRequest = () => new TRPCError({ code: "BAD_REQUEST", message: "NOT_IMPLEMENTED_IN_PHASE0" });

export const highlightsRouter = router({
  getForBookmark: protectedProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .output(z.object({ highlights: z.array(z.unknown()) }))
    .query(() => ({ highlights: [] })),
  getAll: protectedProcedure
    .input(z.object({ cursor: z.any().nullish(), limit: z.number().int().min(1).optional().default(20) }))
    .output(z.object({ highlights: z.array(z.unknown()), nextCursor: z.any().nullish() }))
    .query(() => ({ highlights: [], nextCursor: null })),
  create: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  get: protectedProcedure.query(() => {
    throw badRequest();
  }),
  search: protectedProcedure.query(() => {
    throw badRequest();
  }),
  delete: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  update: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
});
