---
name: Investigate the premise before running a scale backfill
description: Before running a backfill on N files, run a focused 5-20 file probe first to verify the underlying assumption holds. Parent cards' "X files need Y" can be wrong by orders of magnitude.
type: feedback
originSessionId: da56c300-b775-46c0-8002-605c96f23b84
---
The 2026-04-24 NY Post backfill card claimed 308 files needed star-widget recovery via HTML extraction. A focused probe found:

- 308 (card's raw count) → 226 (after `isScoreable()` pre-filter) → 19 (after filtering to post-widget era) → **1 actual recovery** (a 2026 URL; all 19 "post-2019" candidates turned out to be 2019-only which predates the widget).
- 225/226 eligible files already had llmScore populated — **the parent card's premise was dissolved by a 5-minute sampling audit**.

**Why this matters:** I almost ran `recover-explicit-ratings.js --outlet=nypost` on all 226, which would have burned ~30+ minutes and hundreds of ScrapingBee/BrightData credits on URLs that can't produce a score. The probe saved both.

## Rule
Before committing to a scale backfill/rescore/recovery, run a probe first. Minimum:
1. Pull 5-20 random candidates from the target set.
2. Run the recovery logic against them manually or with `--limit=N`.
3. Eyeball the recovery rate. If <20%, stop and investigate the premise.
4. Only proceed to full scale when the probe confirms the approach works.

**Why:** Parent cards are written from a snapshot in time. Outlet HTML changes. Pipeline filters change. Schema evolves. The premise in a card written 2 days ago may already be stale. Data auditing is cheap; wasted scale runs aren't.

## How to apply
- `--dry-run` flags let you measure recovery rate without writes.
- But be careful: `--dry-run` in recover-explicit-ratings.js still makes HTTP calls in Phase 3. For a true zero-cost probe, look at representative data locally first (e.g., check URL date distribution, sample fullText for markup presence).
- When the probe invalidates the premise, update the parent card's outcome with the finding. Don't silently close — the next person sees the invalidation.
