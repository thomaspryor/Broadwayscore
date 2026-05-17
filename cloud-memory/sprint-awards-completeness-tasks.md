# Sprint Plan Tasks: Awards Data Completeness

**Source plan:** `cloud-memory/sprint-awards-completeness.md` (committed `c0e9973d6e`)
**Notion card:** 363637c5-416f-8109-9afe-d18e215942ca
**Target:** Autonomous /loop session executes sprints sequentially.
**Total:** ~60 atomic tasks across 14 sprints, 14-20h estimated.

## Sprint Summary

| Sprint | Goal | Tasks | Complexity | Model |
|---|---|---|---|---|
| 0 | Pre-flight + scaffolding | 9 | 6M, 3S | Opus (refactor + arch) |
| B | Pre-2005 Tony repair | 5 | 1M, 4S | Sonnet (run existing scraper) |
| A1 | DD sub-categories 1975-2022 | 4 | 3M, 1S | Sonnet |
| A2 | OCC sub-categories pre-2022 | 4 | 3M, 1S | Sonnet |
| A3 | DL sub-categories pre-2022 | 4 | 3M, 1S | Sonnet |
| D | DD Play + DL Play targeted | 3 | 2S, 1M | Sonnet |
| C | NYDCC noAward schema-first | 5 | 3M, 2S | Opus (type + UI + scoring) |
| F1 | OBIE scaffolding | 5 | 3M, 2S | Opus |
| F2 | OBIE data ingestion | 3 | 2M, 1S | Sonnet |
| G1 | Lortel scaffolding | 5 | 3M, 2S | Opus |
| G2 | Lortel data ingestion | 3 | 2M, 1S | Sonnet |
| H1 | Olivier extension | 3 | 2M, 1S | Sonnet |
| H2 | Critics' Circle pipeline | 5 | 3M, 2S | Sonnet |
| Z | Re-enable crons + verify | 3 | 3S | Sonnet |

## Cross-sprint dependency graph

```
0 ──► B ──► A1 ──► A2 ──► A3 ──► D ──► C ──► F1 ──► F2 ──► G1 ──► G2 ──► H1 ──► H2 ──► Z
│
├── Sprint 0 task S0-T3 (per-category-precursor lib) BLOCKS A1/A2/A3/F2/G2/H2 (all data-scraping sprints)
├── Sprint 0 task S0-T4 (ceremonies registry) BLOCKS F1/G1/H1 (all UI scaffolding)
├── Sprint 0 task S0-T5 (classifyCategory golden-fixture) BLOCKS F1/G1/H1 (all classifier extensions)
├── Sprint 0 task S0-T1 (--year=YYYY verification) BLOCKS B
├── Sprint 0 task S0-T2 (BWW verification) BLOCKS A1/A2/A3
├── Sprint 0 task S0-T8 (disable Tony cron) BLOCKS all subsequent sprints (race protection)
└── Sprint Z (re-enable crons) BLOCKS session end
```

**Critical path:** Sequential, 14 sprints. Within each sprint, most tasks are sequential (refactor → test → ship). Limited subagent parallelism — best opportunities marked Parallel:Yes below.

---

## Sprint 0: Pre-flight + scaffolding

**Demo:** `npm test -- classify-category-golden` passes. `gh workflow list` shows tony-update disabled. `node scripts/scrape-tony-awards.js --year=1994 --dry-run` returns nominees. **MODEL: Opus** (refactor + architectural decisions).
**Risks:** BWW redesigned (escalate before A1/A2/A3 start). scrape-tony --year=YYYY broken (Sprint B blocked).

### Task S0-T1: Verify scrape-tony-awards pre-2005 coverage
- **Complexity:** S — one command
- **Depends on:** None
- **Parallel:** Yes (with S0-T2)
- **Files:** None (verification only)
- **Description:** Confirm `scrape-tony-awards.js:44 START_YEAR=1970` is real. If broken, escalate to Notion sub-card and BLOCK Sprint B.
- **Acceptance:**
  - VERIFY: `node scripts/scrape-tony-awards.js --year=1994 --dry-run 2>&1 | grep -c "Best"` returns ≥5

### Task S0-T2: Verify BWW archive accessibility
- **Complexity:** M — 9 sample fetches via fetchPage
- **Depends on:** None
- **Parallel:** Yes (with S0-T1)
- **Files:** `/tmp/bww-probe.js` (throwaway)
- **Description:** Fetch 1 sample per era per ceremony (DD/OCC/DL × 1970s/1990s/2010s). Confirm fetchPage returns parseable. If BWW redesigned/blocked, escalate.
- **Acceptance:**
  - VERIFY: All 9 fetches return HTML with detectable awards table structure
  - VERIFY: No 4xx/5xx errors

### Task S0-T3: Extract scripts/lib/per-category-precursor.js
- **Complexity:** M — extract from 2 existing scrapers
- **Depends on:** None
- **Parallel:** Yes (with S0-T4, S0-T5)
- **Files:** `scripts/lib/per-category-precursor.js` (new), `scripts/scrape-drama-desk.js`, `scripts/scrape-outer-critics.js`
- **Description:** Extract shared diff/write block from drama-desk + outer-critics. Both should reduce to ~20-line configs. Test by running both, confirm byte-identical output to baseline.
- **Acceptance:**
  - VERIFY: `node scripts/scrape-drama-desk.js --dry-run` produces same JSON as baseline (diff = 0)
  - VERIFY: `node scripts/scrape-outer-critics.js --dry-run` same
  - VERIFY: `git diff scripts/scrape-drama-desk.js | wc -l` shows reduction (was ~150 lines, target ~30)

### Task S0-T4: Extract src/config/ceremonies.ts
- **Complexity:** M — UI refactor
- **Depends on:** None
- **Parallel:** Yes (with S0-T3, S0-T5)
- **Files:** `src/config/ceremonies.ts` (new), `src/components/AwardScoreCard.tsx`
- **Description:** Pull DD/OCC/DL/NYDCC config from AwardScoreCard.tsx:215-223 into registry. Refactor OtherAwardsPanel to map over it. Visual QA required per CLAUDE.md §5.
- **Acceptance:**
  - VERIFY: `npx tsc --noEmit` clean
  - VERIFY: Visual diff localhost vs prod on /show/hamilton-2015 shows NO change to awards section
  - VERIFY: Same for /show/red-2010

### Task S0-T5: Lock classifyCategory with golden-fixture test
- **Complexity:** M — fixture generation + test
- **Depends on:** None
- **Parallel:** Yes (with S0-T3, S0-T4)
- **Files:** `tests/unit/classify-category-golden.test.mjs` (new), `tests/fixtures/classify-category-baseline.json` (new)
- **Description:** Snapshot every category string in data/precursors/*.json through classifyCategory(). Pin outputs. Any future change to classifyCategory must update fixture explicitly.
- **Acceptance:**
  - VERIFY: `node --test tests/unit/classify-category-golden.test.mjs` passes
  - VERIFY: Fixture file has ≥150 entries (covers all current categories)

### Task S0-T6: Add classifyCategory JS/TS parity canary
- **Complexity:** S — single assertion
- **Depends on:** S0-T5
- **Parallel:** No
- **Files:** `tests/unit/classify-category-parity.test.mjs` (new)
- **Description:** Assert `scripts/lib/classify-category.js` and `src/lib/awards-scoring.ts:classifyCategory` produce identical outputs for the fixture.
- **Acceptance:**
  - VERIFY: Test passes for 100% of fixture inputs

### Task S0-T7: Add data/** + scripts/scrape-*.js to test.yml triggers
- **Complexity:** S — yaml edit
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `.github/workflows/test.yml`
- **Description:** Add the missing push.paths so CI fires on awards commits. Currently scrape-*.js + data/** are excluded.
- **Acceptance:**
  - VERIFY: `git diff .github/workflows/test.yml` shows added paths
  - VERIFY: Push a no-op data/awards.json change and confirm test.yml fires

### Task S0-T8: Disable competing awards crons
- **Complexity:** S — gh commands
- **Depends on:** S0-T1 (don't disable before confirming Sprint B works)
- **Parallel:** No
- **Files:** None (gh state)
- **Description:** `gh workflow disable update-tony-awards.yml` + grep `.github/workflows/*.yml` for other awards.json writers, disable each.
- **Acceptance:**
  - VERIFY: `gh workflow list | grep -i "tony\|drama-desk\|outer-critics\|drama-league" | grep -c disabled` ≥1

### Task S0-T9: Confirm npm run data:check passes
- **Complexity:** S — verification
- **Depends on:** None
- **Parallel:** Yes
- **Files:** None
- **Description:** Sanity check the private-data bootstrap. If broken, escalate before any sprint runs.
- **Acceptance:**
  - VERIFY: `npm run data:check` exits 0

**COMMIT after each task. Sprint 0 → ~9 commits.**

---

## Sprint B: Pre-2005 Tony repair (depends: S0-T1, S0-T8)

**Demo:** Demo URL renders Tony Awards section on /show/grease-1994, /show/fiddler-on-the-roof-1976. **MODEL: Sonnet**.
**Risks:** Wikipedia DOM change. Match logic re-introduces today's misattributions (deny-list canary catches).

### Task SB-T1: Derive ceremony years for 12 Broadway deletions
- **Complexity:** S — data lookup
- **Depends on:** S0-T1
- **Parallel:** No
- **Files:** `/tmp/sb-shows.txt` (throwaway)
- **Description:** For each of {grease-1994, fiddler-on-the-roof-1976, purlie-1972, play-on-1997, a-day-in-the-death-of-joe-egg-2003, harvey-2012, on-golden-pond-2005, 1776-2022, the-threepenny-opera-2006, hair-2011, angels-in-america-2018, a-view-from-the-bridge-2010}, look up openingDate in shows.json, derive Tony ceremony year.
- **Acceptance:**
  - VERIFY: 12 (showId, year) tuples written to /tmp/sb-shows.txt

### Task SB-T2: Add 17-entry deny-list canary
- **Complexity:** S — new test file
- **Depends on:** None
- **Parallel:** Yes (with SB-T1)
- **Files:** `tests/unit/tony-deny-list.test.mjs` (new)
- **Description:** Assert the 17 misattributed (showId, season, win) triples from today's deletions never reappear. Reference: `scripts/fix-tony-attribution.js` FIXES table.
- **Acceptance:**
  - VERIFY: `node --test tests/unit/tony-deny-list.test.mjs` passes (currently, since blocks are deleted)
  - VERIFY: Test is wired in `.github/workflows/test.yml` test runner line

### Task SB-T3: Scrape ceremony years (deduplicated)
- **Complexity:** M — runs scrape-tony per year
- **Depends on:** SB-T1
- **Parallel:** No
- **Files:** `data/awards.json` (modify)
- **Description:** For each unique year in SB-T1 list: `node scripts/scrape-tony-awards.js --year=YYYY`. Single bash loop. ~8 unique years.
- **Acceptance:**
  - VERIFY: `git diff data/awards.json` shows tony blocks for ≥10 of the 12 shows
  - VERIFY: 0 WE/OB shows reappear with tony blocks

### Task SB-T4: Run all gates
- **Complexity:** S — verification
- **Depends on:** SB-T3
- **Parallel:** No
- **Files:** None
- **Description:** Validate, audit, canary, deny-list.
- **Acceptance:**
  - VERIFY: `node scripts/validate-data.js` Tony attribution clean
  - VERIFY: `node scripts/audit-tony-attribution.js` 0 misattributions
  - VERIFY: `node --test tests/unit/tony-attribution-canary.test.mjs tests/unit/tony-deny-list.test.mjs` all pass

### Task SB-T5: Commit + push + verify deploy + update Notion
- **Complexity:** S
- **Depends on:** SB-T4
- **Parallel:** No
- **Files:** Git state
- **Description:** Atomic commit (data + canary), push, watch deploy, append progress to Notion card.
- **Acceptance:**
  - VERIFY: `gh run list --workflow=vercel-deploy.yml --limit=1` shows success for this SHA
  - VERIFY: `curl -s https://demo.broadwayscorecard.com/show/grease-1994 | grep -c "Tony"` ≥1

---

## Sprints A1/A2/A3: DD/OCC/DL sub-categories (depends: S0-T2, S0-T3)

**Each sprint same shape — 4 tasks:**

### Task SA{N}-T1: Extend scraper with BWW fallback
- **Complexity:** M
- **Files:** `scripts/scrape-{drama-desk|outer-critics|drama-league}.js`
- **Description:** Add BWW fallback when Wikipedia sub-cat returns 0 entries. Use shared `per-category-precursor.js` lib.
- **Acceptance:**
  - VERIFY: `--dry-run` reports BWW fetches happening for sub-cats
  - VERIFY: Existing top-category data unchanged (per-year UNION merge preserves)

### Task SA{N}-T2: Add structural DOM contract assertion
- **Complexity:** S
- **Files:** Same scraper
- **Description:** If sub-cat returns 0 from BWW but baseline had ≥5, throw. Prevents silent DOM-change failures.
- **Acceptance:**
  - VERIFY: Unit test passes with mock 0-count BWW response

### Task SA{N}-T3: Set BD/SB credit budget guard + run full scrape
- **Complexity:** M
- **Files:** `data/precursors/{ceremony}.json`, `data/awards.json`
- **Description:** `SB_CREDIT_BUDGET=400 node scripts/scrape-{ceremony}.js --min-year=1975`. Then `node scripts/enrich-awards-with-precursors.js`.
- **Acceptance:**
  - VERIFY: `data/precursors/{ceremony}.json` entry count grew ≥10x for sub-categories
  - VERIFY: validate-data + audit-tony-attribution clean
  - VERIFY: Budget guard didn't trip (didn't exceed 400 credits)

### Task SA{N}-T4: Commit + push + verify deploy + 5-show spot check
- **Complexity:** S
- **Files:** Git state
- **Description:** Atomic commit, push, demo URL verify for Annie 1977 / Dreamgirls 1981 / Phantom 1988 / Wicked 2003 / Hamilton 2015 (DD), equivalents for OCC + DL.
- **Acceptance:**
  - VERIFY: All 5 demo URLs render the new ceremony sub-cats
  - VERIFY: Deploy succeeded

---

## Sprint D: DD Play 1971-74 + DL Play 1977-95 (depends: SA3-T4)

### Task SD-T1: Targeted scrape via shared lib
- **Complexity:** M
- **Files:** `data/precursors/drama-desk.json`, `data/precursors/drama-league.json`
- **Acceptance:**
  - VERIFY: DD Outstanding Play continuous 1971-2025
  - VERIFY: DL Outstanding Production of a Play continuous 1935-2025

### Task SD-T2: Enrich + validate
- **Complexity:** S
- **Acceptance:**
  - VERIFY: validate-data clean

### Task SD-T3: Commit + push + deploy verify
- **Complexity:** S
- **Acceptance:**
  - VERIFY: Deploy success

---

## Sprint C: NYDCC noAward schema-first (depends: SD-T3)

### Task SC-T1: Extend NyDramaCriticsAwards type
- **Complexity:** S
- **Files:** `src/lib/data-types.ts`
- **Description:** Add `noAward?: boolean` field.
- **Acceptance:**
  - VERIFY: `npx tsc --noEmit` clean

### Task SC-T2: Extend OtherAwardsPanel to render noAward chip
- **Complexity:** M
- **Files:** `src/components/AwardScoreCard.tsx`
- **Acceptance:**
  - VERIFY: Component renders "No award given" chip when noAward=true (test fixture)
  - VERIFY: Visual QA on a show with mocked noAward entry

### Task SC-T3: Update scoreCeremony to skip noAward
- **Complexity:** S
- **Files:** `src/lib/awards-scoring.ts:203`
- **Acceptance:**
  - VERIFY: Unit test: noAward entries contribute 0 to score

### Task SC-T4: Populate noAward markers from Wikipedia
- **Complexity:** M
- **Files:** `scripts/scrape-nydcc.js`, `data/precursors/nydcc.json`
- **Description:** Parse Wikipedia annotations for "no award given" markers. Write noAward:true entries.
- **Acceptance:**
  - VERIFY: NYDCC Best Play 1970-2026 has either winner OR noAward:true for every year
  - VERIFY: ≥5 noAward entries written

### Task SC-T5: Commit + push + deploy + demo verify
- **Complexity:** S
- **Acceptance:**
  - VERIFY: Demo URL shows "No award given" chip on ≥5 NYDCC categories

---

## Sprint F1: OBIE scaffolding (depends: S0-T4, S0-T5)

### Task SF1-T1: Add OBIE to ceremonies registry
- **Complexity:** S
- **Files:** `src/config/ceremonies.ts`
- **Acceptance:**
  - VERIFY: tsc clean, AwardScoreCard maps OBIE entry without changes

### Task SF1-T2: Extend classifyCategory for OBIE categories
- **Complexity:** M
- **Files:** `scripts/lib/classify-category.js`, `src/lib/awards-scoring.ts`
- **Description:** Add OBIE category strings. Run golden-fixture test — MUST still pass (no Tony/DD/OCC/DL regression).
- **Acceptance:**
  - VERIFY: `node --test tests/unit/classify-category-golden.test.mjs` PASSES
  - VERIFY: New OBIE-only fixture entries pass
  - VERIFY: parity canary still passes

### Task SF1-T3: Extend enrich-awards-with-precursors.js category map
- **Complexity:** S
- **Files:** `scripts/enrich-awards-with-precursors.js`
- **Description:** Single line via existing `applyDDOCCDL` template.
- **Acceptance:**
  - VERIFY: enrich --dry-run runs without errors

### Task SF1-T4: Stub data/precursors/obie.json
- **Complexity:** S
- **Files:** `data/precursors/obie.json` (new)
- **Description:** Empty `data: []` array with schema metadata.
- **Acceptance:**
  - VERIFY: validate-data clean

### Task SF1-T5: Commit + push (NO demo verify — data still empty)
- **Complexity:** S
- **Acceptance:**
  - VERIFY: Deploy succeeds
  - VERIFY: No visual regression on existing show pages

---

## Sprint F2: OBIE data ingestion (depends: SF1-T5)

### Task SF2-T1: Build scrape-obies.js as config on shared lib
- **Complexity:** M
- **Files:** `scripts/scrape-obies.js` (new — ~15 lines using per-category-precursor.js)
- **Acceptance:**
  - VERIFY: --dry-run pulls Wikipedia OBIE pages successfully

### Task SF2-T2: Populate obie.json from 1956+
- **Complexity:** M
- **Files:** `data/precursors/obie.json`
- **Description:** Source: Wikipedia per-category pages, fallback VillageVoice archive.
- **Acceptance:**
  - VERIFY: ≥30 years of data (1956+)
  - VERIFY: validate-data clean, audit-tony-attribution clean

### Task SF2-T3: Commit + push + demo verify
- **Complexity:** S
- **Acceptance:**
  - VERIFY: Demo URL renders OBIE section on ≥50 historically-nominated shows
  - VERIFY: F1 golden-fixture test STILL passes (no classifier regression)

---

## Sprint G1/G2: Lortel Awards (same pattern as F1/F2)

[5 tasks G1 + 3 tasks G2, same structure as F1/F2. Source: Wikipedia Lucille_Lortel_Award per-category pages. Acceptance: Demo renders Lortel section on ≥30 Off-Broadway shows.]

---

## Sprint H1: Olivier extension (depends: SG2-T3)

### Task SH1-T1: Grep existing categories vs classifyCategory
- **Complexity:** S
- **Files:** None (analysis)
- **Description:** `node -e "const cats = require('./data/precursors/olivier.json').data; ..."` — confirm UK terms already classify (Design reviewer flag).
- **Acceptance:**
  - VERIFY: Report written showing which UK categories already map, which don't

### Task SH1-T2: Extend enrich-olivier-awards.js for gaps
- **Complexity:** M
- **Files:** `scripts/enrich-olivier-awards.js`, `data/awards.json`
- **Acceptance:**
  - VERIFY: Olivier coverage increased on demo URL for ≥10 West End shows

### Task SH1-T3: Commit + push + demo verify
- **Complexity:** S

---

## Sprint H2: Critics' Circle Theatre Awards (depends: SH1-T3)

[5 tasks: registry entry, classifyCategory extension (golden-fixture must still pass), enrich extension, scrape-critics-circle.js as config, populate data + verify. Same atomic pattern as F1/F2.]

---

## Sprint Z: Re-enable crons + verify

### Task SZ-T1: Re-enable awards crons
- **Complexity:** S
- **Files:** None (gh state)
- **Acceptance:**
  - VERIFY: `gh workflow list | grep -E "tony|drama-desk|outer-critics|drama-league" | grep -c disabled` = 0

### Task SZ-T2: Trigger one manual cron run + verify no clobber
- **Complexity:** S
- **Acceptance:**
  - VERIFY: `gh workflow run update-tony-awards.yml` succeeds
  - VERIFY: validate-data + canary + deny-list tests STILL pass after cron run lands

### Task SZ-T3: Post completion summary to Notion card
- **Complexity:** S
- **Acceptance:**
  - VERIFY: Notion card 363637c5-416f-8109-9afe-d18e215942ca has Outcome section with completion summary, set to Done

---

## Self-validation checklist

1. **Completeness:** PASS — every sprint demoable (commit + deploy + URL verify). Sprint 0 ships shared lib + tests visible in `git log`. Sprint B ships restored Tony sections. Sprints A/F/G/H each ship visible new awards data.
2. **Atomicity:** PASS — every task is one commit. No "and" in titles.
3. **Dependency chain:** PASS — explicit graph at top. No cycles. Sprint 0 fanout to A/F/G/H via shared lib + golden-fixture is documented.
4. **Test coverage:** PASS — every task has VERIFY commands (validate-data, audit, canary, demo URL curl, golden-fixture test).
5. **Missing work:** PASS — covers schema (SC-T1), UI (S0-T4, SC-T2), CI gates (S0-T7), rollback (canary tests + deny-list), monitoring (deploy verify), cron pause/restore (S0-T8 + SZ-T1).
6. **Ordering:** PASS — Sprint 0 first protects all downstream. B before A (visible fix first, small surface). A trio before C/F/G/H (enrich-awards-with-precursors.js no rebase thrash). Z last (cron re-enable after data settled).
7. **Parallel workstreams:** PASS — within Sprint 0, S0-T1/T2/T3/T4/T5 can run as 5 subagent tracks. Across sprints, F1+F2 are sequential by design (scaffolding then data) — that's the keystone risk mitigation.
8. **Manual before automated:** PASS — Sprint 0 manual verification of Tony scraper + BWW (S0-T1, S0-T2) before A trio automates.
9. **Scale check:** PASS — existing precursor write path has shrink-guard at `precursor-wikipedia.js:217`. SB_CREDIT_BUDGET guard in A sprints. 17-entry deny-list scales O(1) per check.

All PASS. No fix needed.

---

## Subagent execution map (within a single /execute-plan session)

**Sprint 0 — max parallelism:**
```
Subagent track 1: S0-T1 (verify scraper) → S0-T8 (disable crons)
Subagent track 2: S0-T2 (verify BWW)
Subagent track 3: S0-T3 (per-category-precursor.js lib)
Subagent track 4: S0-T4 (ceremonies.ts registry) → S0-T6 (parity canary)
Subagent track 5: S0-T5 (golden-fixture test) → S0-T7 (test.yml triggers) → S0-T9 (data:check)
Sync: ──── after Sprint 0 (all gates green) ────
```

**Sprints B/A/D/C — mostly sequential** (single track each, sprint-internal subagent parallelism limited).

**Sprints F1/G1/H1 — sequential by design** (each needs prior sprint's data settled before classifyCategory extension). Within each, T2/T3 can run as 2 subagents after T1 completes.

**Sprint Z — sequential.**

**Critical path:** 14 sprints sequential. Subagent parallelism gives ~30% speedup within sprints, doesn't compress critical path.

**Cross-session plan (if context fills):** Each sprint ships to main independently. Natural breakpoints: after Sprint 0, after Sprint B, after each A sprint, after each F/G/H sub-sprint. Resume by reading this task file + Notion card progress notes.

---

## Known edge cases

1. **Wikipedia "no award given" wording varies** (Sprint C) — sometimes "not given," "withheld," "—" with no explicit text. Test parser against ≥5 known no-award years before bulk run.
2. **OBIE category invention 1956-2017** — Village Voice invented categories year-to-year, no fixed taxonomy. Sprint F2 may produce many unmatched categories. Strategy: log unmatched, classify later, never silent-drop.
3. **BWW DOM differs per decade** — table → div → SPA. Sprint A1/A2/A3 each may need per-era parser hooks. Structural assertion (SA{N}-T2) catches regression.
4. **enrich-awards-with-precursors.js title-collision** — already debugged this session (Pass 0 season-match preference). New ceremonies F/G/H inherit the fix. Verify by running enrich after each ceremony lands.
5. **classifyCategory regex order matters** — golden-fixture test catches regressions but a malicious-by-accident change (reordering existing regexes) could still pass. Treat golden-fixture as a contract, not a guard.
6. **Demo URL build lag** — Vercel cron deploys main HEAD every 5 min but sometimes lags 15-30 min. After every sprint, watch `gh run list --workflow=vercel-deploy.yml` until completion before next sprint starts.

---

## Changes from critique

Already incorporated in the source plan (cloud-memory/sprint-awards-completeness.md, commit c0e9973d6e) — see "Plan-review changes" table at bottom of that file.

---

## Key risks

1. **Parallel session clobber** — earlier today a Tony fix got reverted in 3h by a parallel session. Sprint 0 task S0-T8 disables the worst offender (Tony cron). Other awards crons identified in S0-T8 must also be disabled. **Mitigation:** atomic commits + push immediately + Sprint Z explicit re-enable.
2. **Sprint 0 reveals broken assumption** — if `scrape-tony-awards.js --year=1994` returns nothing (script actually does only cover 2005+ despite START_YEAR=1970), Sprint B falls back to manual rebuild. **Mitigation:** S0-T1 escalates to Notion sub-card; B can still proceed manually but adds 1-2h.
3. **BWW redesigned between plan-review and execution** — Sprint A trio dead. **Mitigation:** S0-T2 verifies before A sprints start; if blocked, A sprints escalate but B/C/D/F/G/H can still run.

---

## Output file location

**This file:** `cloud-memory/sprint-awards-completeness-tasks.md`
**Companion plan:** `cloud-memory/sprint-awards-completeness.md` (the strategic plan; this file is the task breakdown)
**Notion card:** 363637c5-416f-8109-9afe-d18e215942ca
