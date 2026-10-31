---
name: ci-tsc-gate-scope
description: CI has a TypeScript Check job that runs root tsc + scripts/llm-scoring tsc. Other scripts/* subtrees are NOT type-checked in CI — local tsc on scripts/tsconfig.json has 86 pre-existing rootDir errors.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4393b6e0-e6f1-40d2-8318-0c91374a470d
---

`.github/workflows/test.yml` has a `typescript-check` job (added commit
c333380ada, 2026-05-17) that runs two tsc invocations:

1. `npx tsc --noEmit` — root config. Covers `src/`, `app/`, `tests/`. Excludes
   `scripts/`.
2. `npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json` — scoped config that
   extends `scripts/tsconfig.json` but restricts include to `llm-scoring/` only.

**Why scoped:** running `npx tsc --noEmit -p scripts/tsconfig.json` against the
whole tree produces 86 pre-existing `rootDir` errors (cross-boundary imports in
audit-tony-all-seasons.ts, scrape-grosses.ts, count-pool.ts, etc.). Adding the
whole tree to CI without first fixing those would land instant-red.

**What this catches:** type errors in `scripts/llm-scoring/*.ts` — the original
bug class that motivated the gate (12 errors shipped in `evaluate.ts:446-448`
when the producer type changed but the consumer wasn't updated).

**What this does NOT catch:** type errors anywhere else in `scripts/` —
scrape-*.ts, audit-*.ts, gather-reviews.ts, opening-night-*.ts, etc.

**How to apply:**
- Editing `scripts/llm-scoring/*.ts`? Run `npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json`
  locally before pushing. CI will catch it too, but feedback is faster locally.
- Editing other `scripts/*.ts`? Run `npx tsc --noEmit -p scripts/tsconfig.json`
  locally and filter out the pre-existing rootDir errors (`grep -v "rootDir"`).
  CI does NOT gate this, so the discipline is operator-side until the rootDir
  issues are cleaned up.
- Adding a new scripts/ subtree that should be gated: copy
  `scripts/llm-scoring/tsconfig.json`, update the include path, register in
  `test.yml`'s `typescript-check` job.
