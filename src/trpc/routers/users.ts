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

const zBookmarkSourceSchema = z.enum([
  "api",
  "web",
  "cli",
  "mobile",
  "extension",
  "singlefile",
  "rss",
  "import",
]);

// 与上游 packages/shared/types/users.ts 的 zUserStatsResponseSchema 对齐。
// KaraClone 不含 highlights/lists，对应计数恒为 0。
const zUserStatsResponseSchema = z.object({
  numBookmarks: z.number(),
  numFavorites: z.number(),
  numArchived: z.number(),
  numTags: z.number(),
  numLists: z.number(),
  numHighlights: z.number(),
  bookmarksByType: z.object({
    link: z.number(),
    text: z.number(),
    asset: z.number(),
  }),
  topDomains: z.array(z.object({ domain: z.string(), count: z.number() })).max(10),
  totalAssetSize: z.number(),
  assetsByType: z.array(
    z.object({ type: z.string(), count: z.number(), totalSize: z.number() }),
  ),
  bookmarkingActivity: z.object({
    thisWeek: z.number(),
    thisMonth: z.number(),
    thisYear: z.number(),
    byHour: z.array(z.object({ hour: z.number(), count: z.number() })),
    byDayOfWeek: z.array(z.object({ day: z.number(), count: z.number() })),
  }),
  tagUsage: z.array(z.object({ name: z.string(), count: z.number() })).max(10),
  bookmarksBySource: z.array(
    z.object({ source: zBookmarkSourceSchema.nullable(), count: z.number() }),
  ),
});

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
  stats: protectedProcedure.output(zUserStatsResponseSchema).query(async ({ ctx }) => {
    const userId = ctx.user.id;
    // KaraClone 仅支持 link 类型书签，且无 highlights/lists 表；
    // 保持与上游一致的结构，对应字段填 0（客户端展示 0 而非报错）。
    const counts = await ctx.env.DB.prepare(
      `SELECT
        COUNT(*) AS numBookmarks,
        SUM(CASE WHEN favourited = 1 THEN 1 ELSE 0 END) AS numFavorites,
        SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS numArchived,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS thisWeek,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS thisMonth,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS thisYear
      FROM bookmarks WHERE user_id = ?`,
    )
      .bind(
        Date.now() - 7 * 864e5,
        Date.now() - 30 * 864e5,
        Date.now() - 365 * 864e5,
        userId,
      )
      .first<Record<string, number | null>>();

    const numTags = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM tags WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();

    const topDomains = await ctx.env.DB.prepare(
      `SELECT
        CASE
          WHEN canonical_url LIKE 'https://%' THEN
            CASE WHEN INSTR(SUBSTR(canonical_url, 9), '/') > 0
              THEN SUBSTR(canonical_url, 9, INSTR(SUBSTR(canonical_url, 9), '/') - 1)
              ELSE SUBSTR(canonical_url, 9) END
          WHEN canonical_url LIKE 'http://%' THEN
            CASE WHEN INSTR(SUBSTR(canonical_url, 8), '/') > 0
              THEN SUBSTR(canonical_url, 8, INSTR(SUBSTR(canonical_url, 8), '/') - 1)
              ELSE SUBSTR(canonical_url, 8) END
          ELSE canonical_url
        END AS domain,
        COUNT(*) AS count
      FROM bookmarks WHERE user_id = ?
      GROUP BY domain ORDER BY count DESC LIMIT 10`,
    )
      .bind(userId)
      .all<{ domain: string; count: number }>();

    const assetSizes = await ctx.env.DB.prepare(
      `SELECT asset_type AS type, COUNT(*) AS count, COALESCE(SUM(size), 0) AS totalSize
       FROM assets WHERE user_id = ? GROUP BY asset_type`,
    )
      .bind(userId)
      .all<{ type: string; count: number; totalSize: number }>();

    const totalAssetSize = await ctx.env.DB.prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM assets WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ total: number }>();

    const tagUsage = await ctx.env.DB.prepare(
      `SELECT t.name AS name, COUNT(bt.bookmark_id) AS count
       FROM tags t LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id
       WHERE t.user_id = ? GROUP BY t.name ORDER BY count DESC LIMIT 10`,
    )
      .bind(userId)
      .all<{ name: string; count: number }>();

    const bySource = await ctx.env.DB.prepare(
      `SELECT source, COUNT(*) AS count FROM bookmarks WHERE user_id = ?
       GROUP BY source ORDER BY count DESC`,
    )
      .bind(userId)
      .all<{ source: string | null; count: number }>();

    // 按用户时区统计创建时间的分布（与上游一致：toLocaleString 转换）
    const timestamps = await ctx.env.DB.prepare(
      "SELECT created_at FROM bookmarks WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ created_at: number }>();

    const hourCounts = Array.from({ length: 24 }, () => 0);
    const dayCounts = Array.from({ length: 7 }, () => 0);
    const tz = defaultSettings.timezone;
    for (const { created_at } of timestamps.results) {
      const userDate = new Date(new Date(created_at).toLocaleString("en-US", { timeZone: tz }));
      const h = userDate.getHours();
      const d = userDate.getDay();
      hourCounts[h] = (hourCounts[h] ?? 0) + 1;
      dayCounts[d] = (dayCounts[d] ?? 0) + 1;
    }

    return {
      numBookmarks: counts?.numBookmarks ?? 0,
      numFavorites: counts?.numFavorites ?? 0,
      numArchived: counts?.numArchived ?? 0,
      numTags: numTags?.n ?? 0,
      numLists: 0,
      numHighlights: 0,
      bookmarksByType: { link: counts?.numBookmarks ?? 0, text: 0, asset: 0 },
      topDomains: topDomains.results.filter((d) => d.domain && d.domain.length > 0),
      totalAssetSize: totalAssetSize?.total ?? 0,
      assetsByType: assetSizes.results,
      bookmarkingActivity: {
        thisWeek: counts?.thisWeek ?? 0,
        thisMonth: counts?.thisMonth ?? 0,
        thisYear: counts?.thisYear ?? 0,
        byHour: hourCounts.map((count, hour) => ({ hour, count })),
        byDayOfWeek: dayCounts.map((count, day) => ({ day, count })),
      },
      tagUsage: tagUsage.results,
      bookmarksBySource: bySource.results.map((r) => ({
        source: (r.source ?? null) as z.infer<typeof zBookmarkSourceSchema> | null,
        count: r.count,
      })),
    };
  }),
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
