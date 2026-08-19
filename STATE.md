# BRO-70 session state (2026-08-19)

## What's done
- New script `scripts/backfill-network-tier-dates.js` — committed + pushed to
  `job/linear-BRO-70-mt0ccifj` (public repo). Scoped to reviews.json's
  undated-with-url set (not the raw review-texts corpus, which includes
  ticket-vendor/listing pages that would get plausible-but-wrong dates
  stamped on them). Tiers: URL pattern -> text regex -> plain fetch ->
  cookies -> archive.org -> paid fetchPage(). Every free-tier fetch is
  checked with a redirect-bounce/canonical-mismatch guard before its HTML is
  trusted (found and fixed live: a dead-link 301 to a homepage/section page
  passed both scraper.js's own verifyFetchedUrl AND a naive pathname check,
  producing a wildly wrong date — see `isRedirectBounce()` + the wayback-
  unwrap logic in `verifiedOrNull()`).
- Also fixed two concurrency bugs found while load-testing: fetchPage()'s
  shared Playwright browser singleton isn't safe under concurrent callers
  (mutexed via `withFetchPageMutex`), and the archive.org rate limiter used
  to skip its post-request delay on failed lookups — the common case for
  dead old links — which caused 429s at concurrency=8 (fixed with
  try/finally in `queueArchiveRequest`).
- Ran `backfill-url-dates.js --apply` across the WHOLE review-texts corpus:
  +163 reviews dated (URL-pattern only, zero-fetch, zero contamination
  risk).
- Ran the new scoped script (`--concurrency=8 --free-only`) for ~5 min
  before the session time budget forced a stop: +10 more reviews dated via
  plain-fetch/archive.org/text-regex, out of 50 candidates attempted
  (extracted=7 at the last progress checkpoint, a few more by the time it
  was killed — confirm exact count via `git -C ~/broadway-review-texts show
  HEAD --stat` if it matters).
- Ran the REQUIRED gates before committing (per BRO-70's incident-prevention
  clause): `node scripts/audit-cross-production.js` then
  `node scripts/auto-triage-cross-production.js --apply` — flagged 3 reviews
  wrongProduction (oh-mary-2024, stranger-things-the-first-shadow-west-end-2023,
  the-outsiders-world-premiere-regional-2023). A 4th
  (1536-west-end-2026/theatre-weekly--greg-stewart.json) was auto-flagged by
  review-write-guard's own built-in date-plausibility guard at write time.
  Then `node scripts/audit-review-contamination.js --gate` — **PASSED**: 0
  cross-market leaks, 24 non-blocking strict hits (under the floor of 25).
- Committed + pushed to `~/broadway-review-texts` (private data repo,
  commit `05c4870e86b` on `main`, rebased cleanly onto CI's concurrent
  commits).
- Triggered `rebuild-reviews.yml` (run 32283624337) to regenerate
  `reviews.json` from the updated review-texts. **Was still running when
  the session hit its time budget — check status:**
  `gh run view 32283624337 --json status,conclusion`
  If it succeeded, verify reviews.json's undated count dropped (see below).
  If it failed, investigate before re-running (don't blindly re-trigger).
- Created Notion tracking card: https://app.notion.com/p/BRO-70-Network-tier-publishDate-backfill-3c1637c5416f81e18cb0f31913b4a4ea

## What's NOT done (the actual acceptance criterion)
- Acceptance criteria says ALL ~2900 (measured 2403 at session start, ~1832
  remain after this session's URL-tier sweep) undated reviews get a
  publishDate. This session closed ~183 of them
  (163 URL-tier + ~10-20 network-tier) — nowhere near closing the set.
- **Hard blocker: archive.org's CDX rate limit (~15/min, throttled here to
  ~13/min to be safe) means the free-tier network fetch alone needs
  multiple HOURS of wall-clock time to burn through ~1800 remaining
  candidates** (at ~50 candidates / 4 min observed rate, ~1800 candidates
  is roughly 2.5 hours of continuous running). This cannot be closed in a
  single 120-minute session. It needs either:
  (a) a scheduled/cron continuation across multiple days (pattern already
      exists in this repo: see `scripts/backfill-gather-batch.sh` +
      launchd, though that's for a different backfill — a similar daily
      batch job could be built for this), or
  (b) accepting the paid `fetchPage()` tier's cost/latency for the
      remainder (untested at scale this session — the Playwright fallback
      mutex serializes those calls, so it's also slow, likely 30-60s/item
      worst case for candidates that exhaust all providers).

## Exact resume command
```
cd /Users/tompryor/Broadwayscore   # or a fresh worktree
ln -sf /Users/tompryor/broadway-review-texts data/review-texts   # if not already symlinked
node scripts/backfill-network-tier-dates.js --concurrency=8 --free-only > /tmp/bro70-run.log 2>&1 &
# let it run, checkpoint periodically:
#   node scripts/audit-cross-production.js
#   node scripts/auto-triage-cross-production.js --apply
#   node scripts/audit-review-contamination.js --gate   # MUST pass before committing
#   git -C ~/broadway-review-texts add -A && git -C ~/broadway-review-texts commit -m "..." && git -C ~/broadway-review-texts pull --rebase origin main && git -C ~/broadway-review-texts push origin main
#   gh workflow run rebuild-reviews.yml -f reason="..."
```

## Linear
BRO-70 comment posted with this summary; state left as-is (not moved to
"In Review") because the acceptance criterion (ALL ~2900 dated) is not met
and won't be within one session — see comment for the rate-limit blocker
and recommended next step (scheduled continuation).
