import { z } from "zod";
import { protectedProcedure, router } from "../base.js";

const zTagListRequestSchema = z.object({
  nameContains: z.string().optional(),
  ids: z.array(z.string()).optional(),
  attachedBy: z.enum(["ai", "human", "none"]).optional(),
  sortBy: z.enum(["name", "usage", "relevance"]).optional().default("usage"),
  cursor: z.object({ page: z.number().int().min(0) }).nullish().default({ page: 0 }),
  limit: z.number().int().min(1).max(100).optional(),
});

const zGetTagResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  numBookmarks: z.number(),
  numBookmarksByAttachedType: z.record(z.enum(["ai", "human"]), z.number()),
});

export const tagsRouter = router({
  list: protectedProcedure
    .input(zTagListRequestSchema)
    .output(
      z.object({
        tags: z.array(zGetTagResponseSchema),
        nextCursor: z.object({ page: z.number().int().min(0) }).nullish(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.user.id;
      const params: unknown[] = [userId];
      let where = "WHERE t.user_id = ?";
      if (input.nameContains) {
        where += " AND t.name LIKE ?";
        params.push(`%${input.nameContains}%`);
      }
      if (input.ids && input.ids.length > 0) {
        where += ` AND t.id IN (${input.ids.map(() => "?").join(",")})`;
        params.push(...input.ids);
      }
      const limit = input.limit ?? 50;
      const offset = (input.cursor?.page ?? 0) * limit;
      params.push(limit, offset);

      const orderBy =
        input.sortBy === "usage"
          ? "num_bookmarks DESC, t.name ASC"
          : "t.name ASC";

      const rows = await ctx.env.DB.prepare(
        `SELECT t.id, t.name, t.num_bookmarks,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id AND bt.attached_by = 'ai') AS num_ai,
          (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id AND bt.attached_by = 'human') AS num_human
        FROM tags t
        ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      )
        .bind(...params)
        .all<{ id: string; name: string; num_bookmarks: number; num_ai: number | null; num_human: number | null }>();

      const tags = rows.results.map((r) => ({
        id: r.id,
        name: r.name,
        numBookmarks: r.num_bookmarks,
        numBookmarksByAttachedType: { ai: r.num_ai ?? 0, human: r.num_human ?? 0 },
      }));

      const nextCursor = tags.length === limit ? { page: (input.cursor?.page ?? 0) + 1 } : null;
      return { tags, nextCursor };
    }),
});
