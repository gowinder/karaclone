import { z } from "zod";

export const zTagStyleSchema = z.enum([
  "lowercase-hyphens",
  "lowercase-spaces",
  "lowercase-underscores",
  "titlecase-spaces",
  "titlecase-hyphens",
  "camelCase",
  "as-generated",
]);
export type TagStyle = z.infer<typeof zTagStyleSchema>;

export const zWhoAmIResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  image: z.string().nullish(),
  localUser: z.boolean(),
});
export type WhoAmI = z.infer<typeof zWhoAmIResponseSchema>;
export const whoAmISchema = zWhoAmIResponseSchema;

export const zReaderFontFamilySchema = z.enum(["serif", "sans", "mono"]);
export type ReaderFontFamily = z.infer<typeof zReaderFontFamilySchema>;

export const zUserSettingsSchema = z.object({
  bookmarkClickAction: z.enum(["open_original_link", "expand_bookmark_preview"]),
  archiveDisplayBehaviour: z.enum(["show", "hide"]),
  timezone: z.string(),
  backupsEnabled: z.boolean(),
  backupsFrequency: z.enum(["daily", "weekly"]),
  backupsRetentionDays: z.number().int().min(1).max(365),
  readerFontSize: z.number().int().min(12).max(24).nullable(),
  readerLineHeight: z.number().min(1.2).max(2.5).nullable(),
  readerFontFamily: zReaderFontFamilySchema.nullable(),
  autoTaggingEnabled: z.boolean().nullable(),
  autoSummarizationEnabled: z.boolean().nullable(),
  tagStyle: zTagStyleSchema,
  curatedTagIds: z.array(z.string()).nullable(),
  inferredTagLang: z.string().nullable(),
});
export type UserSettings = z.infer<typeof zUserSettingsSchema>;
export const userSettingsSchema = zUserSettingsSchema;
