---
name: karakeep-protocol-sync
description: Track upstream Karakeep tRPC protocol changes and keep KaraClone wire-compatible with the locked official clients (Mobile 1.11.0, Browser Extension 1.2.11). Use when checking protocol drift, when a Karakeep client breaks or shows errors after an app update, or when asked to sync with upstream Karakeep.
---

# Karakeep Protocol Sync

KaraClone reimplements the **internal tRPC API** that Karakeep's official clients speak. Upstream gives no compatibility guarantee on that API (see discussion #3122), so this skill detects drift and drives the fix.

## Core rule

**Upstream commits changing ≠ this repo must change.** The only thing that breaks users is: *a procedure the locked clients call, that this repo does not implement.* Everything else is informational.

## Quick start

```bash
# 1. Detect drift (fetches upstream, compares against pinned baseline)
node .claude/skills/karakeep-protocol-sync/scripts/check-drift.mjs

# Exit 0 = IN_SYNC, 1 = DRIFT (lists missing procedures), 2 = check failed
```

## Workflow

### Detecting drift

Run the script above. Read the JSON report:

| Field | Meaning |
|---|---|
| `clientSurface` | Every `api.<router>.<procedure>` the locked clients actually call |
| `missingForClients` | **Actionable.** Called by clients, not implemented here |
| `commitsBehind` | How far upstream moved — informational only |
| `protocolFilesChanged` | Which `packages/trpc/**` files moved — informational only |

### When `missingForClients` is empty

Nothing to do. If `commitsBehind` is large but no procedures are missing, the repo is still compatible — optionally advance the baseline (below) to record that you checked.

### When `missingForClients` is non-empty

For each missing procedure, follow [REFERENCE.md](REFERENCE.md) — it has the upstream schema lookup recipe, the contract-mapping table, and the implementation checklist.

Minimal loop:

1. Read the upstream definition (procedure + its `.input()`/`.output()` zod schemas).
2. Add the zod contract to `src/contracts/` if the shape is new.
3. Implement the procedure in the mapped router under `src/trpc/routers/`.
4. Add a test in `test/` covering the client's exact call shape.
5. Run `npx tsc --noEmit` and `rtk npx vitest run --max-workers=1 --no-isolate`.
6. Deploy: `rtk npx wrangler@4.128.0 deploy --strict`.

### Advancing the baseline

Only after the repo is verified compatible with the new upstream commit:

```bash
node .claude/skills/karakeep-protocol-sync/scripts/update-baseline.mjs --to origin/main
```

This rewrites `config/upstream-baseline.json`'s `commit`/`commitDate` and moves the local upstream clone's HEAD. Commit the baseline bump separately from implementation changes.

## Key locations

| What | Where |
|---|---|
| Baseline pin | `config/upstream-baseline.json` |
| Upstream clone | `.phase0/upstream/karakeep` (gitignored) |
| Our wire contracts | `src/contracts/*.ts` |
| Our routers | `src/trpc/routers/*.ts` (registry: `src/trpc/router.ts`) |
| Client lock evidence | `config/phase0/client-lock.json` |

## Pitfalls

- **Do not run `git pull` in the upstream clone.** Keep HEAD at the pinned baseline so diffs stay meaningful; the script fetches `origin/main` separately.
- **`api-keys.ts` implements upstream's `apiKeys` router**, and `imports.ts` implements `imports`. The script reads the registry, so folder names differing from router names are handled.
- **Client call sites change too.** `--no-fetch` uses whatever `origin/main` is already fetched; without it the script fetches fresh.
- **Upstream `main` is a moving target.** A procedure present today may be renamed tomorrow — re-run detection after every upstream sync.
