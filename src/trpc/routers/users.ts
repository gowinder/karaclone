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
});
