# KaraClone

A single-user URL bookmark service that runs on the **Cloudflare free tier** and is **wire-compatible with the official Karakeep clients** (mobile app and browser extension). Bookmarks are persisted immediately on save; title extraction, AI tagging, and summaries happen asynchronously in the background.

**English** | [中文](README.zh-CN.md)

---

## What is KaraClone

KaraClone is a from-scratch reimplementation of the Karakeep server API, targeting the Cloudflare Workers free plan. It is **not** a port of the full Karakeep server — it implements the subset of the protocol that the locked client versions need, and does not promise compatibility with arbitrary future client versions.

It solves one problem: you keep your bookmarks in your own Cloudflare account, at zero infrastructure cost, while continuing to use the official Karakeep mobile app and browser extension you already know.

**Who it is for:** people who want to self-host their bookmarks but have no VPS or home server. KaraClone is **serverless and fully managed by Cloudflare** — there is no machine to patch, no container to run, no backups to script. If you already run a server, self-host the official Karakeep instead; it is more complete.

**Non-commercial personal use.** KaraClone is a personal project, provided as-is with no warranty and no support commitment. It is not a service, not a product, and not affiliated with Karakeep in any way (see below).

Upstream baseline: Karakeep `5a2f009e2f6d266087f2f3f527e6e384cefd6de4` (2026-08-31). Target clients: Karakeep Mobile 1.11.0, Karakeep Browser Extension 1.2.11.

> **Compatibility caveat.** KaraClone implements the **internal tRPC API** the official clients use. That API is private to the Karakeep project and carries **no compatibility guarantee** — unlike Karakeep's public REST API. There is no stability promise across upstream versions: clients newer than the two pinned above may or may not work, and upstream changes can break this implementation until it catches up.

## Features

- **Instant save** — a URL is persisted immediately; the save never waits on crawling or AI.
- **Async enrichment** — background queue extracts title, description, OG image, and optional body; AI generates 1–8 tags and a short summary when missing.
- **AI tagging** — tags are generated via Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`, locked) or a user-configured LLM provider (OpenRouter / Ollama Cloud).
- **Web dashboard** — zero-build, zero-dependency HTML served directly by the Worker: bookmark list, save form, favourite/archive toggles, tag chips, reading view, settings (LLM providers + model selection), account info. Responsive: fixed sidebar on desktop, bottom tab bar on mobile.
- **Import from another Karakeep instance** — migrate bookmarks and tags from any compatible instance (up to 500 bookmarks, URL-deduplicated), executed as a background queue job with resumable progress.
- **Import repair** — one-click fix for imported data: fetch real titles for bookmarks whose title is a URL, and translate English tags to Chinese via LLM (merging into existing Chinese tags when they collide).
- **API-key auth** — pre-generated `ak2_...` keys, compatible with the official clients' login flow.
- **R2 asset storage** — OG images and uploaded assets served from R2.

## Architecture

```
┌─────────────────────────────┐
│  Karakeep Mobile 1.11.0     │
│  Browser Extension 1.2.11    │
│  Web Dashboard (built-in)    │
└──────────────┬──────────────┘
               │ HTTPS /api/trpc (tRPC, Bearer ak2_...)
┌──────────────▼──────────────┐
│  Cloudflare Worker          │
│  src/index.ts               │
│  ├─ tRPC routers            │
│  ├─ HTTP: /dashboard,       │
│  │  /api/health, /api/version│
│  └─ Queue consumers         │
└───┬──────────┬──────────┬───┘
    │          │          │
┌───▼───┐ ┌────▼────┐ ┌───▼────────┐
│ D1    │ │ R2      │ │ Queues     │
│ SQLite│ │ assets  │ │ enrichment │
│ (auth,│ │ (OG img)│ │ import     │
│ book- │ │         │ │ + DLQ      │
│ marks)│ │         │ └───┬────────┘
└───────┘ └─────────┘     │
                          │ cron (hourly) re-drives stale jobs
```

| Component | Binding | Purpose |
|---|---|---|
| D1 database | `DB` | Authoritative store: users, API keys, bookmarks, tags, lists, import jobs |
| R2 bucket | `ASSETS` | OG images and uploaded assets |
| Queue `karaclone-phase0-enrichment` | `ENRICHMENT_QUEUE` | Async title/tag/summary enrichment |
| Queue `karaclone-phase0-import` | `IMPORT_QUEUE` | Background import / fix jobs |
| Queue `karaclone-phase0-enrichment-dlq` | — | Dead-letter queue for enrichment |
| Workers AI | `AI` | Built-in tagging model |
| Cron trigger | — | Hourly: re-drives stale enrichment jobs |

## Client Compatibility

- **Browser Extension 1.2.11** — log in with server address + API key, save HTTP/HTTPS URLs. Saving succeeds without crawling, Jina, or AI.
- **Mobile 1.11.0** — log in with server address + API key; list, open details, search, browse by tag, favourite, archive, edit, delete.
- Extension origins are allow-listed via the `ALLOWED_EXTENSION_ORIGIN` var (CORS).

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account (free plan is sufficient)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) (pinned to `wrangler@4.128.0` in this repo)

## Deployment

### 1. Install and authenticate

```bash
npm install
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create karaclone-phase0
```

Copy the returned `database_id` into `wrangler.jsonc` → `d1_databases[0].database_id`.

### 3. Create the R2 bucket and queues

```bash
npx wrangler r2 bucket create karaclone-phase0-assets
npx wrangler queue create karaclone-phase0-enrichment
npx wrangler queue create karaclone-phase0-enrichment-dlq
npx wrangler queue create karaclone-phase0-import
```

### 4. Set the secret

`LLM_CONFIG_KEY` encrypts user LLM provider API keys at rest (used by the dashboard settings and the import-repair translation):

```bash
npx wrangler secret put LLM_CONFIG_KEY
```

Generate a strong random value, e.g. `openssl rand -hex 32`.

### 5. Apply migrations

```bash
npx wrangler d1 migrations apply karaclone-phase0 --remote
```

### 6. Deploy

```bash
npx wrangler deploy --strict
```

The Worker is reachable at `https://karaclone-phase0.<your-subdomain>.workers.dev` (`workers_dev: true`).

### 7. Verify

```bash
curl https://karaclone-phase0.<your-subdomain>.workers.dev/api/health
curl https://karaclone-phase0.<your-subdomain>.workers.dev/api/version
```

## Configuration

### Wrangler vars (`wrangler.jsonc`)

| Var | Default | Meaning |
|---|---|---|
| `SERVER_VERSION` | `0.1.0` | Reported to clients via `config.clientConfig`; shown in the dashboard sidebar |
| `AI_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | Locked Workers AI tagging model — do not change |
| `PHASE0_CAPTURE` | `true` | Enables phase-0 probe endpoints (auth-protected) |
| `ALLOWED_EXTENSION_ORIGIN` | two Chrome extension IDs | CORS allow-list for the browser extension |

### Secrets

| Secret | Purpose |
|---|---|
| `LLM_CONFIG_KEY` | AES key for encrypting user LLM API keys in D1 |

### LLM providers

Configured per user in the dashboard **Settings → AI 提供商**:

- **Workers AI** — built-in, free tier, no key needed
- **OpenRouter** — pay-per-use aggregator, `https://openrouter.ai/api/v1`
- **Ollama Cloud** — `https://ollama.com`

After configuring a provider, fetch its model list and save a chat model (and optionally an embedding model) in **模型选择**. Tagging and summaries use the selected chat model; the import-repair tag translation reuses the same configuration.

## Usage

### Web dashboard

Open `/` (or `/dashboard`) in a browser. Register an account, then log in. The dashboard stores the API key in `localStorage` and talks to the same tRPC API as the official clients.

- **书签 (Bookmarks)** — default view: save a URL, list bookmarks, favourite / archive / delete, expand for note + summary + open original + reading view, filter by tag.
- **设置 (Settings)** — LLM provider configuration, model selection, and the **import panel**: migrate from another Karakeep instance (source URL + email + password), watch job progress, and run **修复 (Fix)** on a successful import to backfill titles and translate English tags to Chinese.
- **账户信息 (Account)** — profile, preferences, logout.

### Official clients

1. Open the Karakeep mobile app or browser extension.
2. Set the server address to your Worker URL.
3. Log in with your account email + password (the client exchanges them for an API key), or paste an existing `ak2_...` key.

### Import & repair

- **Import** — `imports.startImportJob` exchanges credentials for a source API key (password never stored), then a queue consumer paginates the source instance and inserts bookmarks/tags with URL deduplication (max 500 bookmarks). Progress is persisted per job; failed jobs can be retried and resume from the checkpoint.
- **Fix** — `imports.fixImportedData` creates a `kind=fix` job that (1) fetches real titles for bookmarks whose title is a URL, and (2) translates English tags to Chinese in batches via the user's LLM, merging into existing Chinese tags. Both phases are resumable and skip already-processed rows.

## Development

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest run --max-workers=1 --no-isolate (349 tests)
npm run d1:migrate:remote # apply migrations to remote D1
npm run deploy           # wrangler deploy --strict
```

## Project structure

```
src/
├── index.ts              # Worker entry: routing, CORS, queue dispatch
├── env.ts                # Env interface (global merge)
├── auth/                 # API-key auth, password hashing, secret box
├── bookmarks/            # service, page-meta fetch, reader HTML
├── contracts/            # zod schemas shared with clients
├── db/                   # D1 access helpers
├── http/                 # dashboard (1665-line zero-dep UI), assets, routes
├── queue/                # enrichment consumer, import consumer, cron, DLQ
├── trpc/                 # tRPC router + context + per-domain routers
└── ai/                   # Workers AI tagger, OpenAI-compatible client
migrations/               # 0011 D1 migrations (auth → import jobs → fix kind)
scripts/phase0/           # preflight, deploy, contract-replay tooling
test/                     # vitest suites (349 tests)
```

## Limitations

- Single-user oriented (multi-user capable, but no team/collaboration features).
- No offline reading of full page content; clicking a bookmark opens the original URL.
- Semantic search is not enabled (`search.semanticSearchEnabled: false`).
- Import is capped at 500 bookmarks per job.
- Compatibility is guaranteed only for the locked client versions listed above.
- The dashboard search box and favourite/tag filters are UI-present; server-side filtering currently supports `archived` only.

## Not affiliated with Karakeep

KaraClone is an **independent, non-commercial, personal-use project**. It is not affiliated with, endorsed by, or sponsored by the Karakeep project or karakeep-app. "Karakeep" and any related marks belong to their respective owners; the name is used here only to describe protocol compatibility.

It is not a fork, port, or redistribution of the Karakeep server. No Karakeep source code is included in this repository — only the wire protocol was reproduced so that the official clients can talk to it.

If you want the full, official experience (including features KaraClone does not implement), self-host [Karakeep](https://github.com/karakeep-app/karakeep) or use [Karakeep Cloud](https://karakeep.app/pricing/).

## License

[AGPL-3.0](LICENSE), matching the upstream Karakeep license.

KaraClone is intended for **personal, non-commercial self-hosting** on the Cloudflare free tier. If you run a modified version as a network service, AGPL §13 requires you to offer its source to your users.
