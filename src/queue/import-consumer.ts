// Import queue consumer：执行 import_jobs 后台导入任务。
// 消息体：{ jobId, userId, sourceUrl, apiKeyEnc }。
// 自动重试：网络/源服务器错误按 attempts 延迟重试（30s/300s/1800s），
// 重试耗尽后任务置 failed（断点保留，可手动重试续传）。
import { decryptSecret } from "../auth/secret-box.js";
import { runImportJob } from "../trpc/routers/imports.js";
import {
  runFixJob,
  runRetagJob,
  runRetryTaggingJob,
  runTranslateJob,
} from "../trpc/routers/import-fix.js";

const RETRY_DELAYS = [30, 300, 1800] as const;

export type ImportJobKind = "import" | "fix" | "retag" | "translate" | "retry-tagging";

export interface ImportQueueMessage {
  jobId: string;
  userId: string;
  sourceUrl: string;
  apiKeyEnc: string;
  kind?: ImportJobKind;
}

export function parseImportQueueMessage(input: unknown): ImportQueueMessage {
  const msg = input as Partial<ImportQueueMessage>;
  if (!msg || typeof msg !== "object") throw new Error("INVALID_IMPORT_MESSAGE");
  if (typeof msg.jobId !== "string" || typeof msg.userId !== "string" ||
      typeof msg.sourceUrl !== "string" || typeof msg.apiKeyEnc !== "string") {
    throw new Error("INVALID_IMPORT_MESSAGE");
  }
  return msg as ImportQueueMessage;
}

export async function handleImportBatch(
  db: D1Database,
  batch: MessageBatch<unknown>,
  env: Env,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  for (const message of batch.messages) {
    let msg: ImportQueueMessage;
    try {
      msg = parseImportQueueMessage(message.body);
    } catch {
      // 无法解析的消息：ack 避免死循环
      message.ack();
      continue;
    }

    // 任务不存在或已终态 → ack
    const job = await db
      .prepare("SELECT status FROM import_jobs WHERE id = ? AND user_id = ?")
      .bind(msg.jobId, msg.userId)
      .first<{ status: string }>();
    if (!job || job.status === "success" || job.status === "failed") {
      message.ack();
      continue;
    }

    try {
      if (msg.kind === "fix") {
        const apiKey = await decryptSecret(msg.apiKeyEnc, env.LLM_CONFIG_KEY);
        await runFixJob(db, msg.jobId, msg.userId, msg.sourceUrl, apiKey, env, opts);
      } else if (msg.kind === "retag") {
        // 维护任务：不依赖源实例，无需解密 api_key_enc
        await runRetagJob(db, msg.jobId, msg.userId);
      } else if (msg.kind === "translate") {
        // 维护任务：仅翻译标签，无需源 API key
        await runTranslateJob(db, msg.jobId, msg.userId, env, opts);
      } else if (msg.kind === "retry-tagging") {
        // 维护任务：把打标签失败的书签重新入队到 enrichment 队列
        await runRetryTaggingJob(db, msg.jobId, msg.userId, env.ENRICHMENT_QUEUE);
      } else {
        const apiKey = await decryptSecret(msg.apiKeyEnc, env.LLM_CONFIG_KEY);
        await runImportJob(db, msg.jobId, msg.userId, msg.sourceUrl, apiKey, opts);
      }
      message.ack();
    } catch (err) {
      // 自动重试：attempts 1-3 延迟重试；attempt 4 置 failed（断点保留）
      if (message.attempts <= 3) {
        const delaySeconds = RETRY_DELAYS[message.attempts - 1]!;
        const msgText = err instanceof Error ? err.message : "导入失败";
        await db
          .prepare("UPDATE import_jobs SET error = ?, updated_at = ? WHERE id = ?")
          .bind(msgText, Date.now(), msg.jobId)
          .run();
        message.retry({ delaySeconds });
      } else {
        const msgText = err instanceof Error ? err.message : "导入失败";
        await db
          .prepare("UPDATE import_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
          .bind(msgText, Date.now(), msg.jobId)
          .run();
        message.ack();
      }
    }
  }
}
