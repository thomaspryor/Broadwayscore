---
name: New auto-clear path requires setter-side audit
description: When you ship a new "auto-clear" decision function for a wrongProduction-class flag, every existing setter that writes that flag must be reviewed for whether it should consult the new override. Otherwise the auto-clear runs, the next ingest re-flags, and the override is silently defeated.
type: feedback
originSessionId: 0d2c244d-e499-401b-a290-07d5aba8a7ac
archived: true
---
Card 3 Phase 1 (production-continuity priorRuns) shipped 2026-04-29 with isWithinPriorRun + shouldAutoClearWrongProductionPriorRun helpers wired into 4 sites in rebuild-all-reviews.js. /ship-check on 2026-04-30 found 3 setters that re-flagged the cleared files within minutes:

1. **collect-review-texts.js anticipatory ingest gate** wrote `wrongProductionReason='anticipatory_pre_opening_post'` (which the autoclear treated as a manual reason and refused to override) on every ingest cycle. Permanent re-flag loop until the gate itself learns to skip on priorRuns.

2. **flag-wrong-production-by-url-date.js** standalone setter with no priorRuns check — would re-flag cleared files on every workflow run.

3. **rebuild-all-reviews.js CV-promotion paths (3 sites: pre-pass, upcoming pre-pass, main loop)** — when CV.wrongProduction:high reasoning was specifically temporal/venue-based ("review describes Bushwick Starr, not Playwrights Horizons"), the CV promotion stamped wrongProductionReason="CV-promoted: ..." right after the autoclear cleared the file. CV is correct in its frame; priorRuns is the operator's explicit override of that frame.

**Why:** Reason: rebuild ordering. The autoclear pass runs early; many setters (CV-promotion, anticipatory gate, URL-date) run later in the same rebuild OR on a separate workflow. Each setter has its own gate logic and doesn't naturally consult the new override field.

**How to apply:** Before merging any new wrongProduction-class auto-clear:
- grep `wrongProduction\s*=\s*true` and `wrongProductionReason\s*=` across scripts/
- For each setter, ask: "if the operator declares <override> covers this case, should this setter still fire?" If no, add the override check at the setter site.
- If the setter writes `wrongProductionReason` (not just Note), also extend the autoclear's allowlist to recognize the reason as auto-set, OR add an explicit-strip rule when the override condition is met. Otherwise hasManualReason=true blocks autoclear forever.
- Pair the new override with a stat counter (e.g. `cvWrongProductionPriorRunSuppressed`) so future rebuilds visibly report when the override is doing work.

Related: scripts/lib/wrong-production-autoclear.js (helpers). 2026-04-30 fix commit d2454be5. Existing memory feedback_stale_wrong_production_audit_2026-04-26.md covers the parallel "manual-clear" version of this asymmetry.
