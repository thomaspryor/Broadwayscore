---
name: recoupment-rss-poller-architecture
description: "RSS poller for trade-press recoupment announcements — design rules, gotchas, expansion path"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ce25eb13-939b-4ab5-b539-1093882e7ccf
---

`scripts/poll-trade-press-rss.js` polls feeds flagged `trackRecoupment: true` in `scripts/lib/rss-discovery.js` (Variety Legit + Deadline as of v1). Hourly cron via `commercial-rss-poll.yml`. Detects recoupment within ~1h vs. Friday-scraper's 36h worst case.

**Why:** Friday SERP scraper + Saturday apply + Sunday newsletter = ≥36h latency on breaking trade-press news. Hourly RSS shrinks that to ≤1h for the subset of recoupments that show up in trade-press RSS first.

**How to apply (extending feeds):**
- New feed must be a registered entry in `rss-discovery.js` AND its host MUST be in `TRUSTED_RECOUPMENT_HOSTS` (`scripts/lib/trusted-recoupment-domains.js`) — the auto-apply gate cross-checks both. Adding a feed without trusted-host registration silently disables auto-apply (entries land in pending, never promote).
- Do NOT add Playbill RSS — defunct (404 since March 2026). Do NOT add Broadway News Reviews — it's a reviews-tag feed (`/tag/review/rss/`), no recoupment content.
- BroadwayWorld has no RSS feed registered; would need a new entry sourced from `broadwayworld.com/rss/`.

**How to apply (regex maintenance):**
- Pre-filter regex: `/recoup(ed|ment|s)?|earned back/i`. Do NOT add `paid off` (puff-piece FP — empirically caught "Tony Nominees… No Budget Limits") or `profit` (matches "non-profit").
- Empirical validation: probe via `node -e` against live RSS over 60d window before any pattern change. The Friday scraper accepts wider patterns (SERP-targeted), but the RSS pre-filter must be tighter — every match costs a fetchPage + LLM call.

**How to apply (state semantics):**
- State at `data/commercial-rss-state.json` per-feed: `{ lastSeenGuid, lastPolledAt, errorCount }`.
- Transactional ordering: pending-write happens FIRST, state bump SECOND. If pending write fails, state stays — next run retries the same items. `capHit: true` (LLM cap exhausted mid-feed) leaves lastSeenGuid alone too.
- First-ever poll (no lastSeenGuid): all items in window are eligible. The 60-day pubDate reject prevents backfill of evergreen reposts (Playbill-style SEO republish of 2019 articles).
- `--test-show=SLUG` bypass exists for e2e testing against already-recouped shows; only effective with `--dry-run`.

**How to apply (sharing the classifier):**
- `scripts/lib/recoupment-classify.js` is the single source of truth for the classify prompt + LLM call. Both the Friday SERP scraper and the hourly RSS poller `require()` it. Don't fork the prompt — any drift breaks Friday's pipeline too. Tests inject `opts.openaiFn` for offline runs.

Related: [[recoupment-rss-poller-architecture]] · [[content-quality-regex-fps]] · [[scoring-delta-required]]
