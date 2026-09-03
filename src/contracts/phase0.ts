import { z } from "zod";

export const apiKeySchema = z.string().regex(/^ak2_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
export const aiTagResultSchema = z.object({
  tags: z.array(z.string().min(1).max(40)).min(1).max(8),
  description: z.string().max(300).nullable(),
});
export type AiTagResult = z.infer<typeof aiTagResultSchema>;
