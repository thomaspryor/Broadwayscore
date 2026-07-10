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

**Alerting:** named-missing-outlet emails via `discord-notify.js sendAlert
email:true` (Resend). NOTE: Discord is dead code — sendAlert without `email:true`
is LOG-ONLY; that silent path is why months of completeness alerts reached nobody.
Alerts dedup on missing-SET change + 24h re-ping; prior-run-only sets alert once;
failed delivery doesn't record the dedup hash (retries next run + ::error::).

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

**Rollout state (as of 2026-07-10):** report-only. Enable auto-ingest ONLY after
the report matches manual audits across ≥2 real WE openings: set repo var
WE_GAP_INGEST=1 (`gh variable set WE_GAP_INGEST --body 1`).

**Gotchas:**
- The Broadway-path SERP finds same-title PRIOR-PRODUCTION Broadway roundups for
  WE revivals (TKAM: 77 "missing" 2018 US URLs) — the WE alert is scoped to
  WE-reference-derived gaps only; the Broadway-path noise stays in the audit JSON.
- Checkpoint entries carry refVersion (WE_REF_VERSION) — bump it to force a
  one-time WE re-audit (used to invalidate 59 poisoned gaps:0 entries).
- The Stage + Stagedoor are NOT v1 reference sources (cookie/Browserbase-gated,
  archives private) — reference is WET/TR/LBO only.
- Backtest 2026-07-10: TKAM reference named exactly the 6 broadsheets the manual
  audit found (prior-run, report-only); Sting/Springwood zeros = true negatives.
Related: [[feedback_stale_flag_collision_drops_current_production.md]],
[[feedback_returning_production_priorRuns.md]], [[feedback_pending_no_byline_strand_drain.md]].
