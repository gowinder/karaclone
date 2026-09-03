import { z } from "zod";
import { protectedProcedure, router } from "../base.js";
import { TRPCError } from "@trpc/server";

// Phase 0 只读空能力：返回结构兼容的空结果，不假装有数据。
// 创建/修改 mutation 一律 BAD_REQUEST（规格分类），不能假装成功。

const badRequest = () => new TRPCError({ code: "BAD_REQUEST", message: "NOT_IMPLEMENTED_IN_PHASE0" });

export const listsRouter = router({
  list: protectedProcedure
    .output(z.object({ lists: z.array(z.unknown()) }))
    .query(() => ({ lists: [] })),
  getListsOfBookmark: protectedProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .output(z.object({ lists: z.array(z.unknown()) }))
    .query(() => ({ lists: [] })),
  stats: protectedProcedure
    .output(z.object({ stats: z.map(z.string(), z.number()) }))
    .query(() => ({ stats: new Map() })),
  create: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  edit: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  merge: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  delete: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  addToList: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  removeFromList: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  get: protectedProcedure.query(() => {
    throw badRequest();
  }),
  regenRssToken: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  clearRssToken: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  getRssToken: protectedProcedure.query(() => {
    throw badRequest();
  }),
  addCollaborator: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  removeCollaborator: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  updateCollaboratorRole: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  getCollaborators: protectedProcedure.query(() => {
    throw badRequest();
  }),
  acceptInvitation: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  declineInvitation: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  revokeInvitation: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
  getPendingInvitations: protectedProcedure.query(() => {
    throw badRequest();
  }),
  leaveList: protectedProcedure.mutation(() => {
    throw badRequest();
  }),
});
