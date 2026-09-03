import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../base.js";
import { hashPassword } from "../../auth/password.js";
import { insertUser } from "../../db/users.js";

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

const zSignUpSchema = z
  .object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    password: z.string().min(8).max(100),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export const usersRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    name: ctx.user.name,
    email: ctx.user.email,
    image: null,
    localUser: true,
  })),
  settings: protectedProcedure.query(() => defaultSettings),
  create: publicProcedure
    .input(zSignUpSchema)
    .output(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        role: z.enum(["user", "admin"]).nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await ctx.env.DB.prepare("SELECT id FROM users WHERE email = ?")
        .bind(input.email)
        .first();
      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "User with this email already exists" });
      }
      const { hash, salt } = await hashPassword(input.password);
      const id = crypto.randomUUID();
      await insertUser(ctx.env.DB, {
        id,
        name: input.name,
        email: input.email,
        passwordHash: hash,
        passwordSalt: salt,
      });
      return { id, name: input.name, email: input.email, role: "user" };
    }),
  deleteAccount: protectedProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_IMPLEMENTED_IN_PHASE0" });
  }),
  changePassword: protectedProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_IMPLEMENTED_IN_PHASE0" });
  }),
});
