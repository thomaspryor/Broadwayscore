---
name: sprint-awards-completeness
description: Revised sprint plan for filling all awards data completeness gaps. Post-6-reviewer-plan-review. Handoff-ready for autonomous /loop execution.
metadata:
  type: project
---

# Sprint: Awards Data Completeness (revised post-plan-review)

**Status:** Not started — handoff to a fresh autonomous-loop session.
**Origin:** 2026-05-17 LLM audit (Gemini 2.5 Pro + GPT-4o) after correctness fix (commits `562740f8af` + `c9a1a396f7`).
**Plan-review:** 2026-05-17 — Codex (production+arch), Claude (structure), Pre-Mortem, Gemini (consistency), User Impact, Design. 4 P0s + 5 P1s addressed.

## Why this exists

The Tony attribution sprint fixed *wrong* data. This plan fixes *missing* data.

Per user: "make a sprint plan to just get through all of those data gaps without me needing to babysit it."

## Operating rules (read first)

- **CLAUDE.md compliance** — worktree-first for `src/` / `scripts/` / `.github/workflows/` edits, scoring-delta gate if touching scoring code, validate-data gate before commit.
- **Existing infrastructure first** — `scripts/lib/scraper.js fetchPage()`, `scripts/lib/precursor-wikipedia.js writePrecursorJson()` (shrink-guard at line 217 — use it).
- **Validate-data is your gate** — `node scripts/validate-data.js` after every data write.
- **Atomic commits** — parallel sessions silently clobber single-commit fixes (`memory/feedback_silent_merge_loss_on_reformat.md`).
- **Pause competing crons** — Sprint 0 disables `update-tony-awards.yml`. Sprint Z re-enables.

## Sprint 0 — Pre-flight + scaffolding (1.5h, NEW from plan-review)

**Premise:** Original plan claimed `scrape-tony-awards.js` only covers 2005+. **FALSE.** `scrape-tony-awards.js:44` has `START_YEAR=1970` and `:528` supports `--year=YYYY`. Verify before building.

**Tasks:**
1. `node scripts/scrape-tony-awards.js --year=1994 --dry-run` — confirm pre-2005 coverage works. If broken, fix BEFORE Sprint B.
2. Pull 9 BWW sample pages (DD/OCC/DL × 1970s/1990s/2010s) via `fetchPage()`. Confirm parseable. If BWW redesigned/blocked, escalate to Notion sub-card BEFORE Sprint A.
3. Extract `scripts/lib/per-category-precursor.js` — shared template. `scrape-drama-desk.js` and `scrape-outer-critics.js` differ in ~6 lines (PAGES + filename). Pulls scaffolding so F/G/H become 15-line configs.
4. Extract `src/config/ceremonies.ts` — UI ceremony registry. `AwardsCard.tsx:254-356` quadruplicates DD/OCC/DL/NYDCC; refactor to `.map()` over registry. Deletion cost: 5+ files → 1 array entry.
5. Lock `classifyCategory()` with `tests/unit/classify-category-golden.test.mjs` — all current Tony/DD/OCC/DL/NYDCC inputs → unchanged outputs. **Required BEFORE F/G/H** to catch regex-collision corruption (Pre-Mortem flag: OBIE "Direction" silently re-bucketing existing Tony Direction wins).
6. Sync `scripts/lib/classify-category.js` ↔ `src/lib/awards-scoring.ts` — parity canary.
7. Add `data/**` + `scripts/scrape-*.js` to `.github/workflows/test.yml:4` push.paths. Currently excluded — CI gate doesn't fire on awards commits.
8. `gh workflow disable update-tony-awards.yml` (and any other awards-cron writers — grep `.github/workflows` for `awards.json`).
9. Confirm `npm run data:check` passes.

**Acceptance:**
- Tony scraper --year=1994 returns ≥5 nominees
- 9 BWW sample pages parse
- Golden-fixture + parity tests pass
- test.yml diff shows awards paths added
- `gh workflow list` shows tony cron disabled

---

## Sprint B — Pre-2005 Tony repair (was 1-2h, now 30 min)

**Plan-review fix:** "Manual rebuild required" was false. Use existing scraper.

**Tasks:**
1. For each of 16 deleted Tony shows, derive ceremony year from openingDate.
2. `node scripts/scrape-tony-awards.js --year=YYYY` per dedup'd year.
3. validate-data clean, audit-tony-attribution clean, canary 5/5.
4. Add **17-entry deny-list canary** at `tests/unit/tony-deny-list.test.mjs` — assert the misattributed `(showId, season, win)` triples from today never reappear.
5. WE/OB shows stay empty (validate-data gate enforces).

---

## Sprint A — DD/OCC/DL sub-category fill (split A1/A2/A3, total 6-9h)

**Plan-review fix:** Original 2-3h was 3-4× under-scope. Split per ceremony.

### A1 — DD sub-categories 1975-2022 (2-3h)
- Use shared lib from Sprint 0 + BWW fallback when Wikipedia returns 0
- Per-year UNION merge via `writePrecursorJson()` (shrink-guard built-in)
- **Structural assertion**: if sub-cat returns 0 from BWW but baseline ≥5, throw
- **Budget**: `SB_CREDIT_BUDGET=400`
- **Acceptance**: DD Direction of Musical ≥30 yrs (currently 3); DD Choreography ≥30 yrs; 5-show spot-check (Annie/Dreamgirls/Phantom/Wicked/Hamilton)

### A2 — OCC sub-categories pre-2022 (2-3h)
- Same pattern. **Acceptance**: OCC Director of Musical ≥20 yrs.

### A3 — DL sub-categories pre-2022 (2-3h)
- Same pattern. **Acceptance**: DL Direction of Play ≥10 yrs.

---

## Sprint D — DD Play 1971-74 + DL Play 1977-95 (30-45 min)

Targeted fills via shared lib. No new scrapers.

---

## Sprint C — NYDCC noAward classification (was 1h, now 1.5h)

**Plan-review fix:** Schema-first or `noAward` markers render as "missing data."

1. Extend `NyDramaCriticsAwards` in `src/lib/data-types.ts:255` with `noAward?: boolean`
2. Extend `OtherAwardsPanel` in `src/components/AwardScoreCard.tsx` to render "No award given" chip
3. Update `scoreCeremony()` at `awards-scoring.ts:203` to skip noAward entries
4. THEN populate from Wikipedia

---

## Sprint F — OBIE Awards (split F1/F2, 2.5h)

### F1 — OBIE scaffolding (1h)
- Add OBIE to `src/config/ceremonies.ts` registry
- Extend `classifyCategory()` — golden-fixture parity test MUST still pass
- Extend `enrich-awards-with-precursors.js` category map (1 line via `applyDDOCCDL` template)
- Stub `data/precursors/obie.json` empty array
- Unit test pinning ≥1 OBIE classification

### F2 — OBIE data ingestion (1.5h)
- `scripts/scrape-obies.js` as 15-line config on shared lib
- Source: Wikipedia per-category pages, fallback VillageVoice archive
- Populate obie.json from 1956+
- **Acceptance**: Demo renders OBIE section on ≥50 shows. F1 golden-fixture still passes.

---

## Sprint G — Lortel Awards (split G1/G2, 2h)

Same pattern as F. Lortel since 1986.

---

## Sprint H — UK awards (split H1/H2, 2-3h)

### H1 — Olivier extension (1h)
- **First grep** `data/precursors/*.json` categories vs `classifyCategory()` — most UK terms likely already classify (Design reviewer flag).
- Extend `scripts/enrich-olivier-awards.js` for identified gaps.

### H2 — Critics' Circle Theatre Awards (1.5-2h)
- New pipeline via shared lib (config only).

---

## Sprint Z — Re-enable crons + final verify (15 min)

- `gh workflow enable update-tony-awards.yml` + other paused crons
- Verify next cron run doesn't clobber sprint work
- Update Notion card with final summary

---

## Execution order

`0 → B → A1 → A2 → A3 → D → C → F1 → F2 → G1 → G2 → H1 → H2 → Z`

**Total:** 14-20h across 14 atomic sprints.

## Handoff prompt

```
/loop

Read cloud-memory/sprint-awards-completeness.md. Execute sprints in
the listed order, one at a time. After each sprint: commit atomically
(script + data + tests in ONE commit), push, verify deploy lands,
update Notion card 363637c5-416f-8109-9afe-d18e215942ca with progress,
move to the next.

DO NOT stop. DO NOT ask permission. DO NOT offer to hand off. Continue
until all 14 sprints complete or you hit a real blocker (missing
credentials, source-data unavailable after fallback exhausted, would
push session past 2h).

For real blockers: create a Notion sub-card with full context, then
KEEP WORKING on whatever remains unblocked.

CRITICAL: Sprint 0 is mandatory pre-flight. Do NOT skip to Sprint B.
Sprint 0 verifies Sprint B's premise and lays scaffolding F/G/H depend
on. If Sprint 0 reveals scrape-tony-awards.js doesn't actually cover
pre-2005 or BWW is unreachable, escalate via Notion sub-card immediately.
```

## Plan-review changes (vs original)

| Change | Reason | Source |
|---|---|---|
| Sprint 0 added | F/G/H render coupling + classifyCategory collision risk | Design + Pre-Mortem |
| Sprint B reframed (use --year=) | scrape-tony-awards.js already covers 1970+ | Codex + Design + Gemini |
| Sprint A split A1/A2/A3 | Original 2-3h was 3× under-scope | Codex + Devil's Advocate + Gemini |
| Sprint C schema-first | noAward without UI was invisible | Codex + User Impact |
| Sprint E deleted | Pulitzer merge already in enrich-awards-with-precursors.js:594 | Codex |
| F/G/H split scaffolding + data | classifyCategory test must come first | Design + Pre-Mortem |
| Sprint Z added | Sprint 0 disables crons; explicit re-enable required | Devil's Advocate |
| Sprint B 17-entry deny-list canary | Re-scrape risks re-introducing today's bugs | Devil's Advocate |
| A1/A2/A3 BWW DOM contract test | "BWW broke scrape-alltime for 2 months in 2026-Q2" | Codex + Design |
| BD/SB credit budget guard | 47-yr × 3-award sweep could nuke budget | Devil's Advocate |
| test.yml push.paths fix | Awards commits weren't triggering CI gate | Codex |

**Verdict:** Sprint 0 is the keystone — if pre-flight fails, the loop session escalates instead of grinding forward on broken assumptions.
