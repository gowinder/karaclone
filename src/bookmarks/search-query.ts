/**
 * Karakeep 搜索语法解析器（客户端可用子集）。
 *
 * 上游实现见 packages/shared/searchQueryParser.ts，基于 typescript-parsec
 * 的完整语法（含 AND/OR 组合、括号、取反）。本实现覆盖官方客户端搜索框
 * 实际会输入的查询形态，并对其余输入做降级处理而非报错。
 *
 * 支持的 qualifier：
 *   is:fav / is:archived          —— 收藏、归档
 *   #tag / tag:name               —— 标签
 *   url:xxx / title:xxx           —— URL、标题子串
 *   source:api                    —— 来源
 *   after:YYYY-MM-DD              —— 创建时间下界
 *   before:YYYY-MM-DD             —— 创建时间上界
 *   裸词                          —— 标题/URL/简介 全文匹配
 *
 * 不支持的（上游有、客户端可用但本仓库无数据源）：is:tagged、is:inlist、
 * is:broken、list:、feed:、age:。它们被忽略而非报错，以免旧客户端崩溃。
 */

export interface ParsedQuery {
  /** 从查询中剥离 qualifier 后剩下的裸文本。 */
  text: string;
  favourited?: boolean;
  archived?: boolean;
  tags: string[];
  urlContains?: string;
  titleContains?: string;
  source?: string;
  after?: number;
  before?: number;
}

const QUALIFIER_RE = /^(is|url|title|tag|source|after|before|list|feed|age):(.*)$/i;

function parseDateMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // YYYY-MM-DD 或完整 ISO 日期
  const ms = Date.parse(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isNaN(ms) ? undefined : ms;
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const result: ParsedQuery = { text: "", tags: [] };
  const words: string[] = [];

  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    // 取反前缀（is:-fav 或 -word）；本实现只处理裸词取反的降级
    const negated = token.startsWith("-") && token.length > 1;
    const body = negated ? token.slice(1) : token;

    // #tag 形式
    if (body.startsWith("#") && body.length > 1) {
      result.tags.push(body.slice(1).toLowerCase());
      continue;
    }

    const m = QUALIFIER_RE.exec(body);
    if (!m) {
      words.push(body);
      continue;
    }
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    switch (key) {
      case "is":
        if (value === "fav") result.favourited = !negated;
        else if (value === "archived") result.archived = !negated;
        // is:tagged / is:inlist / is:broken / is:link / is:text / is:media
        // 本仓库无对应数据源，忽略
        break;
      case "url":
        if (!negated) result.urlContains = value;
        break;
      case "title":
        if (!negated) result.titleContains = value;
        break;
      case "tag":
        if (!negated) result.tags.push(value.toLowerCase());
        break;
      case "source":
        if (!negated) result.source = value;
        break;
      case "after":
        if (!negated) result.after = parseDateMs(value);
        break;
      case "before":
        if (!negated) result.before = parseDateMs(value);
        break;
      // list: / feed: / age: 无对应数据源，忽略
      default:
        break;
    }
  }

  result.text = words.join(" ").trim();
  return result;
}

/**
 * 把解析结果转成 SQL 片段与参数。
 * 返回的 where 不含前导 AND，调用方拼接到已有条件之后。
 */
export function buildSearchConditions(q: ParsedQuery): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.favourited !== undefined) {
    clauses.push("b.favourited = ?");
    params.push(q.favourited ? 1 : 0);
  }
  if (q.archived !== undefined) {
    clauses.push("b.archived = ?");
    params.push(q.archived ? 1 : 0);
  }
  if (q.source) {
    clauses.push("b.source = ?");
    params.push(q.source);
  }
  if (q.after !== undefined) {
    clauses.push("b.created_at >= ?");
    params.push(q.after);
  }
  if (q.before !== undefined) {
    clauses.push("b.created_at <= ?");
    params.push(q.before);
  }
  if (q.urlContains) {
    clauses.push("b.canonical_url LIKE ?");
    params.push(`%${q.urlContains}%`);
  }
  if (q.titleContains) {
    clauses.push("COALESCE(b.title, '') LIKE ?");
    params.push(`%${q.titleContains}%`);
  }
  for (const tag of q.tags) {
    clauses.push(
      "EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND LOWER(t.name) LIKE ?)",
    );
    params.push(`%${tag}%`);
  }
  if (q.text) {
    const like = `%${q.text}%`;
    clauses.push(
      "(COALESCE(b.title, '') LIKE ? OR b.canonical_url LIKE ? OR COALESCE(b.summary, '') LIKE ? OR COALESCE(b.note, '') LIKE ?)",
    );
    params.push(like, like, like, like);
  }
  return { clauses, params };
}
