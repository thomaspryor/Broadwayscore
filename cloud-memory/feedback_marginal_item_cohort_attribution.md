---
name: Marginal-item attribution needs cohort detection on shared sort keys
description: When blaming a single item for crossing a budget/cap, items sharing the marginal sort key form a cohort — attribute to the cohort, not arbitrarily one item.
type: feedback
originSessionId: dd661dcd-ed5f-43a1-b29e-a04b1aa041d3
archived: true
---
When you walk an ordered list (sorted by some key) and identify "the item that pushed N over a budget", any items sharing that key with the marginal item are equally responsible. Picking one to blame is arbitrary and depends on tiebreaker order — which is often unstable across runs (CI vs local, language sort order, random hash seeds).

**Why:** Caught in /ship-check 2026-04-27 on `scripts/opening-night-budget-preflight.js`. First version sorted shows by `openingDate.localeCompare()` alone. When 4 shows opened the same date and the cohort exceeded the Browserbase 30-session/day cap, the Discord alert blamed one ID arbitrarily. The QA review's exact line: "Two shows opening the same night get an arbitrary order, and findCulpritForResource blames whichever lands at the marginal index."

**How to apply:**
- Add a deterministic tiebreaker to the sort (e.g. id ASC) so the marginal index is reproducible.
- After identifying the marginal item at index i, check whether other items in the list share its sort key. If yes, switch the attribution from `{type: 'item', id}` to `{type: 'cohort', sortKey, ids, label}`.
- Render cohort labels distinctly: "cohort opening 2026-05-05 (3 shows)" beats "show-x" when the user needs to act (the action is "delay/serialize the cohort", not "blame show-x").
- Build the culprit map ONCE and reuse it for every output channel (stdout, alert text, JSON). Recomputing risks the culprit-set drifting between channels under non-determinism.

**Pattern outside this project:** any "marginal cost" or "marginal contributor" attribution — billing alerts, capacity alerts, dependency-graph blame, error-rate spike attribution. If your sort has shared keys, you have shared-blame.
