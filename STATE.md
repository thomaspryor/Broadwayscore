# BRO-8323 state (2026-11-27, headless session 87aa9829)

## Done (committed on branch job/linear-BRO-8323-mwylrquo, NOT landed)
- a78daf89fe2, e1f909ab845, ef69c56b4d1: gather-reviews parks non-Broadway (off-broadway, west-end,
  off-west-end, regional, tour) press-night SERP *empties* for 2.5h in a flat key namespace
  (`neg:'gather'`) inside /tmp/bd-serp-cache, so gather-reviews.yml's existing restore/merge carries it.
  Broadway and unknown categories: unchanged (policy returns {}). Kill switch GATHER_SERP_NEGCACHE_DISABLED=1.
  Files: scripts/lib/serp-gather-negative-cache.js (new), scripts/lib/serp-negative-cache-policy.js
  (gatherNegativeCacheOpts), scripts/lib/url-discovery.js (negativeCacheStore option),
  scripts/gather-reviews.js (searchForReviewViaSERP), scripts/lib/sb-market-gate.js (export GATED_CATEGORIES).
  Test: scripts/lib/serp-gather-negative-cache.test.mjs (7 pass; red with either wiring half reverted).
- Commit after that: probe-historical-backfill-yield.js exits 2 when review-texts is missing (it used to
  print "low-yield" from zero data). Test: scripts/lib/probe-historical-backfill-yield.test.mjs (red-then-green).
- /second-opinion: pass, no blockers, fixes applied. Diff is 278 gated lines, so the merge gate needs /ship-check.

## Remaining
1. Run /ship-check on `git diff origin/main...HEAD`, fix findings.
2. Land: `scripts/merge-worktree-to-main.sh` (land/** + land.yml), wait for the Land run.
3. On main: `node --test scripts/lib/serp-gather-negative-cache.test.mjs` and `node scripts/lib/check-sb-credits.js`.
4. After the next non-Broadway opening, measure: compare SD credits per non-Broadway press-night gather pass
   (`Gather Review Data`, purpose `press-night:*`) before and after; replay says up to 42% (~149k SD cr/30d) is
   an UPPER bound. A live probe showed most Google answers are non-empty filler (already 24h-cached), yet
   repeat passes re-spent full cost, which suggests cross-run cache restores miss (restore-keys picks one newest
   entry while poller/gather/shards all save). Investigate that restore gap: it limits this cut and the 24h cache.

## Findings for the report (measured 2026-11-19..27)
- SD ~100k credits/day, 90% SERP at 5 cr. Top flows: Gather Review Data SERP 41% (historical backfill ~19k/day,
  West End ~12k, regional ~5k, Broadway open ~7.5k), Opening Night Reviews 10%, Audit Aggregator Review Gap 10%,
  Opening Night Express 7%. Vendor: 2.06M of 4.84M (3M + rollover) used, renews 2026-12-03.
- SB 25,092 of 254,996 used since 2026-11-24 renewal; ~4.4-6k/day after the Nov 25 market gate.
- Historical backfill repeat lap is productive (~710 of 1,404 new files on revisited shows came from SERP,
  ~1,000 SD cr per review), so it was left alone.
- Tiers: SD Lite $40/200k, Standard $90/1M, Pro $200/3M (annual = 10 months for 12; a downgrade reportedly
  resets rollover). SB Hobby $19/75k, Freelance $49/250k, Startup $99/1M, no rollover.
- Recommendation: SD stay on Pro (Standard needs <=800k/mo, about -73%; SERP on Bright Data costs ~4.5x).
  SB: cancel at 2026-12-24 renewal ($49/mo) per owner's yes, gated on the BRO-8330 keyless trial.
  Optional: SD annual billing (~$33/mo) is an owner billing choice.
