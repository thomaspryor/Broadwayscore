---
name: feedback-returning-production-priorruns
description: "A returning/transferring production shows few reviews because majors reviewed the earlier run and didn't re-review; declare priorRuns on the show entry to re-include the prior-run reviews."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5069eb8a-8362-42e1-8109-2bc515299bd5
---

**When a West End (or any) show is a RETURN/TRANSFER of the SAME production and
shows suspiciously few reviews (all minor outlets), the majors reviewed the EARLIER
run and didn't re-review the return — their prior reviews are sitting flagged
wrongProduction purely by the DATE guard. Declare `priorRuns` on the show's
shows.json entry to re-include them.** (2026-07-05, To Kill a Mockingbird WE 2026.)

TKAM 2026 Wyndham's = return of the 2022-23 Gielgud run (same Bartlett Sher/Sorkin
production; Richard Coyle played Atticus in both). Site showed 6 reviews, all
mid-tier blogs, ZERO T1 majors. The Guardian/Standard/Time Out 2022 reviews were in
the folder flagged `wrongProduction` with note "Date guard: review 2022-04-01 is 1525
days before opening 2026-06-30" — flagged ONLY because the date is 2022.

**Mechanism (already exists, don't reinvent):** `isWithinPriorRun(date, show.priorRuns)`
in scripts/lib/wrong-production-autoclear.js exempts reviews dated within a declared
prior run; `shouldAutoClearWrongProductionPriorRun(d, show)` auto-clears the stale
flag at rebuild time. Comment: "legitimate coverage of an earlier staging, not a
wrong-production cross-attribution."

**Schema (EXACT — getting it wrong is a silent no-op):**
```json
"priorRuns": [{ "openingDate": "2022-03-01", "closingDate": "2023-05-31", "venue": "Gielgud Theatre" }]
```
Fields are `openingDate`/`closingDate`/`venue` — NOT start/end/label. isWithinPriorRun
reads run.openingDate/closingDate and `continue`s if openingDate is undefined → window
never matches → nothing clears. Real examples in shows.json: my-neighbour-totoro-west-end-2025,
music-city-off-broadway-2026, rheology-off-broadway-2026.

**Why it self-scopes correctly:** priorRuns exempts only the DATE guard. Other-market
prior runs (e.g. TKAM's 2018 Broadway US reviews) stay OUT via the SEPARATE "US-only
outlet" market guard, which priorRuns doesn't touch. So a UK-run window recovers UK
majors without dragging in US reviews (which belong to the Broadway entry).

**How to do it:**
1. shows.json is in the private core-data repo `thomaspryor/broadway-scorecard-data`
   (local clone ~/broadway-scorecard-data; hardlinked to main repo's data/shows.json).
   Edit + commit + push THERE. reviews.json is derived — `git checkout reviews.json`
   before rebase (don't commit local derived copy).
2. Verify BEFORE push: `shouldAutoClearWrongProductionPriorRun(file, show)` returns true
   for each expected file (targeted check on the real files).
3. `scoring-delta.js` is NOT the right check — it compares working-tree CODE vs HEAD
   CODE (for scoring-LOGIC edits); a shows.json DATA change shows zero flips. The right
   verification is the rebuild's actual TKAM count. priorRuns is per-show so no other
   show can be affected.
4. Trigger `rebuild-reviews.yml` → checks out core-data, auto-clears, rebuilds, deploys.

**Editorial call (the USER's, surface it):** the prior reviews' PROSE describes the
earlier run's lead (TKAM 2022 = Rafe Spall's Atticus; 2026 = Coyle). The critical
VERDICT/score carries (same production), the performance prose is dated. Composite
dips slightly (2022 majors gave 80-85 vs 2026 raves 88) — more honest. Only apply to a
genuine SAME-production return, NOT a new revival by a different creative team. Related:
[[feedback_stale_flag_collision_drops_current_production.md]], [[feedback_same_title_disambiguation.md]].
