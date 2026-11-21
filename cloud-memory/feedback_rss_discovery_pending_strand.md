---
name: rss-discovery + Unknown critic strands in _pending
description: RSS hits without criticName silently land in _pending/ and are never re-read by rebuild; single-author feeds MUST set defaultCritic at emit time.
type: feedback
originSessionId: 2b594807-5b67-4947-8da5-e642daddb98a
archived: true
---
Hits emitted by `scripts/lib/rss-discovery.js` with `source: 'rss-discovery'` and no `criticName` get `criticName: 'Unknown'` downstream, which routes them to `_pending/` via `shouldRouteUnknownCriticToPending` in `scripts/lib/review-guards.js` (regression-tested at `tests/unit/pending-strand-routing.test.mjs:41`). `scripts/rebuild-all-reviews.js` never reads `_pending/` — the hit is silently stranded until someone runs `scripts/clean-orphan-pending.js --execute --allow-promote` manually.

**Why:** The Cote Notices Substack addition (2026-04-22, commits `aec4c47f17` + `159a1cd0bb`) hit this trap on first pass. /ship-check caught it before the first real discovery. Without `defaultCritic` stamping, every Cote opening-night review would have silently vanished into `_pending/` — defeating the entire point of auto-discovery.

**How to apply:**
- Any new entry in `SUBSTACK_CRITIC_FEEDS` (or any new single-author RSS feed) MUST include `defaultCritic: '<Full Name>'`. The emit loop at `rss-discovery.js` stamps `hit.criticName` when the feed config has one.
- Also add `"defaultCritic": "<Full Name>"` to the outlet's `data/outlet-registry.json` entry as a belt-and-suspenders fallback — `rebuild-all-reviews.js:2748` resolves criticName from this registry field at rebuild time for any file that still has `criticName: 'Unknown'` or empty.
- Multi-critic RSS feeds (Deadline, THR, Standard — the ones with `needsFilter: true` but no single owner) must NOT set `defaultCritic`. For those, the pending-strand is correct: the real byline is extracted during `collect-review-texts.js`, and the review promotes out of `_pending` once the byline lands.
- Don't "fix" this by adding `rss-discovery` to `VERIFIED_DISCOVERY_SOURCES` in `review-guards.js` — that changes behavior for 13+ multi-critic feeds and risks bad attributions across the board.
