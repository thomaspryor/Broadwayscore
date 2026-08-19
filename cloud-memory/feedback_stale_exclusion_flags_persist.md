---
name: feedback_stale_exclusion_flags_persist
description: Card #1610 final decision table for all 10 exclusion flags — which have bulk-override sweeps, which are intentionally out of scope, and the scheduling gap that let wrongProduction/suspectedMisattribution drift back after their one-time April sweeps
metadata:
  node_type: memory
  type: feedback
  originSessionId: e8a4a576-0995-4ca5-b9a6-6cdb155935e6
---

Card #1610 ("Audit other exclusion flags for stale-data drift") closes out the
multi-flag stale-flag audit series (Notion 34e637c5-416f-814c). Final decision
per flag, 2026-08-19:

| Flag | Decision | Mechanism |
|---|---|---|
| `isRoundupArticle` | Bulk-override (done, prior session) | `isLikelyStaleRoundupFlag` in gate, `clear-stale-roundup-flags.js` |
| `wrongShow` | Bulk-override (done, prior session) | `isLikelyStaleWrongShow` called directly in `explainExclusion` — continuous, not a one-time sweep |
| `wrongProduction` | Bulk-override, LLM-gated | `isLikelyStaleWrongProduction` + Sonnet high-confidence second opinion, `clear-stale-wrong-production-flags.js`. See [[feedback_stale_wrong_production_audit_2026-04-26]] |
| `suspectedMisattribution` | Bulk-override, registry-gated | `isLikelyStaleSuspectedMisattribution` (deterministic, critic-registry knownOutlets), `clear-stale-suspected-misattribution-flags.js`. See [[feedback_stale_misattribution_audit_2026-04-26]] |
| `wrongAttribution` | Out of scope — no stale cohort | Re-verified 2026-08-19 against the current 325-file corpus: every flagged file traces to a documented reason (`wrongAttributionReason`, `wrongAttributionNote`, `_authorMismatch`, or `_c2FixReason` critic-collision correction) or co-occurs with an independent `wrongProduction`/`wrongShow`/`duplicateOf` exclusion. Zero files are excluded solely by an unexplained `wrongAttribution`. See [[feedback_wrong_attribution_not_stale]] |
| `isNonReview` | Out of scope — read-time self-heal, not bulk | `isNonReviewDemotedByFreshCV()` (task #1255) re-evaluates against the newest `contentVerification` pass on every rebuild — no sweep needed since it's continuous. Spot-checked 5 of 527 "substantial fullText, not demoted" files 2026-08-19: all 5 were genuinely non-reviews (Wordle puzzle page scraped for show "1536", news roundups, pre-opening interviews/features) — confirms "long fullText = real review" (the heuristic that worked for wrongShow/wrongProduction) does NOT apply to isNonReview, since a long article can just as easily be a long non-review |
| `isNotReview` | Out of scope — trivially small | 5 files corpus-wide (was 4 in April) |
| `suspectedMisattribution` false path / `isSyndicatedDuplicate` | Out of scope — intentional dedup | Content is real, file is an intentional wire-syndication duplicate; sample-checked 2026-08-19 (about-entertainment/Ben Brantley syndication, etc.) |
| `crossOutletDuplicate` | Out of scope — intentional dedup | Same as above; sample-checked 2026-08-19 |
| `fullTextWrongAuthor` | Already handled | Rebuild deletes `fullText` in memory, falls back to excerpt scoring (`explainExclusion` line ~3118) |
| `showNotMentioned` | Already handled | Same excerpt-fallback pattern, plus rebuild auto-clear |

**The actual finding this session (the scheduling gap):** `clear-stale-wrong-production-flags.js` and `clear-stale-suspected-misattribution-flags.js` both existed from the April session but were each run EXACTLY ONCE, by hand, with no recurring workflow. Re-running them 2026-08-19 found real reaccumulated drift — 150 new wrongProduction predicate candidates (76 LLM-confirmed high-confidence) and 21 of 30 currently-flagged suspectedMisattribution files. A predicate + sweep script that isn't scheduled is not prevention, it's a one-time cleanup that silently expires. [[feedback_stale_wrongproduction_flag_never_recleared]] documents the same SET-without-CLEAR shape for a different mechanism (rebuild's own dated guard) — this is the sibling bug at the "we built the clear path but never run it" layer instead.

**Fix shipped 2026-08-19 (card #1610):**
- Both scripts now have a surge guard (`FIX_SURGE_THRESHOLD` + `--force-bulk`, mirroring `audit-duplicate-of-url-mismatch.js`) — neither had one before, meaning a registry regression or a bad LLM day could have mass-cleared hundreds of flags in one unattended run with no circuit breaker.
- Both scripts' hardcoded `[2026-04-26 cleared...]` breadcrumb dates were dynamic-dated (`new Date().toISOString()`) — the literal April date was being written into every future clear.
- `clear-stale-suspected-misattribution-flags.yml` — new weekly workflow, `--apply` (deterministic registry check, surge-guarded, low blast radius).
- `audit-stale-wrong-production.yml` — new weekly workflow, **report-only** (not `--apply`). A second-opinion review flagged that no other weekly-cadence workflow in this repo auto-applies unattended writes to the private corpus, and this flag's LLM-gated sweep has zero track record running in CI — so it reports the candidate + LLM-confirmed count for a human to review before it graduates to an auto-apply workflow. The one-time backlog found today (76 files) was cleared manually this session via an agent panel replicating the script's exact rubric (no `ANTHROPIC_API_KEY` available locally) rather than waiting for the CI-only `--llm` path.

**How to apply:** when a predicate+sweep script for a stale-flag class ships, it needs a SCHEDULE, not just existence — a one-time manual run is not prevention. Before marking a stale-flag card "done," check `.github/workflows/*.yml` for a matching cron; if there isn't one, the "fix" is a snapshot, not a fix. For any sweep that auto-applies to the private review-texts corpus unattended, add a surge guard before scheduling it — see `FIX_SURGE_THRESHOLD` pattern in `scripts/audit-duplicate-of-url-mismatch.js` and the two scripts above.

See also: [[feedback_wrong_show_stale_audit_findings]] (asymmetric gate sites), [[feedback_cross_flag_stale_audit_2026-04-26]] (original 6-flag probe this card followed up on).
