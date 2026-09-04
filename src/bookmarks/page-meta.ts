// 网页简介抓取：title / description / favicon（meta 标签解析，纯文本处理）。
// 失败一律返回 null 字段，不阻塞书签创建。

export interface PageMeta {
  title: string | null;
  description: string | null;
  favicon: string | null;
}

const MAX_HTML_BYTES = 512 * 1024; // 512 KiB

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

function absoluteUrl(base: string, ref: string): string | null {
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

export async function fetchPageMeta(
  url: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<PageMeta> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KaraClone/0.1)" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { title: null, description: null, favicon: null };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return { title: null, description: null, favicon: null };
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf.slice(0, MAX_HTML_BYTES));

    let title: string | null = null;
    let description: string | null = null;
    let favicon: string | null = null;

    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (titleMatch) title = decodeEntities(titleMatch[1]!);

    const metaRe = /<meta[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = metaRe.exec(text)) !== null) {
      const tag = m[0];
      const name = (extractAttr(tag, "name") ?? extractAttr(tag, "property") ?? "").toLowerCase();
      const content = extractAttr(tag, "content");
      if (!content) continue;
      if (!description && (name === "description" || name === "og:description")) {
        description = content.slice(0, 300);
      }
    }

    const iconRe = /<link[^>]*rel=["']?(?:shortcut\s+)?icon["']?[^>]*>/i;
    const iconMatch = iconRe.exec(text);
    if (iconMatch) {
      const href = extractAttr(iconMatch[0], "href");
      if (href) favicon = absoluteUrl(url, href);
    }
    if (!favicon) {
      const appleRe = /<link[^>]*rel=["']apple-touch-icon["'][^>]*>/i;
      const appleMatch = appleRe.exec(text);
      if (appleMatch) {
        const href = extractAttr(appleMatch[0], "href");
        if (href) favicon = absoluteUrl(url, href);
      }
    }

    return { title, description, favicon };
  } catch {
    return { title: null, description: null, favicon: null };
  }
}
