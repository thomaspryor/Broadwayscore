---
name: sprint-awards-completeness
description: Sprint plan for filling all awards data completeness gaps identified by 2026-05-17 audit. Handoff-ready for autonomous /loop execution in a fresh session.
metadata:
  type: project
---

# Sprint: Awards Data Completeness

**Status:** Not started — handoff to a fresh autonomous-loop session.
**Origin:** 2026-05-17 LLM audit (Gemini 2.5 Pro + GPT-4o) on Broadway Scorecard awards data, after the systematic Tony attribution fix (`562740f8af` + `c9a1a396f7`) addressed correctness. This plan addresses **completeness**.

## Why this exists

The Tony attribution sprint fixed *wrong* data (17 misattributions deleted + CI gate + canary). It did NOT fill *missing* data. Audit found 8+ classes of completeness gaps that will be visible to Broadway fans on Reddit launch and beyond.

Per user (2026-05-17): "we need to fill all of those data gaps... make a sprint plan to just get through all of those data gaps without me needing to babysit it."

## Operating rules (read first)

- **CLAUDE.md compliance mandatory** — especially worktree-first for any `src/` / `scripts/` / `.github/workflows/` edit, scoring-delta gate if you touch scoring code, validate-data gate before commit.
- **Existing infrastructure first.** Before writing a new scraper, grep `scripts/` for existing equivalents. Many scrape-* scripts already use shared `fetchPage()` from `scripts/lib/scraper.js`.
- **Validate-data is your friend.** After every data write, run `node scripts/validate-data.js`. The new Tony attribution gates (commit `c9a1a396f7`) will catch regressions automatically.
- **Atomic commits.** Parallel sessions silently clobber single-commit fixes (see `memory/feedback_silent_merge_loss_on_reformat.md`). Commit script + data + canary test in one commit per sprint.
- **Push immediately.** Background `pull --rebase` clobbers uncommitted dirty data state.
- **No babysitting required.** This file is the plan. Pick the next sprint, complete it, commit, push, move on.

## Sprint A — DD/OCC/DL sub-category historical fill (highest ROI)

**Goal:** Fill 1975-2022 historical coverage of Drama Desk, Outer Critics Circle, and Drama League sub-categories (Direction, Choreography, Acting, Design, Book, Music, Lyrics, Orchestrations).

**Current state (per audit):**
- DD top 4 categories: 1975-2025 ✓. DD sub-categories: ONLY 2023-2025.
- OCC top 4: 1953-2025 ✓. OCC sub-categories: ONLY 2022-2025.
- DL Direction: 2022+ only.

**Source priority:**
1. **BroadwayWorld awards archive** — has per-year ceremony pages going back decades. Structured HTML, scrapeable via existing `fetchPage()`.
2. **Drama Desk official site** (dramadesk.org/past-winners) — fewer years but authoritative.
3. **OuterCriticsCircle.org** — sparse but verifiable.
4. Wikipedia "YYYY_Drama_Desk_Awards" / "YYYY_Outer_Critics_Circle_Awards" — already mined; what's there is in.

**Approach:**
- Extend existing `scripts/scrape-drama-desk.js`, `scrape-outer-critics.js`, `scrape-drama-league.js` to pull from BWW archive when Wikipedia returns empty for sub-cats.
- Per-year UNION merge (don't overwrite hand-curated data — see `memory/feedback_silent_merge_loss_on_reformat.md`).
- After scrape, run `node scripts/enrich-awards-with-precursors.js` to map nominees to show IDs.

**Validation gates:**
- `node scripts/validate-data.js` clean
- `node scripts/audit-awards-data.js` issue count must not regress (currently 376; new data adds entries, may reveal more duplicate-nomination cases which is fine)

**Acceptance:**
- DD Outstanding Direction of a Musical: ≥30 years of data (currently 3)
- DD Outstanding Choreography: ≥30 years
- OCC Outstanding Director of a Musical: ≥20 years (currently 4)
- DL Outstanding Direction of a Play: ≥10 years (currently 4)
- Spot-check 5 famous shows (Annie 1977, Dreamgirls 1981, Phantom 1988, Wicked 2003, Hamilton 2015) — each should now show DD/OCC sub-category recognition

**Estimated:** 2-3h with scraping + enrichment + verification. Largest sprint by data volume.

---

## Sprint B — Repair 16 deleted Tony blocks (correctness + completeness)

**Goal:** Restore Tony nominations/wins data for the 16 Broadway shows whose tony blocks were deleted in commits `562740f8af` + `c9a1a396f7` because their stored data was misattributed.

**Affected shows:**
- Pre-2005 (NOT covered by `scrape-tony-awards.js` daily cron — these stay empty unless manually rebuilt):
  - `grease-1994` (1993-94 revival)
  - `fiddler-on-the-roof-1976` (1976-77 revival, Zero Mostel)
  - `purlie-1972` (verify shows.json openingDate — may be wrong, real production was 1970)
  - `play-on-1997`
  - `a-day-in-the-death-of-joe-egg-2003`
- 2005+ (will be re-populated by next April-June Tony cron run, but better to rebuild now):
  - `harvey-2012`, `on-golden-pond-2005`, `1776-2022`, `the-threepenny-opera-2006`, `hair-2011`, `angels-in-america-2018`, `a-view-from-the-bridge-2010`
- West End / OB (these should STAY empty — they're not Tony-eligible):
  - `a-month-in-the-country-west-end-2026`, `man-to-man-west-end-2026`, `oh-mary-west-end-2025`, `private-lives-2025`, `monte-cristo-the-york-theatre-company-off-broadway-2026`

**Approach:**
- For each pre-2005 show: scrape Wikipedia "YYYY_Tony_Awards" page for that ceremony year, extract the show's nominee + win record, write a fresh tony block.
- For each 2005+ show: same approach, but you can also wait for the next scrape-tony-awards.js cron run (April-June 2027) — manual rebuild is faster.
- Write to `data/awards.json` with the new validate-data gate active — it will catch any season-vs-openingDate mismatch.
- The canary test at `tests/unit/tony-attribution-canary.test.mjs` already pins the relabels (Boy from Oz, Red 2010) — DO NOT change those.

**Validation gates:**
- `node scripts/audit-tony-attribution.js` clean
- `node scripts/validate-data.js` clean (specifically: 0 Tony attribution errors, 0 unconfirmed-tie errors)
- `node --test tests/unit/tony-attribution-canary.test.mjs` 5/5 pass

**Acceptance:**
- Each of the 12 Broadway revivals has a verified tony block matching its actual ceremony record
- Demo URL renders Tony Awards section for each (visit `https://demo.broadwayscorecard.com/show/grease-1994` etc.)

**Estimated:** 1-2h, mostly verification time.

---

## Sprint C — NYDCC "no award" classification

**Goal:** Distinguish legitimate "no award given" years from genuine data gaps in NYDCC Best Play / Best Musical / Best Foreign Play.

**Current state:**
- NYDCC Best Play has 22+ missing years 1970-2026. Many are legit (NYDCC withholds awards regularly).
- No way to tell from data alone which is which.

**Approach:**
- Parse Wikipedia "New_York_Drama_Critics%27_Circle_Award_for_Best_Play" annotations.
- For each missing year, classify: "no award given" → add explicit null entry with `noAward: true`. "Truly missing" → flag for source verification.
- Extend `scripts/scrape-nydcc.js` to write null markers.

**Validation gates:** `node scripts/validate-data.js` clean.

**Acceptance:**
- NYDCC Best Play: 0 unclassified missing years (every gap is either filled or marked `noAward: true`)
- Same for Best Musical and Best Foreign Play

**Estimated:** 1h.

---

## Sprint D — DD Outstanding Play 1971-1974 + DL Outstanding Production of a Play 1977-1995

**Goal:** Fill specific known gaps in DD Play and DL Play coverage.

**Source:** BroadwayWorld DD archive + Drama League official site.

**Approach:** Targeted scrape for these year ranges only. Per-year UNION merge.

**Acceptance:**
- DD Outstanding Play: continuous 1971-2025 coverage
- DL Outstanding Production of a Play: continuous 1935-2025 coverage

**Estimated:** 30-45 min.

---

## Sprint E — Pulitzer file consolidation

**Goal:** Merge `data/precursors/pulitzer.json` + `data/precursors/pulitzer-historic.json` into a single file with unified schema.

**Approach:**
1. Audit both files for schema differences.
2. Write `scripts/consolidate-pulitzer.js` that merges into one file.
3. Update `scripts/enrich-awards-with-precursors.js` to read the unified file.
4. Delete `pulitzer-historic.json`.

**Validation:** `scripts/validate-data.js` + re-run enrichment, diff awards.json, ensure no Pulitzer data lost.

**Acceptance:** Single file, all existing Pulitzer attributions preserved.

**Estimated:** 30 min. Cosmetic / debt cleanup.

---

## Sprint F — New ceremony: OBIE Awards (Off-Broadway)

**Goal:** Add OBIE Awards (Off-Broadway, since 1956) as a tracked ceremony.

**Source:**
1. **Wikipedia "Obie_Award"** + per-category pages
2. **VillageVoice OBIE archive** (officially defunct since 2017 but archive still accessible)
3. **The OBIE Awards** (resumed 2022 under American Theatre Wing/Concord Theatricals)

**Approach:**
- New file `data/precursors/obie.json` matching existing precursor schema.
- New scraper `scripts/scrape-obies.js` (model on `scripts/scrape-drama-desk.js`).
- Extend `scripts/enrich-awards-with-precursors.js` to handle OBIE category names.
- Extend `src/lib/awards-scoring.ts` `classifyCategory()` for OBIE category vocabulary.
- Extend `src/components/AwardsCard.tsx` / `OtherAwardsPanel` to render OBIE section.

**Validation gates:**
- `node scripts/validate-data.js` clean
- `node scripts/audit-awards-data.js` no new HIGH severity issues
- Demo URL spot-check 3 OBIE-winning shows (Hamilton was OBIE-nominated, "Hadestown" workshop, etc.)

**Acceptance:** Demo render shows OBIE section on at least 50 historically-nominated Off-Broadway and Broadway shows.

**Estimated:** 2-3h.

---

## Sprint G — New ceremony: Lucille Lortel Awards (Off-Broadway)

**Goal:** Add Lortel Awards (Off-Broadway, since 1986).

**Source:** Wikipedia "Lucille_Lortel_Award" per-category pages.

**Approach:** Same pattern as Sprint F.

**Acceptance:** Demo render shows Lortel section on Off-Broadway shows that won/were nominated.

**Estimated:** 2h.

---

## Sprint H — UK ceremonies: Critics' Circle Theatre Awards + full Olivier extension

**Goal:** Fill UK awards coverage.

**Olivier:** Extend existing `scripts/enrich-olivier-awards.js`. Audit current coverage, fill gaps.
**Critics' Circle Theatre Awards:** New scraper, same pattern.

**Acceptance:** Demo render shows UK awards on West End shows that won/were nominated.

**Estimated:** 2-3h.

---

## Execution order (recommended)

1. Sprint B (1-2h) — restore Tony blocks first, highest visible-fix-per-hour. Reddit launch concern.
2. Sprint A (2-3h) — DD/OCC/DL sub-categories, largest data volume increase.
3. Sprint D (30 min) — DD Play + DL Play targeted gaps.
4. Sprint C (1h) — NYDCC classification.
5. Sprint F (2-3h) — OBIE (most-requested missing ceremony per audit).
6. Sprint G (2h) — Lortel.
7. Sprint H (2-3h) — UK ceremonies.
8. Sprint E (30 min) — Pulitzer consolidation (cosmetic).

**Total estimate:** 12-17h across 8 sprints. Run as autonomous loop, one sprint per cycle.

## Handoff prompt (paste into a fresh session)

```
/loop

Read memory/sprint-awards-completeness.md. Execute sprints in the recommended
order, one at a time. After each sprint: commit atomically, push, verify
deploy lands, update the Notion card with progress, move to the next sprint.

DO NOT stop between sprints. DO NOT ask for permission. DO NOT offer to hand
off. The user is explicitly hands-off until all 8 sprints complete or you hit
a real blocker (missing credentials, source-data not accessible after fallback
chain exhausted, would push session past 2h).

For real blockers: create a Notion sub-card with full context, then KEEP
WORKING on whatever remains unblocked.

Final wrap-up: post completion summary to Notion card, exit.
```
