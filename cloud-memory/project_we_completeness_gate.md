---
name: project_we_completeness_gate
description: "The WE review-completeness gate — hourly audit now diffs WE shows against WET/theatre.reviews/LBO roundup citations, emails named missing outlets; ingest default-OFF via WE_GAP_INGEST repo var"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5069eb8a-8362-42e1-8109-2bc515299bd5
---

**The WE completeness gate shipped 2026-07-10** (main 5b7f95f761; Notion 399637c5).
It ends the "session claims confidence → next opening lands 5-8 of 18-30 reviews →
nobody alerted" cycle by MEASURING completeness instead of trusting fixes.

**What it is:** `audit-show-review-gap.js` (hourly via audit-aggregator-gap.yml)
previously diffed coverage against Playbill Verdict + BWW RR — Broadway-only, so
"no gaps" for WE shows was vacuous. Now, for WE/OWE shows within 21d of opening,
it also diffs against the union of outlets cited by WestEndTheatre / theatre.reviews
/ LBO roundups (`scripts/lib/gap-reference-sources.js`, composing the
`lib/{wet,tr,lbo}-roundup-discover.js` libs extracted from the poller — shared
discovery, no divergent copies). Coverage matching is dual: URL-host when the
citation has a URL, canonical outletId otherwise (WET tables cite outlet+stars
with NO link — hyphen-collapsed, -london/-uk-stripped key so display variants
match). Paywalled star-stubs and `_pending/` strand files count as covered.

**Alerting (reconciled with the 2026-07-11 actionable-only email policy):** the
per-opening WE review-gap alert is `severity:'warning'` → the policy
([[feedback_actionable_only_email_alerts.md]]) routes it to the BSC Daily digest
+ step summary, NOT email (owner named "WE review gaps" as noise to suppress).
That is intended — the gate's real payoff is the AUTO-RECOVERY, not per-gap
emails. Only the actionable auto-ENABLE state-change notice + the enable-failed /
manual-enable notices are `severity:'error'` so the policy delivers them
(a we-gate-proving test asserts this so they can't be silently downgraded).
`sendAlert` without `email:true` is LOG-ONLY; with a suppressed severity it
returns false but does NOT fire the ::error:: delivery-failed path (policy
suppression ≠ delivery failure). Gap dedup records on EMIT (not just delivery)
so an unchanged gap doesn't re-append to the digest hourly.

**Safety (all ship-check/plan-review hardened):**
- Ingest is DEFAULT-OFF: WE-reference URLs ingest only when repo var
  `WE_GAP_INGEST=1`. Absent/deleted env fails closed to report-only.
- Prior-run roundup URLs (post date outside [opening-30d, +90d]) NEVER ingest,
  even with the gate on — WET returns the prior production's roundup for
  returning shows (TKAM 2026 → 2022 Gielgud roundup).
- The flaggedMisses RECOVERY path respects the same gate (P0: an empty-body file
  + a prior-run URL would otherwise re-ingest 2022 text hourly).
- Health floors: found-roundup-but-0-parsed-rows and all-sources-failed emit
  ::error:: — a broken scraper ALARMS instead of reading as "no gaps".
- Kill switch: repo var `WE_GAP_REFERENCE_DISABLED=1` (WE-only; Broadway audit
  untouched). Safety wiring is unit-tested (tests/unit/we-gap-reference.test.mjs
  asserts the workflow env lines exist — deleting one fails CI, not silently).

**Rollout state:** report-only until the gate PROVES ITSELF — and that flip is
AUTOMATED (2026-07-11, `lib/we-gate-proving.js` + tracker
`data/audit/we-gate-proving.json`): when ≥2 NEW openings (post-2026-07-10) are
each audited ≥2× with a working reference (≥3 rows) and ZERO detector-failure
floors, the audit sets WE_GAP_INGEST=1 itself and emails the owner (kill switch
named); if the token can't write the variable it emails the one command. Fires
once. Nobody needs to remember anything — do NOT re-add a manual enable step.

**Hardening (2026-07-11, main 15546f8487):**
- Broadway-path production identity: SERP-found Playbill/BWW articles are now
  DATE-GATED (`lib/gap-ingest-policy.js` articleRunIdentity — publish date from
  HTML metadata vs [opening-30d,+90d]); prior-production URLs are priorRun and
  ingest-blocked on EVERY path/market via the single canonical predicate
  `ingestBlockReason()` (used by both missing-URL ingest AND flaggedMiss
  recovery). This closed the TKAM-2018 class for Broadway revivals AND for WE
  shows post-auto-enable. Dateless article → fails open + ::warning::.
- The Stage IS now a reference source — ARCHIVE-ONLY (`thestage-archive`,
  passive): reads data/aggregator-archive/thestage-roundups/{id}.html (written
  by gather/poller; audit workflow checks out the archive). Passive = absence
  never counts toward allSourcesFailed and its emptyParse/error is a ::warning::
  and NEVER a proving floor. TS scraper no longer archives 0-row (paywall-stub)
  pages. Stagedoor still excluded (needs Stagedoor ID).
- Per-aggregator accuracy: weReference.perSource {cited,corroborated} → proving
  tracker (fullest-and-latest per show, no hourly double-count) →
  `aggregatorAccuracy()`/`lowTrustSources()` (≥5 cited + <60% → source's rows
  report-only even with gate on; one trusted citing source is enough). "Cited"
  counts CHECKABLE citations only — still-missing URLs/outlets are un-gathered,
  not contradicted. Accuracy table prints every run.

**Gotchas:**
- Checkpoint entries carry refVersion (WE_REF_VERSION) — bump it to force a
  one-time WE re-audit (used to invalidate 59 poisoned gaps:0 entries).
- Backtest 2026-07-10: TKAM reference named exactly the 6 broadsheets the manual
  audit found (prior-run, report-only); Sting/Springwood zeros = true negatives.
- False-positive wrongProduction from misparsed publishDate suppresses real T1
  reviews (care-west-end-2026 Stage review stamped 2023-10-12, actually
  2026-05-20): verify against the live page date + Theatre Record year before
  trusting a wrong-production-by-date validation error; clear with the full
  manual-clear field set ([[feedback_manual_review_protection_fields.md]]).
Related: [[feedback_stale_flag_collision_drops_current_production.md]],
[[feedback_returning_production_priorRuns.md]], [[feedback_pending_no_byline_strand_drain.md]].
