---
name: OUTLET_STAR_AUTHORITATIVE vs KNOWN_STAR_OUTLETS
description: Two separate outlet sets in score-extractors.js — know which one to edit when you want to "trust an outlet's stars more." Adding to the wrong one causes stray-★ false positives.
type: feedback
originSessionId: 73e262b9-4a4d-4375-adff-c7a1d87c5395
archived: true
---
When a session wants to make an outlet's published star rating "authoritative" (so LLM / adjudication don't overwrite it), there are TWO sets in `scripts/lib/score-extractors.js` and they have different semantics. Pick the wrong one and you ship a regression.

**KNOWN_STAR_OUTLETS** controls FOUR behaviors in `rebuild-helpers.js`:
  1. P0.75 inline recovery — runs `extractScore()` on `fullText` to find stray "N stars" / ★★★ patterns.
  2. Aggregator relay — treats `aggregatorStars` as the outlet's own rating when originalScore is absent.
  3. Tier 1.5 override — recovers cleared originalScore for known star outlets.
  4. (Historically) gated adjudication-skip + LLM-override — now delegated to OUTLET_STAR_AUTHORITATIVE.

**OUTLET_STAR_AUTHORITATIVE = KNOWN_STAR_OUTLETS ∪ {nypost, ny-post, new-york-post}** controls TWO behaviors only:
  1. P0a adjudication-skip — adjudicatedScore cannot overwrite verified outlet stars.
  2. P0.5 LLM-override gate — high-conf LLM cannot overwrite verified outlet stars even when scoreSource is `css-stars` (LOW_RELIABILITY).

**Why:** Adding NY Post to KNOWN_STAR_OUTLETS directly would enable P0.75 inline recovery. NY Post articles reliably contain stray ★★★ from unrelated content (album blurbs, "Albums of the Week" sidebars embedded in the article body, footer trademark blocks). The Once-2012 Elisabeth-Vincentelli review scored 60 via inline-recovery on a Bowie album's 3-star rating when the actual NY Post star widget was empty — LLM 85 would have been correct. Keep NY Post out of KNOWN_STAR_OUTLETS; keep it in OUTLET_STAR_AUTHORITATIVE.

**How to apply:**
  - Goal = "this outlet's dedicated star-widget extractor should not be overridden by LLM / adjudicator" → add to OUTLET_STAR_AUTHORITATIVE.
  - Goal = "this outlet publishes star ratings inline in article body and we want to recover them when the extractor missed" → add to KNOWN_STAR_OUTLETS (but only if fullText doesn't contain adjacent unrelated star ratings).
  - When in doubt, grep the outlet's fullText corpus for ★, "N stars", "N/5" and see what appears outside the verdict before opting into KNOWN_STAR_OUTLETS.

Commit: `f6cb1e3266` (fix(scoring): NY Post stars authoritative over LLM override + adjudication), merged to main 2026-04-22.

Notion card: `348637c5416f81a9a780ec3259a307c1` — P1: NY Post stars not auto-converted to humanReviewScore at ingest.
