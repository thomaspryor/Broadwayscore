# UGC visual QA harness (2026-07-05 launch audit)

Manual Playwright driver used for the pre-launch UGC audit. Not wired into CI —
`playwright.config.ts` only picks up `*.spec.ts`, so this directory is inert
until pieces are promoted into real specs.

## What's here

- `supabase-mock.js` — in-memory GoTrue + PostgREST mock installed via Playwright
  route interception, plus `injectSession()` to act as a signed-in user
  (localStorage `bsc_auth`). Supports eq-filters, order, `return=representation`,
  `vnd.pgrst.object`, the `reorder_list_items` RPC, and per-table simulated write
  failures (`failWrites: ['reviews']`). **This is the intended base for the
  Phase 4 regression specs** (failed-save-preserves-text, log-another-viewing-appends)
  — the existing fixture pages can't test real auth/save paths.
- `capture.js` — flow driver: fixture states, My Shows mock tabs, and live
  show-page signed-in flows (save, second viewing, failed save, watchlist,
  add-to-list) at 390px + 1440px. Screenshots to `shots/`, findings to
  `findings.json`.
- `findings-2026-07-05.json` — audit-run findings snapshot.
- `bootstrap-stub-data.js` — synthesizes gitignored `data/*.json` stubs from
  committed `public/data/mobile-shows.json` for environments without the private
  data repo (cloud sessions). Refuses to touch git-tracked files. NOTE: the
  prebuild scripts it feeds (`build-slug-redirects.js`, `generate-diary-data.js`)
  DO overwrite tracked outputs — `git checkout` them afterwards; never commit
  stub-derived data.

## Usage

```bash
# real data (local): skip bootstrap. Cloud/stub: node tests/e2e/ugc-qa/bootstrap-stub-data.js
NEXT_PUBLIC_FEATURES="...,userAccounts" \
NEXT_PUBLIC_SUPABASE_URL="https://stub-supabase.local" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJ<any-jwt-shaped-string>" \
npx next dev -p 3456

node tests/e2e/ugc-qa/capture.js [fixture|myshows|live|all]
```

The stub Supabase URL never resolves — all traffic to it is intercepted by the
mock, so "live" flows exercise the real components end-to-end offline.

Full audit context + launch plan: Notion card "Rating/Review + Wishlist launch
audit" (2026-07-05).
