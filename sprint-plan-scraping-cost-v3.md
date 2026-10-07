# Sprint Plan: Scraping Cost v3 — double-hop fix, SB gate, BD circuit breaker

Notion card: 3b1637c5-416f-81ef-881f-f3cd699b6388 ("Scraping cost v3"). Owner approved the reviewed plan (Option A) 2026-08-03 after a 6-reviewer /plan-review; this file decomposes that plan verbatim — do not re-litigate design decisions here (see card for the review findings baked in).

## Overview
Cut Bright Data from ~$13/day toward ~$5–7/day now (step-down later) by (1) fixing the didtheylikeit/theatre.reviews pay-twice bug, (2) skipping ScrapingBee while exhausted, (3) adding a billing-API-driven daily circuit breaker for bulk Bright Data use with opening-night flows exempt. Opening-night review-discovery latency must NOT regress.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 1 | Active waste stopped (double-hop + SB attempts) | 7 | 4S, 3M |
| 2 | BD daily enforcement live (breaker + budgets + carve-out) | 9 | 3S, 6M |
| 3 | Ledger coverage + billing-level acceptance | 3 | 1S, 2M |

## Sprint 1: Stop the active waste (plan T0+T1+T2)
**Demo:** Parity-test evidence file committed; domain-tier-skip.json flipped; next-day BD unlocker requests on the two hosts ≈ SD-attempt count drops to 0; SB attempt count 0 while exhausted.
**Risks:** Parity test could contradict production ledger rates (then keep SD with fixed params instead of skip); another session edits domain-tier-skip.json concurrently (T0 recon + post-push verify covers this).
**MODEL:** Sonnet — config + small wiring with clear specs, except S1-T2 judgment call.

### Task S1-T1: Run live SD parity test for didtheylikeit.com + theatre.reviews
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** reuse scripts/scrapingdog-bakeoff.js (exists from June) or a thin runner; output data/audit/sd-parity-2026-08.json (new)
- **Description:** ≥30 URLs/host sampled from real review-texts/ledger URLs, fetched with the poller's actual fetch shape (fetchPage via SD, current params, and once with stealth_mode/dynamic variants). Records per-host success rate. Budget ~$0.30.
- **Acceptance criteria:**
  - VERIFY: output JSON exists with ≥30 attempts/host and a successRate field per host per param-variant
  - VERIFY: EXECUTED line shows the runner command and per-host rates

### Task S1-T2: Flip domain-tier-skip.json per the decision bar
- **Complexity:** S
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** scripts/config/domain-tier-skip.json
- **Description:** Bar from approved plan: <30% SD success → skip:true (evidence + date in reason string); ≥80% with a param fix → keep SD, fix params in scraper.js instead; 30–80% → stop and surface to owner. Before editing: re-check worktrees for in-flight edits to this file (T0). After push: re-read file on origin/main and assert the entries match.
- **Acceptance criteria:**
  - VERIFY: node -e "..." asserts the two hosts' scrapingdog.skip values on origin/main match the parity decision
  - VERIFY: git log origin/main -1 --stat shows only domain-tier-skip.json changed

### Task S1-T3: Bidirectional tier-skip drift check script
- **Complexity:** M
- **Depends on:** None (parallel with S1-T1)
- **Parallel:** Yes
- **Files:** scripts/audit-tier-skip-drift.js (new), scripts/lib/ unit test (new)
- **Description:** Compares domain-tier-skip.json against live ledger success rates: alert when a skip:false host is <30% over ≥100 calls/7d (degrade direction) and monthly 5-URL probe of skip:true hosts (recovery direction). Pure decision fn + thin I/O caller, mirroring browserbase-caps.js shape. Routes via owner-alert-router.
- **Acceptance criteria:**
  - VERIFY: node --test passes for the decision fn (degrade, recovery, insufficient-sample cases)
  - VERIFY: node scripts/audit-tier-skip-drift.js --dry-run runs against the real ledger and prints per-host verdicts

### Task S1-T4: Wire drift check into weekly audit workflow
- **Complexity:** S
- **Depends on:** S1-T3
- **Parallel:** No
- **Files:** one existing weekly audit workflow YAML (extend, do not create new cron)
- **Description:** Piggyback the weekly cadence; commit no state unless alerting.
- **Acceptance criteria:**
  - VERIFY: gh workflow run <wf> completes green with the new step visible in logs

### Task S1-T5: SB exhaustion process latch in scraper.js
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/scraper.js
- **Description:** Reuse the EXISTING SB usage check (scraper.js:189 semantics: ≤0 or <5% remaining → skip) as a fire-and-forget once-per-process latch at first SB call, mirroring _checkScrapingdogQuotaOnce(). Keep the reactive 401/403/429 latch as backstop. No new parallel quota design.
- **Acceptance criteria:**
  - VERIFY: unit test — mocked usage 0 → SB tier skipped for all subsequent calls in-process
  - VERIFY: live run with real exhausted SB shows "skipping SB" once and zero SB HTTP attempts after latch

### Task S1-T6: Gate url-discovery.js SB SERP path with the same latch
- **Complexity:** S
- **Depends on:** S1-T5
- **Parallel:** No
- **Files:** scripts/lib/url-discovery.js
- **Description:** The SERP chain has its own SB path; consult the shared latch so exhausted SB is skipped there too.
- **Acceptance criteria:**
  - VERIFY: unit test — latch set → serpChainOrder result excludes scrapingbee

### Task S1-T7: Sprint-1 verification sweep
- **Complexity:** M
- **Depends on:** S1-T2, S1-T4, S1-T6
- **Parallel:** No
- **Files:** none (verification)
- **Description:** Full test suite + lint; then next-UTC-day ledger query: SD attempts on the two hosts = 0 (if skipped), SB attempts = 0. Stamp card with RECHECK-AFTER for the 3-billed-day billing acceptance (plan T5).
- **Acceptance criteria:**
  - VERIFY: npm test green; ledger query output pasted as evidence
  - VERIFY: Notion card stamped RECHECK-AFTER: <date+3d> with safe-form acceptance command

## Sprint 2: BD daily enforcement (plan T3)
**Demo:** Forced-low-ceiling test day: bulk BD calls stop at the breaker, poller path still fetches, budget_capped rows recorded and NOT permanently skipped, opening-night-aware alert fires.
**Risks:** Breaker state file committed from an hourly workflow could push-conflict (use existing push-with-retry; state file is single-writer by design); _scriptName() allowlist misclassifying a flow (start allowlist minimal: opening-night-poller.js, orchestrator dispatch scripts).
**MODEL:** Opus — concurrency-sensitive; two chokepoints; degradation semantics.

### Task S2-T1: brightdata-caps lib (pure decision fns)
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/brightdata-caps.js (new), scripts/lib/brightdata-caps.test.mjs (new)
- **Description:** Pure fns: shouldTripBreaker(billedReqs, ceiling), isExemptCaller(scriptName, allowlist), checkPerRunBudget(used, budget). One constant per zone ceiling (bulk 3,500/day/zone), env-overridable, garbage-safe — mirror browserbase-caps.js exactly (its header documents why: one constant, one edit site).
- **Acceptance criteria:**
  - VERIFY: node --test brightdata-caps.test.mjs green, no mocks needed

### Task S2-T2: Hourly breaker check (billing API → state file)
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** No
- **Files:** scripts/check-bd-breaker.js (new); extend an existing hourly scheduled workflow (no new cron)
- **Description:** Queries BD zone/cost for today (both zones, 1 call each — verified working intraday). Over ceiling → writes+commits data/audit/bd-circuit-breaker.json {zone, day, trippedAt, billedReqs}. Under → clears stale same-day entry. Alert on state change: severity=critical if any show in an active opening window (cross-ref the opening-night calendar the orchestrator uses), else warn; names zone + top ledger scripts.
- **Acceptance criteria:**
  - VERIFY: run locally with BD_BREAKER_CEILING=1 → state file written, alert routed (dry-run mode), rerun with real ceiling → state cleared
  - VERIFY: workflow run green with the step in logs

### Task S2-T3: Enforce inside fetchWithBrightData()
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** Yes (different file than S2-T2)
- **Files:** scripts/lib/scraper.js
- **Description:** At the single BD helper (scraper.js:308): consult breaker file (mtime-cached ≤60s) + per-run BD_REQ_BUDGET counter + exemption allowlist. On block: return null (falls through like existing tier skips), record telemetry row with purpose 'budget_capped'. NOT at the outer fetchPage/fetchJSON gates — chokepoint placement is a review-mandated decision.
- **Acceptance criteria:**
  - VERIFY: integration test — breaker present + non-exempt caller → BD tier skipped, no throw, chain continues
  - VERIFY: exempt caller (opening-night-poller.js) fetches normally with breaker present

### Task S2-T4: Enforce inside _serpViaBrightData()
- **Complexity:** S
- **Depends on:** S2-T3 (reuses the same consult helper)
- **Parallel:** No
- **Files:** scripts/lib/url-discovery.js
- **Description:** Same consult at the single BD SERP dispatcher (url-discovery.js:466), covering both serp-api and serp-unlocker paths.
- **Acceptance criteria:**
  - VERIFY: unit test — breaker tripped for serp zone → chain skips BD, SD-empty still honored per emptyAuthoritative

### Task S2-T5: budget_capped exclusion — write path
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/collect-review-texts.js (recordFailedFetch, ~line 5991/6052)
- **Description:** recordFailedFetch must NOT increment failureCount when reason is budget_capped (store lastCapped timestamp instead). Review-mandated: exclusion at write time, else 4 capped + 1 transient still permanently retires a URL.
- **Acceptance criteria:**
  - VERIFY: unit test — 4x budget_capped + 1x transient → failureCount === 1

### Task S2-T6: budget_capped exclusion — read path
- **Complexity:** S
- **Depends on:** S2-T5
- **Parallel:** No
- **Files:** scripts/collect-review-texts.js (permanent-skip loop ~line 5501–5528)
- **Description:** Belt-and-braces: read-path threshold logic also ignores budget_capped (the threshold logic is duplicated — both copies must agree).
- **Acceptance criteria:**
  - VERIFY: unit test — ledger entry with 10 budget_capped failures → NOT in permanentlyFailed set

### Task S2-T7: Extend opening-night-budget.js with brightdata resource
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** Yes
- **Files:** scripts/lib/opening-night-budget.js, its test
- **Description:** Add brightdata to DEFAULT_PER_SHOW + DEFAULT_CAPS (per-show ~250 reqs from observed poller data; opening-night daily allowance 3,000). Pre-flight blocks a shift only on projected exhaustion, same semantics as existing resources. This is the poller's independent allowance — bulk flows never draw from it.
- **Acceptance criteria:**
  - VERIFY: node --test opening-night-budget tests green including new resource
  - VERIFY: node scripts/opening-night-budget-preflight.js --shows=<one real show> passes with brightdata line in output

### Task S2-T8: Forced-low-breaker end-to-end test
- **Complexity:** M
- **Depends on:** S2-T2, S2-T3, S2-T4, S2-T6, S2-T7
- **Parallel:** No
- **Files:** none (verification)
- **Description:** With BD_BREAKER_CEILING=1: (a) bulk script (collect-review-texts single URL) → skipped with budget_capped, not permanently skipped; (b) poller dry-run → still fetches; (c) alert fires once with correct severity. Then clear state.
- **Acceptance criteria:**
  - VERIFY: EXECUTED lines for all three runs with output proving each behavior
  - VERIFY: breaker state file cleared afterward (git status clean)

### Task S2-T9: Sprint-2 wrap — tests, lint, card stamp
- **Complexity:** S
- **Depends on:** S2-T8
- **Parallel:** No
- **Files:** none
- **Description:** Full suite + lint; stamp card RECHECK-AFTER for "breaker never trips on a normal day" (7 days) before any ceiling step-down.
- **Acceptance criteria:**
  - VERIFY: npm test green; card stamped

## Sprint 3: Ledger coverage + acceptance (plan T4+T5)
**Demo:** brightdata attributedPct ≥ 0.8 in provider-spend-daily.jsonl.
**Risks:** merge-scraper-spend-ledger.js finding could be a deeper git-flow bug (timebox; escalate as own card if >1 session).
**MODEL:** Sonnet, with the S3-T1 finding reviewed before fixing.

### Task S3-T1: Verify + fix worktree ledger merge path
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/merge-scraper-spend-ledger.js and/or worktree merge tooling
- **Description:** Front-loaded (review finding): prove whether local worktree sessions' ledger rows reach main (PUSH_RECONCILE_MERGED_JSON=1 opt-in per merge-scraper-spend-ledger.js:14 — check who sets it). This is the prime suspect for the 99%-dark SERP zone. Fix the enrollment gap.
- **Acceptance criteria:**
  - VERIFY: a test row appended in a scratch worktree survives merge to main
- **Depends on:** None

### Task S3-T2: Enroll non-committing workflows
- **Complexity:** M
- **Depends on:** S3-T1
- **Parallel:** No
- **Files:** workflow YAMLs for url-discovery consumers (review-refresh.yml/gather-reviews.yml first — the daily 153-show refresh is the top suspect)
- **Description:** Apply the same pattern used for the 4 already-fixed workflows (commit data/audit/ after run).
- **Acceptance criteria:**
  - VERIFY: next scheduled run of each fixed workflow lands ledger rows on main (git log data/audit/scraper-spend-ledger.jsonl shows the workflow's commit)

### Task S3-T3: Acceptance wiring
- **Complexity:** S
- **Depends on:** S3-T2
- **Parallel:** No
- **Files:** Notion card, autonomous-acceptance-recheck config
- **Description:** attributedPct ≥ 0.8 ×2 days check + BD <$7/day ×3 billed days check wired as safe-form acceptance commands; card Paused with RECHECK-AFTER. Step-down of ceilings is a NEW card gated on these passing.
- **Acceptance criteria:**
  - VERIFY: recheck commands run green in shadow mode against current data (expected: pending, not error)

---

## Dependencies Graph
S1-T1 → S1-T2 → S1-T7; S1-T3 → S1-T4 → S1-T7; S1-T5 → S1-T6 → S1-T7
S2-T1 → {S2-T2, S2-T3 → S2-T4, S2-T7}; S2-T5 → S2-T6; {S2-T2,T4,T6,T7} → S2-T8 → S2-T9
S3-T1 → S3-T2 → S3-T3

## Subagent Execution Map (within one /execute-plan session — do NOT split across Claude sessions)
Sprint 1 session:
  Subagent track 1: S1-T1 → S1-T2
  Subagent track 2: S1-T3 → S1-T4
  Subagent track 3: S1-T5 → S1-T6
  Sync: ── coordinator runs S1-T7 ──
Sprint 2 session:
  Subagent track 1: S2-T1 → S2-T2
  Subagent track 2: (after S2-T1) S2-T3 → S2-T4
  Subagent track 3: S2-T5 → S2-T6
  Subagent track 4: (after S2-T1) S2-T7
  Sync: ── coordinator runs S2-T8 → S2-T9 ──
  NOTE: tracks 1–2 both touch scraper.js? No — S2-T2 is a new script + workflow; only S2-T3 edits scraper.js and S1-T5 already landed. No same-file overlap between tracks.
Sprint 3 session: sequential (S3-T1 → S3-T2 → S3-T3).

**Critical path:** 3 sessions (one sprint each, ship to main between).
**Max subagent parallelism:** 4 (Sprint 2 after S2-T1 lands).
**Cross-session plan:** Session A = Sprint 1; Session B = Sprint 2; Session C = Sprint 3. Each ships to main before the next starts.

## Known Edge Cases
- domain-tier-skip.json has an uncommitted unrelated edit in worktree fix-prediction-ledger (BWW playwright entry deletion) — re-run the T0 worktree scan immediately before S1-T2.
- BD SERP async flow (submit + poll) — breaker counts BILLED reqs from the billing API only; never count polls.
- Local runs have GITHUB_WORKFLOW unset — exemption uses _scriptName() basename, never workflow env.
- SB exhaustion is recurring (2 months running) — S1-T5's latch must be state-driven, not date-hard-coded.
- Breaker state file is committed: hourly workflow is its single writer; local runs only READ it.

## Changes from Critique
(Design-level changes already applied via the 6-reviewer /plan-review — see Notion card. This decomposition adds none.)

## Key Risks
1. Parity test contradicts production rates → decision bar handles it (30/80 thresholds, owner escalation in between).
2. Breaker misclassification starves the poller → exemption tested explicitly in S2-T8(b) before any real ceiling applies.
3. S3-T1 rabbit hole → timeboxed; escalate as own card.
