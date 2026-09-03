import { z } from "zod";

export const MAX_QUEUE_MESSAGE_BYTES = 2048;

export const queueMessageSchema = z
  .object({
    bookmarkId: z.string(),
    jobId: z.string(),
    urlSnapshot: z.string(),
    requestedAt: z.string(),
  })
  .strict();

export type QueueMessage = z.infer<typeof queueMessageSchema>;

export function parseQueueMessage(input: unknown): QueueMessage {
  const msg = queueMessageSchema.parse(input);
  const bytes = new TextEncoder().encode(JSON.stringify(msg)).length;
  if (bytes >= MAX_QUEUE_MESSAGE_BYTES) {
    throw new Error("QUEUE_MESSAGE_TOO_LARGE");
  }
  return msg;
}
