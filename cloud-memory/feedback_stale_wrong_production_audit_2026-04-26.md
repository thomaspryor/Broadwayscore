---
name: Stale wrongProduction flag audit (Session 5) — setter-side asymmetry
description: Largest stale-flag cohort (15k flagged, 175 cleared 1.18%). Critical lesson: clearing flags on disk is undone by setter scripts that run on every CI cycle unless they ALL honor manual-clear. /ship-check caught 6 unguarded setters.
type: feedback
originSessionId: 41f483b6-e839-442a-bc57-5a8db3b12fc7
archived: true
---
Session 5 of multi-flag stale-flag audit (Notion 34e637c5-416f-811d, 2026-04-26).
Predecessors: isRoundupArticle (817b), wrongShow (8121), suspectedMisattribution (81b8),
wrongAttribution (no stale cohort).

**Scale:** 14,788 flagged → 218 high-suspicion (predicate) → 175 LLM-confirmed (high-conf only). 1.18% turn out stale — far smaller than wrongShow/roundup audits because most wrongProduction flags are CORRECT (tour reviews, regional tryouts, cross-Atlantic transfers, prior revivals).

**Predicate design (stricter than wrongShow):**
- URL + publishDate-in-show-range + URL-year-within-1-of-show-year are ALL MANDATORY (not OR)
- Reason: wrongProduction is fundamentally about "wrong production of same play" — URL-only matches without date support are dominated by other-production reviews
- Tour markers: `national-tour|tour-review|stratford-festival|kennedy-center` and city slugs reject before LLM
- Manual-sample precision after these gates: 87.5% (8/9 with URL year alignment)
- LLM second-opinion lifts to ~99% with `confidence === "high"` only

**P0 lesson (caught by /ship-check, not me):** Six setter scripts re-flag cleared files within 24h via the next CI cycle. The flag clears flow uses `wrongProductionManualClear=true` as breadcrumb, but these scripts checked only `if (data.wrongProduction) skip` — once cleared, they re-fire. Files affected: any in revival cluster (24% of clears were in clusters like a-christmas-carol, evita, macbeth, wicked).

Patched (added `shouldSkipWrongProductionAudit(data)` guard to):
- `scripts/audit-cross-show-url-collisions.js` (HIGHEST exposure — runs every collect-review-texts cycle)
- `scripts/audit-touring-contamination.js`
- `scripts/flag-we-cross-production.js`
- `scripts/flag-wrong-production-by-url-date.js`
- `scripts/cleanup-known-issues.js`
- `scripts/audit-pre2005-reviews.js`

**General lesson for ALL future stale-flag audits:** When clearing a flag on disk, audit BOTH:
1. Gate sites that READ the flag (need to honor manual-clear) — already in the playbook
2. Setter sites that WRITE the flag — need to skip files with manual-clear breadcrumbs

The setter audit is easier to skip because the gate sites are obvious (is-scoreable, passesFlagFilters, isIncludableForRebuild) but setters are scattered across audit-*, flag-*, classify-*, cleanup-* scripts. Grep for `data.{flag} = true` (or assignment patterns) to find them all.

**scoring-delta blind to data-only changes:** The `guardsIdentical` short-circuit at scoring-delta.js:404-412 returns "decisions identical — skipping inclusion replay" even when the on-disk wrongProduction flag flips affect inclusion. Workaround: probe-rebuild manually using `isIncludableForRebuild(data, show)` against the cleared file set to compute T1 flips. (Mentioned in `feedback_scoring_delta_blind_to_future_logic.md` as an existing gap.)

**passesFlagFilters vs isIncludableForRebuild asymmetry:**
- `isIncludableForRebuild` (review-guards.js:1543) honors manual-clear AND has special handling for `contentTier=invalid` + `incompleteReason=wrong_content` (lines 1616, 1633)
- `passesFlagFilters` (review-text-scoreable.js:49, 60) does NOT honor manual-clear for those secondary flags
- Result: real rebuild includes the file, but the silent-gap audit + drift-checker over-exclude. Future audit should mirror the special handling.

**Cost:** $1.31 (well under $10 cap). 218 LLM calls × ~$0.006 = $1.31.

**Final inclusion impact:** 158/175 cleared files (90%) flow into reviews.json on next rebuild. 17 still blocked by independent guards (duplicateOf, wrongAttribution) — correct behavior. Tier breakdown: T1=26, T2=109, T3=23. 22 shows with T1 outlet additions including Stereophonic 2024 (3 T1: Hollywood Reporter 95, New Yorker 80, Variety 92).
