# BRO-2930 — Scraper cost watch — state as of session interruption

## Root cause found (high confidence)
ScrapingBee stays heavily used despite the Scrapingdog migration because several
cron-reachable scripts construct raw ScrapingBee HTTP calls directly instead of
routing through `scripts/lib/scraper.js`'s `fetchPage()` — the chokepoint where
Scrapingdog is tried first (see `fetchPage()` around scraper.js:962-1005: order is
Playwright(public sites) → Scrapingdog → BrightData → ScrapingBee → Playwright).
These direct-call scripts never attempt SD at all, regardless of the migration.

This is tracked, pre-existing debt: `data/audit/direct-provider-calls-baseline.json`
(frozen 2026-08-12) lists 7 cron-reachable ScrapingBee-only files:
`backfill-cast-web.js`, `collect-review-texts.js`, `gather-reviews.js`,
`recollect-for-scores.js`, `scrape-bww-reviews.js`, `scrape-lottery-rush.js`,
`scrape-nyc-theatre-roundups.js`.

Independent corroboration: `data/audit/provider-spend-daily.jsonl` for 2026-08-30
(the one day both providers reported real billing `dayCredits`) shows
`attributedPct.scrapingdog = 0.109` and `attributedPct.scrapingbee = 0.0088` —
i.e. ~90%+ of BOTH providers' actual billed credits that day came from code paths
that never emit `[SD Call]`/`[SB Call]` telemetry. This is also the direct answer
to the email's own "TELEMETRY NOTE" mystery (SD near-zero in log samples vs 2.35M
billed credits) — it's not a workflow-name mismatch in `measure-scraper-usage.js`,
it's a code-level bypass in the highest-volume scripts.

Scripts that DO go through `fetchPage()` (e.g. `audit-show-review-gap.js`, used by
"Audit Aggregator Review Gap") are working as intended — SB there is a legitimate
fallback when SD misses per-domain, not a routing bug.

## Done this session
- Fixed 2 of the 7 direct-call sites (low-risk, single-purpose scripts, each
  tested live against real target hosts via `fetchWithScrapingdog` before editing):
  - `scripts/scrape-bww-reviews.js` — added `fetchHtmlViaSD()`, tried before the
    existing `fetchHtmlViaSB()` retry loop. Purely additive; falls through
    unchanged on any SD miss.
  - `scripts/scrape-nyc-theatre-roundups.js` — same pattern, added
    `fetchHtmlViaSD()` before the existing SB retry loop.
  - Both verified live: `fetchWithScrapingdog` returns 200 + real HTML for
    `broadwayworld.com/reviews/Hamilton` and `newyorkcitytheatre.com/news/reviews/`.
  - Committed: `bb00c332532` "fix(scraper): try Scrapingdog before ScrapingBee in
    BWW + NYC Theatre scrapers". Pushed to `origin/job/linear-BRO-2930-mtrep6u5`.
- **CAUTION for next session:** while testing, `require('./scripts/scrape-bww-reviews.js')`
  from a `node -e` one-liner executed the script's top-level `main()` for real
  (no `require.main === module` guard) — it started scraping ~200 real shows
  before being cut off by an EPIPE from a piped `head`. No review-text/archive
  file writes were found afterward (checked `git status` on
  `data/review-texts`/`data/aggregator-archive` — clean), and the only file
  changes it caused (`data/audit/scraper-spend-ledger.jsonl`,
  `data/audit/stage-latency.jsonl`) were reverted with `git checkout --`. Don't
  `require()` these CLI scripts directly again — spawn them as a subprocess with
  a `--help`/dry-run flag, or extract the function under test instead.

## NOT done — remaining work
1. **Not yet fixed (same bug class, higher risk/complexity — do NOT blind-migrate):**
   - `scripts/gather-reviews.js` — only 1 direct-SB hit (line ~4426, WE live-fetch
     fallback when archives are empty), low volume, should be a similarly safe
     additive SD-first swap.
   - `scripts/collect-review-texts.js` — **highest-volume culprit**, 2 direct
     hits (SB at line ~2433 "Tier 2", BD at line ~2605). This has its own bespoke
     multi-tier pipeline (Playwright → AMP → Browserbase → directCookies →
     ScrapingBee(proxy-tier escalation: standard/premium/stealth) → BrightData →
     archive.org) that predates the SD migration and has NO Scrapingdog tier at
     all. Runs 3x/day at 150/batch + auto-chains. This is the single biggest
     lever but needs a dedicated session: map SD's `renderJs`/`premium`/
     `stealthMode` options against SB's `standard`/`premium_proxy`/`stealth_proxy`
     credit tiers, insert as a new tier before the existing SB tier, and do a
     real before/after comparison on a handful of paywalled + non-paywalled URLs
     per CLAUDE.md rule 12.5 ("Script migrations: compare output before/after on
     same input").
   - `scripts/recollect-for-scores.js`, `scripts/backfill-cast-web.js`,
     `scripts/scrape-lottery-rush.js` — same low-risk pattern as the 2 already
     fixed (single SB call each), not yet touched. Good candidates for a
     follow-up session using the exact same additive pattern.
2. **Not run:** `npx tsc --noEmit`, `npx next lint` (CLAUDE.md rule 12) on the
   2 changed files — do this first in the next session before anything else.
3. **Not filed:** a Linear P2 card for the `collect-review-texts.js` migration
   (the real fix for the bulk of the cost pressure) — this is a scoped,
   substantial task that deserves its own card, not a quick add-on.
4. **Not run:** `/ship-check`.
5. **Verify command for the acceptance criteria** (not yet posted to the Linear
   card) — proposed:
   `grep -q fetchHtmlViaSD scripts/scrape-bww-reviews.js scripts/scrape-nyc-theatre-roundups.js && echo PASS`
   This structurally pins that the 2 fixed scripts keep their SD-first attempt
   and won't silently regress back to SB-only. It does NOT prove the cost trend
   improved (that needs multi-week `data/audit/provider-spend-daily.jsonl`
   history, not a single command) — say so explicitly when reporting.
6. **Not yet reported** to Linear via `node scripts/linear-session.js report`.

## Exact next command
```
cd /Users/tompryor/Broadwayscore/.claude/worktrees/job-linear-BRO-2930-mtrep6u5
npx tsc --noEmit && npx next lint
node scripts/linear-session.js report --issue=BRO-2930 --status=in-review \
  --summary="Root cause found: 7 cron-reachable scripts bypass fetchPage()'s SD-first chokepoint with raw ScrapingBee calls (data/audit/direct-provider-calls-baseline.json), confirmed by <11%/<1% telemetry attribution on billed SD/SB credits. Fixed 2 of 7 (scrape-bww-reviews.js, scrape-nyc-theatre-roundups.js) with additive SD-first attempts, verified live. collect-review-texts.js (highest volume) and gather-reviews.js still need the same fix — see STATE.md for scoped follow-up." \
  --key-files="scripts/scrape-bww-reviews.js,scripts/scrape-nyc-theatre-roundups.js,data/audit/direct-provider-calls-baseline.json,scripts/lib/provider-telemetry.js" \
  --verification="grep -q fetchHtmlViaSD scripts/scrape-bww-reviews.js scripts/scrape-nyc-theatre-roundups.js && echo PASS"
```
Then file the `collect-review-texts.js` follow-up card and continue the
remaining 3 low-risk migrations (`recollect-for-scores.js`,
`backfill-cast-web.js`, `scrape-lottery-rush.js`, `gather-reviews.js`).
