---
name: wrongShow stale-flag audit — findings + asymmetric gate fix
description: 4 wrongShow gate sites had asymmetric manual-clear handling pre-2026-04-26; only isIncludableForRebuild honored 5 manual-clear flags. Fixed via wrongShowCleared() helper.
type: feedback
originSessionId: 77d1dac2-6c88-449e-a108-e8b3ba8066b7
archived: true
---
**Discovered during the wrongShow stale-flag audit (Notion 34e637c5-416f-8121,
sibling to the isRoundupArticle audit shipped same day).**

## Asymmetric gates

There are 4 places in the codebase that read `wrongShow` to decide exclusion:
- `scripts/lib/review-guards.js`:`isIncludableForRebuild` — used by rebuild
- `scripts/lib/is-scoreable.js`:`isScoreable` — used by LLM scoring + flag-rescore
- `scripts/lib/review-text-scoreable.js`:`passesFlagFilters` — used by validate-data
  + check-review-count-drift
- `scripts/llm-scoring/is-scoreable.ts`:`isScoreable` — TS source for the JS mirror

Pre-2026-04-26, only `isIncludableForRebuild` honored the 5 manual-clear flags
(`wrongShowManualClear`, `wrongShowOverride`, `wrongProductionManualClear`,
`wrongProductionOverride`, `humanReviewedWrongProduction === false`). The other
three excluded the file unconditionally on `wrongShow === true`.

**Failure mode:** a human-cleared wrongShow file would pass rebuild but be
skipped by the LLM rescore — leaving the file with no current score, and no
path back into reviews.json (rebuild's hasValidScore gate fails for unscored
files). Manual clears were one-shot at best.

**Fix:** extracted `wrongShowCleared(data)` helper as the single source of
truth, wired into all 4 gate sites. Symmetric. The pattern matches the
isLikelyStaleRoundupFlag wiring from the sibling card.

## Stale-flag predicate

`isLikelyStaleWrongShow(data, show)` is intentionally conservative — measured
~75% precision on 20 strict-predicate candidates, dropping to ~33% if the
filters are loosened. The remaining FPs split into:
- Cross-production (different revival year, same play title)
- Wrong medium (film/TV/movie reviews under same title)
- Multi-show roundup URLs that include this show's title

The companion sweep script `scripts/clear-stale-wrong-show-flags.js` uses an
LLM second-opinion (Sonnet) per candidate, lifting end-to-end precision to
~95%+ before any disk write.

## Show context required

Unlike isLikelyStaleRoundupFlag, this predicate takes a **show object** as a
second argument because wrongShow is inherently about whether a file matches a
specific show. Without `show`, the predicate returns false (safe degrade).

The 4 gate sites were updated to accept an optional `show` second arg. Where
callers don't (yet) pipe show context — most LLM-scoring callers — the gate
falls back to old behavior (manual-clear only). This is intentional: at LLM
scoring time, we don't want to score a wrongShow file unless human-verified
or sweep-confirmed.

Show context IS piped through:
- `rebuild-all-reviews.js` (lines 1556, 1608) — via showById built at the top
  of the file
- `validate-data.js`:`validateUnscoredReviewTexts` — loads showById from data/shows.json
- `check-review-count-drift.js`:`countExpectedForShow` — same pattern

## When merging concurrent worktrees

This session and the suspectedMisattribution session (Notion 34e637c5-416f-81b8)
both edited the SAME functions in review-guards.js + review-text-scoreable.js
on 2026-04-26. Merge conflicts resolved manually:
- Concatenate the two new functions (isLikelyStaleWrongShow + wrongShowCleared
  THEN isLikelyStaleSuspectedMisattribution + getCriticRegistry +
  _resetCriticRegistryCache)
- Combine the import destructure into ONE require statement (don't keep both
  HEAD/MERGE forms)
- Combine the module.exports list (both sets of names)
- Combine the scoring-delta.js guardsIdentical clauses with `&&` (both
  predicates' toString comparisons)

## Sweep cleared 14 files (2026-04-26)

LLM-confirmed real reviews of THIS production:
- 2 T1: chess-1988/nytimes--elisabeth-vincentelli (NYT 1988, Frank Rich byline,
  file metadata mis-attributed but text genuine), hadestown-2019/variety--marilyn-stasio
- 12 T2/T3: a-christmas-carol-2019, all-my-sons-WE-2025, burlesque-WE-2026,
  cats-the-jellicle-ball-OB-2024, dracula-WE-2025, hadestown-WE-2024,
  heartbreak-hotel-OB-2026, lysistrata-jones-2011, moulin-rouge-WE-2021,
  oh-mary-2024, oh-mary-WE-2025, one-flew-over-the-cuckoos-nest-WE-2026

Sonnet correctly rejected 7 predicate matches (kept their wrongShow flag):
archduke (different production same year), broken-glass (Young Vic ≠ OB),
come-from-away (Apple TV film!), death-of-a-salesman (multi-show LA roundup),
hamilton-WE-2021 (review primarily about The Grinning Man), the-little-foxes-2017
(cookie boilerplate, Young Vic), titus-andronicus (NYT Hamlet+Titus multi-show).

These FP categories are the next iteration's tightening targets if recall
matters more later.

## Sweep gotcha: LLM verifies show match, NOT critic byline

The Sonnet second-opinion prompt asks "is this fullText a real review of {showTitle} ({openingDate})?". It does NOT ask "does the criticName field match the byline in the fullText?". 2 of 14 files cleared in this sweep had byline/criticName mismatches that ship-check caught:

- `chess-1988/nytimes--elisabeth-vincentelli.json` — 1988 NYT review (Frank Rich era), Vincentelli's NYT tenure started ~2017.
- `hadestown-west-end-2024/telegraph--paul-raven.json` — fullText explicitly says "Dominic Cavendish, Chief Theatre Critic", criticName field is Paul Raven.

The cleared `wrongShow=false` was correct (the SHOW match IS valid) but the SCORE would attach to the wrong critic profile. Fix shipped 2026-04-26 in `~/broadway-review-texts` commit (post-c071fc7b39d): set `wrongAttribution=true` with explanatory `wrongAttributionReason`. wrongAttribution is excluded by all 4 gate sites — preserves correct exclusion until criticName is corrected.

**For future sweeps:** add a byline-alignment check to the LLM prompt OR a publish-date-vs-critic-tenure check using critic-registry data. Tracked in Notion 34e637c5-416f-8121.

## Boomerang vector (defense-in-depth, NOT urgent for this sweep)

`scripts/rebuild-all-reviews.js:1277-1287` re-promotes `wrongShow=true` whenever `cv.wrongArticle === true && !ensembleSaysReview && d.wrongShow !== true`. The sweep clears `wrongShow=false` but doesn't touch `contentVerification`. Files cleared by the sweep WITHOUT a high-confidence ensemble llmScore would be re-flagged on next rebuild.

For the 2026-04-26 sweep, all 14 cleared files had `hasHighConfidenceLlmScore=true`, so the `!ensembleSaysReview` gate suppresses re-promotion. Boomerang doesn't fire.

For future sweeps that might clear non-ensemble-scored files, the sweep must either:
1. Set a `contentVerificationOverride: true` flag, or clear `cv.wrongArticle`, or
2. The rebuild's CV-promotion gate must check `wrongShowClearedNote` and skip if present.

See: scripts/lib/review-guards.js `isLikelyStaleWrongShow` + `wrongShowCleared`,
scripts/clear-stale-wrong-show-flags.js, tests/unit/is-likely-stale-wrong-show.test.mjs,
Notion 34e637c5-416f-8121.
