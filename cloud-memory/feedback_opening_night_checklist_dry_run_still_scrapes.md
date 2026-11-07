---
name: feedback_opening_night_checklist_dry_run_still_scrapes
description: "opening-night-checklist.js --dry-run still runs live scraper/discovery calls (ScrapingBee, Browserbase) — it only skips Discord/email dispatch, not the pipeline itself"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 791efb2d-8526-4c63-af45-55ba11498459
  modified: 2026-08-17T15:01:51.953Z
---

`node scripts/opening-night-checklist.js --show=ID --dry-run` is NOT a safe no-op smoke test. Per its own doc in `.github/workflows/CLAUDE.md`, `dry_run` means "evaluate SLA, skip Discord/email dispatch" — it still runs the full live discovery pipeline (SERP calls, ScrapingBee page fetches, Browserbase sessions for Cloudflare-gated aggregators like BWW), burning real API credits and money.

**Why:** Ran it to sanity-check that `scripts/lib/opening-night-checks/*.check.js` still worked after adding an unrelated new file (`lifetime-sweep-runner.js`) alongside them (task #1746). Triggered ScrapingBee page fetches + a paid Browserbase session before I noticed the spend in the output and stopped. The check modules themselves were never edited (confirmed via `git diff` first) — the live run was unnecessary; a local run of just the check's own `run()` against cached `data/review-texts` would have proven the same thing for free.

**How to apply:** Never reach for `opening-night-checklist.js --dry-run` as a cheap verification step. To sanity-check an opening-night-checks plugin without touching live scrapers: call `require('./scripts/lib/opening-night-checks/<check>.check.js').run(show, context)` directly against local `data/review-texts` + `data/reviews.json` (context = `{ reviewsDoc, reviewTextsRoot }`), or use one of the `audit-*-lifetime.js` sweep scripts (`[[project_lifetime_corpus_sweep_pattern]]`) with `--show=ID` — both are local-file-only, zero network cost.
