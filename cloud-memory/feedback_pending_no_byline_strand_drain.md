---
name: pending-no-byline-strand-drains-opera-only
description: Multi-critic-outlet reviews (Times/Standard/Guardian) with no byline strand in _pending/ forever; the drain ran opera-only — 500+ reviews lost across 70+ shows.
metadata: 
  node_type: memory
  type: project
  originSessionId: 4a109f89-7d0d-4951-846a-70d562e2d7d8
---

When auto-discovery finds a review for a MULTI-CRITIC outlet (The Times, Evening Standard, The Guardian, Deadline, THR) but can't extract a byline, `shouldRouteUnknownCriticToPending` (scripts/lib/review-guards.js) writes it to `data/review-texts/_pending/{showId}/{outlet}--{hash}.json` with `pendingReason: 'no-byline'`. This is **intentional** — you can't write `times-uk--unknown.json` for a many-critic outlet without misattribution. The design assumes the byline is extracted later and the file is promoted out.

**The bug:** nothing drained `_pending/` for non-opera shows. `collect-review-texts.js` does NOT scan `_pending/` (it's a hard sink), and the only real drain — `scripts/replay-pending-bylines.js` (fetch URL → extract byline → promote) — was wired ONLY for opera (`--all-opera`) via update-show-status.yml + discover-historical-shows.yml. Result on 2026-06-04: **511 stranded reviews across 72 shows (378 on 52 open shows)**, including War Horse's real Times review (Dominic Maxwell) — the exact one the user found on Google while the site showed only 8 reviews.

**Why:** This is the dominant reason West End / Broadway shows show far fewer reviews than exist. The reviews ARE discovered (site-search/rss find them); they die in `_pending/` for lack of a byline. Discovery looked fine in logs (`[Layer 3] The Times: 3 result(s)`) but the hits were immediately "routing to pending".

**How to apply:**
- The fix (origin/main 70c1bbfcfb): added `--all-open` (open/previews shows with pending) and `--all-pending` (full backlog) to replay-pending-bylines.js, and wired `--all-open` into enrich-reviews.yml (every 6h) after the byline backfill. `_pending/` now drains continuously for all shows.
- When a show is "missing reviews", ALWAYS check `data/review-texts/_pending/{showId}/` FIRST — the reviews are often already discovered and stranded. `node scripts/replay-pending-bylines.js --show=ID` recovers them.
- The `_pending/` files have no fullText (no-byline stubs); replay fetches the URL, extracts byline, promotes to the main dir, then collect/score/rebuild handle the rest.
- Don't "fix" by adding the outlet to VERIFIED_DISCOVERY_SOURCES — that risks bad attribution across 13+ multi-critic feeds (see [[rss-discovery-pending-strand]]).
- Full diagnosis with CI-log evidence: `data/audit/we-discovery-diagnosis.md`. Related: this session also shipped the cross-show URL guard (slugLooksLikeDifferentShow) + WhatsOnStage extractor.
