export interface ReaderBookmark {
  title: string | null;
  url: string;
  summary: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

export function renderReaderHtml(bookmark: ReaderBookmark): string {
  let protocol: string;
  try {
    protocol = new URL(bookmark.url).protocol;
  } catch {
    throw new Error("READER_URL_INVALID");
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error("READER_URL_INVALID");
  const title = escapeHtml(bookmark.title ?? bookmark.url);
  const href = escapeAttribute(bookmark.url);
  const summary = bookmark.summary ? `<p>${escapeHtml(bookmark.summary)}</p>` : "";
  return `<article><h1>${title}</h1>${summary}<p><a href="${href}" rel="noreferrer">打开原链接</a></p></article>`;
}
