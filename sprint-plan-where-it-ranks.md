# Sprint Plan: Where It Ranks

## Overview
Add a small rank line under the score badge ("Ranks #3 of 28 open Broadway · #3 this season · #47 all-time*") and a "Where it ranks" table near the bottom of every show page with 5 metrics × 3 columns + format toggle. Pre-computed rank index avoids build-time blowup; feature-flagged for safe rollout.

## Sprint Summary

| Sprint | Goal | Tasks | Complexity |
|---|---|---|---|
| 1 | Olivier cutoffs + freshness CI | 5 | 4S, 1M |
| 2 | Rank computation utility | 5 | 1S, 3M, 1M |
| 3 | Hero rank line | 3 | 2S, 1M |
| 4 | Where-it-ranks card | 5 | 1S, 3M, 1M |
| 5 | Ship | 4 | 4S |

Total: **22 tasks**. ~10 hours. 2 sessions.

## Sprint 1 — Olivier cutoffs two-layer + freshness gate

**Demo:** `node -e "console.log(require('./src/lib/olivier-seasons').getOlivierSeasonWindow())"` returns ISO-dated window. CI workflow runs locally.
**Risks:** SOLT eligibility windows for past years may be hard to source precisely. Mitigation: cite Wikipedia + SOLT site; mark uncertain dates clearly.
**MODEL:** Sonnet — data entry + structured CI yaml, clear specs.

### Task S1-T1: Create olivier-cutoffs.ts skeleton
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** src/lib/olivier-cutoffs.ts (new)
- **Description:** Mirror tony-cutoffs.ts structure: OlivierSeasonRecord interface, OLIVIER_CUTOFFS array (empty initially), olivierSeasonForDate / currentOlivierSeason / olivierSeasonForCeremonyYear / allOlivierSeasonsNewestFirst helpers. Add `lastVerified: string` field to record.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit src/lib/olivier-cutoffs.ts` exits 0
  - VERIFY: All exported helpers from tony-cutoffs.ts have an olivier equivalent

### Task S1-T2: Populate Olivier records 2016-2026
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** src/lib/olivier-cutoffs.ts (modify)
- **Description:** Populate OLIVIER_CUTOFFS with ceremonies 2016-2026. Source dates from SOLT (officiallondontheatre.com) and Wikipedia. Each entry: ceremonyYear, label (e.g., "2024-25"), start (day after prior end), end (eligibility-close per SOLT), source URL, lastVerified=today, notes if window deviates.
- **Acceptance criteria:**
  - VERIFY: 11 records (2016-2026); each has all fields populated
  - VERIFY: No date gaps or overlaps between consecutive seasons
  - VERIFY: `node -e "console.log(require('./src/lib/olivier-cutoffs').currentOlivierSeason())"` returns current window

### Task S1-T3: Create olivier-seasons.ts filter layer
- **Complexity:** S
- **Depends on:** S1-T1
- **Parallel:** Yes (with T2)
- **Files:** src/lib/olivier-seasons.ts (new)
- **Description:** Mirror tony-seasons.ts pattern. Import OLIVIER_CUTOFFS, expose getOlivierSeasonWindow(), DateRange synthesizers, season filter for shows.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit src/lib/olivier-seasons.ts` exits 0
  - VERIFY: getOlivierSeasonWindow() returns object with start/end/label

### Task S1-T4: Create check-cutoff-freshness workflow
- **Complexity:** S
- **Depends on:** S1-T2
- **Parallel:** No
- **Files:** .github/workflows/check-cutoff-freshness.yml (new), scripts/check-cutoff-freshness.js (new)
- **Description:** Daily scheduled workflow + node script. Reads both tony-cutoffs.ts and olivier-cutoffs.ts. Advisory v1: emits ::warning when current ceremony's end is <60 days away and lastVerified is >60 days old.
- **Acceptance criteria:**
  - VERIFY: `node scripts/check-cutoff-freshness.js` runs locally and exits 0
  - VERIFY: Workflow yaml passes actionlint syntax check

### Task S1-T5: Add cutoff-freshness to check-cron-health critical list
- **Complexity:** S
- **Depends on:** S1-T4
- **Parallel:** No
- **Files:** .github/workflows/check-cron-health.yml (modify)
- **Description:** Add `check-cutoff-freshness.yml` to the CRITICAL_CRONS list. Advisory-only, doesn't gate deploys.
- **Acceptance criteria:**
  - VERIFY: `grep check-cutoff-freshness .github/workflows/check-cron-health.yml` finds 1+ match

---

## Sprint 2 — data-show-ranks.ts with precomputed index

**Demo:** `node scripts/test-show-ranks.mjs` passes; bench <5s; getShowRanks(showId) returns expected ShowRanks object.
**Risks:** Sidecar lookups (audience, grosses) inside comparators could be slow. Mitigation: prefetch all sidecars once into Maps before sorting.
**MODEL:** Opus — perf-critical sorting/tie-break logic, multi-metric pool semantics.

### Task S2-T1: Create data-show-ranks.ts types + skeleton
- **Complexity:** S
- **Depends on:** S1-T3
- **Parallel:** No
- **Files:** src/lib/data-show-ranks.ts (new)
- **Description:** Types: ShowRanks (object with critic/audience/awards/boxOffice/overall), RankSet ({openMarket, season, allTime} each {rank, total} | null). Stub getShowRanks(showId, opts) returning null.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit src/lib/data-show-ranks.ts` exits 0
  - VERIFY: ShowRanks + RankSet exported

### Task S2-T2: Implement pool predicates (open / season / all-time)
- **Complexity:** M
- **Depends on:** S2-T1, S1-T3
- **Parallel:** No
- **Files:** src/lib/data-show-ranks.ts (modify)
- **Description:** Internal helpers: isInOpenPool(show, market) — match data-core.ts:128-131 (open OR previews). isInSeasonPool(show, market) — use getShowSeason() for BW/OB, olivier-seasons.ts for WE/OWE, match current season. isInAllTimePool(show) — hasEnoughReviews=true (scored 2005+).
- **Acceptance criteria:**
  - VERIFY: Each predicate compiles and is callable
  - VERIFY: Inline assertion: `node -e "const m = require('./src/lib/data-show-ranks'); console.log(m.__test_open(...) )"` returns expected booleans on fixture shows

### Task S2-T3: Implement per-metric value extractors
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** Yes (with T2)
- **Files:** src/lib/data-show-ranks.ts (modify)
- **Description:** Internal helpers: getRoundedCriticScore, getRoundedAudienceScore, getAwardsScore (uses computeSiteAwardScore), getBoxOfficeGross (uses getShowGrosses), getOverallScore (uses compositeScore). All return number | null. Round critic/audience for display-aligned ranks per `feedback_round_once_share_everywhere`.
- **Acceptance criteria:**
  - VERIFY: All 5 extractors typed correctly
  - VERIFY: Each returns null when source data is missing

### Task S2-T4: Build module-scope precomputed rank index
- **Complexity:** M
- **Depends on:** S2-T2, S2-T3
- **Parallel:** No
- **Files:** src/lib/data-show-ranks.ts (modify)
- **Description:** ensureBuilt() runs once: for each (metric, pool, format) tuple, filter all shows, sort by metric desc, assign dense rank. Populate Map<showId, ShowRanks>. Replace getShowRanks() stub. Hide row when target show not in pool.
- **Acceptance criteria:**
  - VERIFY: `node -e "const m = require('./src/lib/data-show-ranks'); const r = m.getShowRanks('hamilton-2015'); console.log(r);"` returns non-null ShowRanks
  - VERIFY: Second call returns same reference (memoized)

### Task S2-T5: Write tests + bench
- **Complexity:** M
- **Depends on:** S2-T4
- **Parallel:** No
- **Files:** scripts/test-show-ranks.mjs (new)
- **Description:** node:test fixtures: musical w/ all metrics, play w/o audience, OB show w/o grosses, closed show queried in open pool, tied scores. Assert dense rank for ties, target-not-in-pool null, denominators match. Bench: full index build <5s.
- **Acceptance criteria:**
  - VERIFY: `node --test scripts/test-show-ranks.mjs` passes all assertions
  - VERIFY: Bench output prints build time <5000ms

---

## Sprint 3 — Hero rank line inside ShowHeroRedesign

**Demo:** /show/giant hero shows "Ranks #N of M open Broadway · ..." line. Pre-opening shows do not.
**Risks:** Mobile wrap on long market names ("open Off-Broadway"). Mitigation: test with longest label at 390px before commit.
**MODEL:** Sonnet — UI work with clear spec from mock.

### Task S3-T1: Add ranks prop to ShowHeroRedesign
- **Complexity:** S
- **Depends on:** S2-T4
- **Parallel:** No
- **Files:** src/components/show-page/ShowHeroRedesign.tsx (modify)
- **Description:** Accept optional `ranks: ShowRanks | null` prop. Type from data-show-ranks.ts.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` exits 0
  - VERIFY: Existing callers continue to compile

### Task S3-T2: Render Variant B rank line in hero
- **Complexity:** M
- **Depends on:** S3-T1
- **Parallel:** No
- **Files:** src/components/show-page/ShowHeroRedesign.tsx (modify)
- **Description:** Append small gray text line under "Based on N Reviews" / Audience chip row. Format: "Ranks #N of M open {Market} · #N this season · #N all-time*". Partial-null friendly. Hide entirely if criticScore TBD or ranks null. Use surface tokens only.
- **Acceptance criteria:**
  - VERIFY: Manual run of `npm run dev` and visit /show/giant shows the line
  - VERIFY: Pre-opening show (one with status=upcoming) does NOT show the line
  - VERIFY: At 390px the longest market label ("open Off-Broadway") does not wrap to a third line

### Task S3-T3: Wire ranks from page.tsx
- **Complexity:** S
- **Depends on:** S3-T2
- **Parallel:** No
- **Files:** src/app/show/[slug]/page.tsx (modify)
- **Description:** Add `const ranks = getShowRanks(show.id, { format: 'all' });` near other data lookups (around line 305-320). Pass to `<ShowHeroRedesign ranks={ranks} ... />`.
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` exits 0
  - VERIFY: Live dev page shows rank line

---

## Sprint 4 — WhereItRanks card, feature-flagged

**Demo:** With featureFlags.showRanks=true, /show/giant renders card with toggle, links, footnote. Toggle switches All shows ↔ Musicals (or Plays).
**Risks:** Different denominators per row could confuse users. Mitigation: explicit `#N of M` displayed per cell, not just rank.
**MODEL:** Sonnet — well-defined UI work.

### Task S4-T1: Add showRanks feature flag
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** src/config/feature-flags.ts (modify)
- **Description:** Add `showRanks: boolean` to feature flags. Default false. Env-overridable via `NEXT_PUBLIC_SHOW_RANKS=1`.
- **Acceptance criteria:**
  - VERIFY: `grep -n showRanks src/config/feature-flags.ts` shows new entry
  - VERIFY: `npx tsc --noEmit` exits 0

### Task S4-T2: Create WhereItRanks.tsx component
- **Complexity:** M
- **Depends on:** S2-T4
- **Parallel:** Yes (with S4-T1)
- **Files:** src/components/show-page/WhereItRanks.tsx (new)
- **Description:** Props: `{ ranks: ShowRanks, ranksByFormat: ShowRanks | null, market, type }`. Table layout per mock. Toggle: "All shows" + show's own format (Musical OR Play). Hidden if type is neither.
- **Acceptance criteria:**
  - VERIFY: Component compiles
  - VERIFY: Toggle UI renders with 2 buttons max

### Task S4-T3: Implement cell rendering + links + UX polish
- **Complexity:** M
- **Depends on:** S4-T2
- **Parallel:** No
- **Files:** src/components/show-page/WhereItRanks.tsx (modify)
- **Description:** Each cell: if rank set, render link to mapped page (via getBrowseSlug helper for CriticScore/Overall, hardcoded for others) or plain text. Unlinked cells: no underline, default cursor. Tooltip on "—" cells: "Awards Score is Broadway-only" etc. Footnote: "All-time pool: shows scored 2005-present." Microcopy under toggle: "Compared against all open {Market} {format}".
- **Acceptance criteria:**
  - VERIFY: Hover an "—" cell shows tooltip
  - VERIFY: Unlinked cells have no underline / pointer cursor
  - VERIFY: Footnote rendered below table

### Task S4-T4: Mount WhereItRanks in page.tsx flag-gated
- **Complexity:** M
- **Depends on:** S4-T1, S4-T3
- **Parallel:** No
- **Files:** src/app/show/[slug]/page.tsx (modify)
- **Description:** Compute `ranksByFormat = getShowRanks(show.id, { format: show.type })` alongside the all-format ranks. Render `<WhereItRanks>` near bottom of page, behind `featureFlags.showRanks`. Map show.category → market display name.
- **Acceptance criteria:**
  - VERIFY: With flag off, /show/giant unchanged
  - VERIFY: With flag on, card renders near bottom
  - VERIFY: WE/OWE/OB shows render correct column header

### Task S4-T5: Playwright screenshots
- **Complexity:** S
- **Depends on:** S4-T4
- **Parallel:** No
- **Files:** /tmp/screenshots/ (output)
- **Description:** With flag on, screenshot 390 + 1440 on BW musical, WE play, OB show, closed show.
- **Acceptance criteria:**
  - VERIFY: 8 screenshots exist (4 shows × 2 viewports)
  - VERIFY: Visually correct — column header, toggle, footnote per show

---

## Sprint 5 — Ship

**Demo:** Feature-flagged Vercel deploy live; 3 prod URLs render expected ranks; build delta <90s.
**Risks:** Build time exceeds budget. Mitigation: bench captured in S2-T5; flag off if budget blown.
**MODEL:** Sonnet — verification, dispatch, monitor.

### Task S5-T1: tsc + lint
- **Complexity:** S
- **Files:** N/A
- **Acceptance criteria:**
  - VERIFY: `npx tsc --noEmit` zero errors
  - VERIFY: `npx next lint` no new warnings

### Task S5-T2: Full build + measure delta
- **Complexity:** S
- **Files:** N/A
- **Acceptance criteria:**
  - VERIFY: `time npm run build` succeeds; delta vs main <90s

### Task S5-T3: Commit + push + dispatch deploy
- **Complexity:** S
- **Files:** N/A
- **Acceptance criteria:**
  - VERIFY: Merged to main; `gh workflow run "Deploy to Vercel"` succeeded
  - VERIFY: Production URL responds 200 with no rank elements visible (flag off)

### Task S5-T4: Enable flag for Broadway smoke + verify prod
- **Complexity:** S
- **Files:** Vercel env var
- **Acceptance criteria:**
  - VERIFY: `NEXT_PUBLIC_SHOW_RANKS=1` set in Vercel; redeploy
  - VERIFY: /show/giant, /show/{west-end-show}, /show/{ob-show} all render expected ranks
  - VERIFY: Update Notion card with Outcome

---

## Dependencies Graph

```
S1-T1 → S1-T2 → S1-T4 → S1-T5
S1-T1 → S1-T3 ─────────────┘
        └→ S2-T1 → S2-T2 ↓
                  → S2-T3 ↓
                          S2-T4 → S2-T5
                                  └→ S3-T1 → S3-T2 → S3-T3
                                          └→ S4-T2 → S4-T3 → S4-T4 → S4-T5
                                  S4-T1 ──────────────┘
                                  S5: T1 → T2 → T3 → T4
```

## Parallel Execution Map

```
Track A:  S1-T1 → S1-T2 → S1-T4 → S1-T5 → S2-T2 ──┐
Track B:          S1-T3 ──────────────→ S2-T3 ────┼→ S2-T4 → S2-T5 → S3-T1 → S3-T2 → S3-T3
Track C:                                          │         S4-T1   →    S4-T2 → S4-T3 → S4-T4 → S4-T5
Sync:     ──── after S1 ──────── after S2 ───────────────────────── after S4 ──── Sprint 5
```

**Critical path:** S1-T1 → S1-T2 → S2-T2 → S2-T4 → S2-T5 → S3 → S4 → S5. ~10 hours single-track.
**Max parallelism:** 3 tracks at peak (Sprint 1 + early Sprint 2).

## Known Edge Cases

- TBD show (criticScore null) — hide hero line, card hides row by row
- Pre-opening show — hide hero line (status='upcoming')
- Closed show — target not in open pool → openMarket rank = null
- Pool <3 shows — all ranks null for that pool
- Tied scores on rounded value — dense rank (1,1,2)
- WE/OWE shows with no Awards Score — row shows "—" with tooltip
- OB/OWE shows with no Box Office — row shows "—" with tooltip
- Longest market label at 390px — must not wrap (test S3-T2)

## Changes from Critique

See /tmp/critique-plan.txt and revised plan above. All P0/P1 from 6-reviewer critique addressed.

## Key Risks

1. **Build time blowup** — mitigated by precomputed module-scope index (Sprint 2). Bench in S2-T5.
2. **Olivier date drift** — mitigated by lastVerified field + freshness CI gate (Sprint 1).
3. **Feature flag rollout** — flag off by default, enable per-market after smoke test (S5-T4).
