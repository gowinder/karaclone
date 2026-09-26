// 修复导入数据：补标题（源 content.title + fetchPageMeta 兜底）+ 标签翻译中文。
// 由 queue consumer 调用；进度写入 import_jobs（kind='fix'）。
import { z } from "zod";
import { canonicalizeUrl } from "../../url/canonicalize.js";
import { decryptSecret } from "../../auth/secret-box.js";
import { runOpenAiCompatible } from "../../ai/openai-compatible.js";
import { fetchPageMeta } from "../../bookmarks/page-meta.js";
import { fetchAllBookmarks } from "./imports.js";

const CONCURRENCY = 5;
// 50/20 个/批在 ollama-cloud 上单次请求超 100s（Cloudflare 524），降到 10 个/批
const TRANSLATE_BATCH = 3;

const zTagTranslationSchema = z.object({
  tags: z.array(z.object({ en: z.string(), zh: z.string() })).min(1).max(100),
});

// 判断标签是否含中文字符（含中文 → 视为已翻译，跳过）
function isChinese(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s);
}

// 一次 LLM 调用批量翻译一批英文标签 → { en → zh } 映射。
// 失败抛错（调用方按批重试）；LLM 未配置时返回 null（跳过翻译）。
async function translateTagBatch(
  db: D1Database,
  env: Env | undefined,
  userId: string,
  batch: string[],
  fetchImpl?: typeof fetch,
): Promise<Map<string, string> | null> {
  if (!env) return null;
  const sel = await db
    .prepare("SELECT chat_provider, chat_model FROM user_llm_selection WHERE user_id = ?")
    .bind(userId)
    .first<{ chat_provider: string; chat_model: string }>();
  if (!sel?.chat_model) return null;
  const cfg = await db
    .prepare("SELECT base_url, api_key_enc FROM user_llm_config WHERE user_id = ? AND provider = ?")
    .bind(userId, sel.chat_provider)
    .first<{ base_url: string | null; api_key_enc: string | null }>();

  const systemPrompt =
    'You are a translator. Translate each English tag into concise Chinese (2-6 characters preferred). ' +
    'Keep technical terms natural in Chinese. Respond with pure JSON: {"tags": [{"en": "...", "zh": "..."}]}';

  let raw: unknown;
  if (sel.chat_provider === "workers-ai") {
    raw = await env.AI.run(sel.chat_model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(batch) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            tags: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                properties: { en: { type: "string" }, zh: { type: "string" } },
                required: ["en", "zh"],
                additionalProperties: false,
              },
            },
          },
          required: ["tags"],
          additionalProperties: false,
        },
      },
    });
  } else {
    if (!cfg?.api_key_enc || !env.LLM_CONFIG_KEY) return null;
    const apiKey = await decryptSecret(cfg.api_key_enc, env.LLM_CONFIG_KEY);
    const baseUrl =
      cfg.base_url ?? (sel.chat_provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ollama.com");
    const endpoint = sel.chat_provider === "ollama-cloud" ? "v1/chat/completions" : "chat/completions";
    raw = await runOpenAiCompatible({
      baseUrl,
      apiKey,
      model: sel.chat_model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(batch) },
      ],
      endpoint,
      fetchImpl,
      // 单批 120s 超时：ollama-cloud 慢响应时快速失败，由调用方跳过该批继续
      timeoutMs: 120000,
    });
  }

  const parsed = zTagTranslationSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (!parsed.success) throw new Error("标签翻译结果解析失败");
  const map = new Map<string, string>();
  for (const t of parsed.data.tags) {
    const zh = t.zh.trim();
    if (zh && !isChinese(zh)) continue; // 翻译结果仍非中文 → 丢弃
    map.set(t.en.trim(), zh);
  }
  return map;
}

// 标签翻译阶段（runFixJob 阶段 2 与 runTranslateJob 共用）：
// 收集含英文的标签 → 分批 LLM 翻译 → 更新 tags.name（撞已有中文则合并）。
// 返回 { translated, failed }；进度写入 import_jobs.skipped。
async function translateAllTags(
  db: D1Database,
  jobId: string,
  userId: string,
  env: Env | undefined,
  fetchImpl: typeof fetch,
): Promise<{ translated: number; failed: number }> {
  const tagRows = await db
    .prepare("SELECT id, name FROM tags WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; name: string }>();
  const englishTags = (tagRows.results ?? []).filter((t) => !isChinese(t.name));
  const nameToId = new Map<string, string>();
  for (const t of tagRows.results ?? []) nameToId.set(t.name, t.id);
  let translated = 0;
  let failed = 0;
  for (let i = 0; i < englishTags.length; i += TRANSLATE_BATCH) {
    const batch = englishTags.slice(i, i + TRANSLATE_BATCH).map((t) => t.name);
    let map: Map<string, string> | null;
    try {
      map = await translateTagBatch(db, env, userId, batch, fetchImpl);
    } catch (err) {
      // 单批 LLM 失败（超时/限流）：跳过该批，不中断整个任务；记录原因便于诊断
      failed++;
      const reason = err instanceof Error ? err.message : "LLM 请求失败";
      await db
        .prepare("UPDATE import_jobs SET error = ?, updated_at = ? WHERE id = ?")
        .bind(reason.slice(0, 200), Date.now(), jobId)
        .run();
      continue;
    }
    if (!map) break; // LLM 未配置 → 跳过翻译
    const ops: D1PreparedStatement[] = [];
    for (const t of englishTags.slice(i, i + TRANSLATE_BATCH)) {
      const zh = map.get(t.name);
      if (!zh || zh === t.name) continue;
      const existingId = nameToId.get(zh);
      if (existingId && existingId !== t.id) {
        // 目标中文标签已存在 → 合并：转移关联后删除英文标签
        ops.push(
          db.prepare(
            "UPDATE bookmark_tags SET tag_id = ? WHERE tag_id = ? AND NOT EXISTS (SELECT 1 FROM bookmark_tags WHERE tag_id = ? AND bookmark_id = bookmark_tags.bookmark_id)",
          ).bind(existingId, t.id, existingId),
        );
        ops.push(db.prepare("DELETE FROM tags WHERE id = ?").bind(t.id));
      } else {
        ops.push(db.prepare("UPDATE tags SET name = ? WHERE id = ?").bind(zh, t.id));
        nameToId.set(zh, t.id);
      }
      translated++;
    }
    if (ops.length > 0) await db.batch(ops);
    await db
      .prepare("UPDATE import_jobs SET skipped = ?, updated_at = ? WHERE id = ?")
      .bind(translated, Date.now(), jobId)
      .run();
  }
  return { translated, failed };
}

// 后台执行修复：补标题 + 标签翻译中文。由 queue consumer 调用。
export async function runFixJob(
  db: D1Database,
  jobId: string,
  userId: string,
  sourceUrl: string,
  apiKey: string,
  env: Env | undefined,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const base = sourceUrl.replace(/\/$/, "");
  const now = Date.now();
  await db
    .prepare("UPDATE import_jobs SET status = 'running', updated_at = ? WHERE id = ?")
    .bind(now, jobId)
    .run();

  // 1) 标题：源 content.title（includeContent 拉真标题）→ 更新 title IS NULL 的书签
  let sourceTitles = new Map<string, string>();
  try {
    const sourceBookmarks = await fetchAllBookmarks(base, apiKey, { includeContent: true });
    for (const bm of sourceBookmarks) {
      const content = (bm as unknown as { content?: { title?: string | null } }).content;
      const t = content?.title?.trim();
      if (t) sourceTitles.set(canonicalizeUrl(bm.url), t);
    }
  } catch {
    // 源不可达：跳过源标题，仅用 fetchPageMeta 兜底
  }

  const missing = await db
    .prepare("SELECT id, canonical_url FROM bookmarks WHERE user_id = ? AND source = 'import' AND title IS NULL")
    .bind(userId)
    .all<{ id: string; canonical_url: string }>();
  const missingRows = missing.results ?? [];

  let fixed = 0;
  let failed = 0;
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (let i = 0; i < missingRows.length; i += CONCURRENCY) {
    const batch = missingRows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        let title = sourceTitles.get(row.canonical_url) ?? null;
        if (!title) {
          const meta = await fetchPageMeta(row.canonical_url, { fetchImpl });
          title = meta.title?.trim() || null;
        }
        if (!title) return false;
        await db.batch([
          db.prepare("UPDATE bookmarks SET title = ?, modified_at = ? WHERE id = ?").bind(title, Date.now(), row.id),
          db.prepare("UPDATE bookmark_links SET title = ? WHERE id = ?").bind(title, row.id),
        ]);
        return true;
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") failed++;
      else if (r.status === "fulfilled" && r.value === true) fixed++;
    }
    const done = Math.min(i + CONCURRENCY, missingRows.length);
    await db
      .prepare("UPDATE import_jobs SET imported = ?, failed = ?, processed = ?, updated_at = ? WHERE id = ?")
      .bind(fixed, failed, done, Date.now(), jobId)
      .run();
  }

  // 2) 标签翻译：收集含英文的标签 → 分批 LLM 翻译 → 更新 tags.name（撞已有中文则合并）
  const { translated, failed: translateFailed } = await translateAllTags(db, jobId, userId, env, fetchImpl);
  failed += translateFailed;

  await db
    .prepare("UPDATE import_jobs SET status = 'success', imported = ?, skipped = ?, failed = ?, processed = ?, updated_at = ? WHERE id = ?")
    .bind(fixed, translated, failed, missingRows.length, Date.now(), jobId)
    .run();
}

// 后台执行重新统计标签数量：全量重算 tags.num_bookmarks（物化列，触发器自动维护，
// 此任务用于修复历史数据漂移）。由 queue consumer 调用。
export async function runRetagJob(
  db: D1Database,
  jobId: string,
  userId: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare("UPDATE import_jobs SET status = 'running', updated_at = ? WHERE id = ?")
    .bind(now, jobId)
    .run();

  const tagRows = await db
    .prepare("SELECT id FROM tags WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string }>();
  const tags = tagRows.results ?? [];
  const total = tags.length;

  // 分批重算（每批 100 个标签），逐批更新进度
  const BATCH = 100;
  let done = 0;
  for (let i = 0; i < total; i += BATCH) {
    const batch = tags.slice(i, i + BATCH);
    const ops: D1PreparedStatement[] = batch.map((t) =>
      db
        .prepare("UPDATE tags SET num_bookmarks = (SELECT COUNT(*) FROM bookmark_tags WHERE tag_id = ?) WHERE id = ?")
        .bind(t.id, t.id),
    );
    await db.batch(ops);
    done = Math.min(i + BATCH, total);
    await db
      .prepare("UPDATE import_jobs SET imported = ?, processed = ?, updated_at = ? WHERE id = ?")
      .bind(done, done, Date.now(), jobId)
      .run();
  }

  await db
    .prepare("UPDATE import_jobs SET status = 'success', imported = ?, skipped = ?, failed = ?, processed = ?, total = ?, updated_at = ? WHERE id = ?")
    .bind(total, 0, 0, total, total, Date.now(), jobId)
    .run();
}

// 后台执行标签翻译中文：仅翻译阶段（不补标题）。由 queue consumer 调用。
export async function runTranslateJob(
  db: D1Database,
  jobId: string,
  userId: string,
  env: Env | undefined,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const now = Date.now();
  await db
    .prepare("UPDATE import_jobs SET status = 'running', updated_at = ? WHERE id = ?")
    .bind(now, jobId)
    .run();

  const fetchImpl = opts.fetchImpl ?? fetch;
  const { translated, failed } = await translateAllTags(db, jobId, userId, env, fetchImpl);

  await db
    .prepare("UPDATE import_jobs SET status = 'success', imported = ?, skipped = ?, failed = ?, processed = ?, updated_at = ? WHERE id = ?")
    .bind(0, translated, failed, translated, Date.now(), jobId)
    .run();
}
