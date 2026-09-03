import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../base.js";

const defaultSettings = {
  bookmarkClickAction: "open_original_link",
  archiveDisplayBehaviour: "show",
  timezone: "Asia/Shanghai",
  backupsEnabled: false,
  backupsFrequency: "weekly",
  backupsRetentionDays: 7,
  readerFontSize: null,
  readerLineHeight: null,
  readerFontFamily: null,
  autoTaggingEnabled: true,
  autoSummarizationEnabled: false,
  tagStyle: "lowercase-spaces",
  curatedTagIds: null,
  inferredTagLang: "zh-CN",
} as const;

export const usersRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    name: ctx.user.name,
    email: ctx.user.email,
    image: null,
    localUser: true,
  })),
  settings: protectedProcedure.query(() => defaultSettings),
  // Phase 0 不实现账户管理：规格要求 FORBIDDEN，不能假装成功。
  create: protectedProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_IMPLEMENTED_IN_PHASE0" });
  }),
  deleteAccount: protectedProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_IMPLEMENTED_IN_PHASE0" });
  }),
  changePassword: protectedProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_IMPLEMENTED_IN_PHASE0" });
  }),
});
