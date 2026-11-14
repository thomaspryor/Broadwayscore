---
name: wrongAttribution flag has no stale-drift cohort
description: Audit of all 273 wrongAttribution=true files (2026-04-26): the parent stale-flag pattern from isRoundupArticle does NOT generalize. The flag mostly suppresses real fullText duplicates and is doing its job. No sweep / no gate-side override needed.
type: feedback
originSessionId: e4d59407-536a-4598-aee1-8bbcf8fea358
archived: true
---
**Rule:** Do not apply the `isRoundupArticle` stale-sweep pattern to `wrongAttribution`. Audit each exclusion flag separately before assuming drift.

**Why:** The parent card (Notion `34e637c5-416f-814c`) framed the work as "each flag has different semantics, audit each." The session-3 prompt assumed wrongAttribution would have a stale cohort similar to isRoundupArticle. It does not. Full audit on 2026-04-26:

- 273 total `wrongAttribution=true` files
- 88 have explicit `wrongAttributionReason` (Levenshtein typo or manual misattribution sweep) → correct, keep
- 13 have no reason and no `_c2FixReason` → typo-fixer pre-reason era, keep
- 172 from one-off "Class C2 audit" (commit `a32afa29a22`, 2026-04-12) with `_c2FixReason` + `_c2CorrectFile` audit-trail metadata
  - 47 used strong signals (`name-in-byline`, `typo-variant`, `name-in-url`, `unknown-vs-named`) → keep
  - 125 used the weakest signal (`review-count-N-vs-N` tiebreaker)
- **All 125 `review-count` cases have identical or near-identical fullText with their `_c2CorrectFile` sibling.** They ARE real duplicates. Whichever critic actually wrote it, only one copy should be scored. Clearing `wrongAttribution` would create double-counting.

**How to apply:**
- Do not run a sweep on `wrongAttribution` flags. The flag is functionally correct.
- The pattern that worked for `isRoundupArticle` (whitelist-based gate-side override) does not apply because there is no analogous "obvious individual review hidden behind a stale flag" cohort.
- Before assuming any other exclusion-flag has stale drift, run the same audit: distribution of reasons, audit-trail metadata, and **fullText fingerprint comparison with the supposed-canonical sibling.** If the flagged file is a real duplicate of something already being scored, the flag is fine.

**Adjacent finding worth a separate audit (NOT this flag's problem):**
20 of the 125 `review-count` C2 files have a sibling that is ALSO blocked (mostly `wrongProduction + contentTier=invalid`). The show loses both copies of a possibly-legitimate review. But the load-bearing flag here is `wrongProduction`, not `wrongAttribution` — clearing wrongAttribution alone wouldn't help. That's a different audit (recover-from-dual-block).

See: parent Notion `34e637c5-416f-814c`, this session's card `34e637c5-416f-81eb-a6f5-e788a34574b2`, prior shipped fix `34e637c5-416f-817b` (isRoundupArticle).
