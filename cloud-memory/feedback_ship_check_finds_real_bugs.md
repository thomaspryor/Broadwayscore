---
name: Ship-check subagent finds bugs tsc/lint/tests miss
description: "Opus subagent catches bugs tsc/lint/tests miss — never skip."
type: feedback
originSessionId: 7abba0e9-5567-4883-b414-562f6136cd37
---
`/ship-check`'s subagent review phase is load-bearing, not optional — even on "small" UI changes.

Concrete case (2026-04-11, ScoreBreakdownBar on show page): shipped the feature after passing `npx tsc --noEmit`, `npx next lint`, 15 passing unit tests, two rounds of manual Playwright visual QA at mobile+desktop, and live-site DOM inspection. Then ran `/ship-check` post-ship.

The subagent ran a data-driven simulation over `public/data/shows/*.json` and found **three real P1 bugs** I'd shipped:

1. **14 live shows with a ghost 1% red "Negative" sliver** from compound-rounding absorb (hamilton-2015, arcadia-2011, fela-2009, etc.)
2. **null/NaN scores silently classified as Negative** via `Math.round(null)=0 < 55` — no crash, no error, just wrong tier
3. **Screen readers reading the responsive duplicate copies twice**

None of these would be caught by:
- TypeScript (types were valid)
- ESLint (no rule for them)
- Unit tests (my original 15 tests covered the classifier but not the allocation or ingestion edge cases)
- Visual QA on a single show (the ghost sliver is 1% — easy to miss on one show, impossible to miss when grepping 1,470 shows)
- My own code review (I wrote the bug)

**Why:** Ship-check's subagent is fresh eyes with codebase access + data access. It writes queries, grep-greps, and reads actual JSON files. That's orthogonal to the checks I run myself and catches a specific class of bug that the other checks miss by design.

**How to apply:** Always run `/ship-check` after an implementation session that touched `src/`. Don't rationalize skipping it ("it's a small change", "the tests passed", "I already QA'd it"). The subagent is especially good at:
- Data-driven simulations across all production data
- Spotting rounding/precision bugs
- Finding guard duplications between responsive/feature-flag branches
- a11y issues with duplicate DOM renders

If the subagent finds P0/P1 issues after shipping, the fix is more commits, not an argument about whether the bug is "really" a bug. The production data is the spec — if it misrenders on any live show, it's a bug.

**Second concrete case (2026-04-21, opening-night bypass prevention plugins):** Shipped 6 new plugins at `scripts/lib/opening-night-checks/*.check.js` after `/second-opinion` approved the plan, all 276 unit tests green, CI Unit Tests passed. Ran `/ship-check` post-merge. Subagent found **4 P0 silent-pass bugs** in infrastructure code (not UI):
1. Broken regex char class `[-.*+?^${}()|[\\]\\\\]` — `\\]` closed the class early, so most slug metacharacters (`$`, `(`, `|`) were never escaped before being inlined into a `new RegExp()` constructor
2. `haystack.length < 80` gate silently passed paywall stubs (~25 chars) that should have been flagged
3. Violation skip when `data.url` missing — bypass for older source files without url field
4. `!published` silent skip — null publishDate on shipped opening-night review should warn

**All four were `return ok=true` on a missing-field path** — the kind of defensive coding that looks reasonable but inverts the gate's purpose. Tests passed because the fixtures all had the fields set. The bugs only surface on real-world edge data.

**Generalization:** ship-check catches bugs in ANY merged code, not just UI. Infrastructure code (guards, validators, parsers) has its own class of bug the subagent is good at: "returns ok=true when the input lacks a field we expected" where the expected field is sometimes absent in real data. tsc/lint/tests all stay green because the path executes cleanly — it just executes wrong.

**Third concrete case (2026-04-27, collect-review-texts file-rename helper, PR #290):** Shipped a renameReviewFileToMatchCritic helper + 3 wirings + 4 unit tests after independent review by a general-purpose Agent (verdict: SHIP-WITH-CAVEATS, the agent reviewed the helper in isolation). Merged. THEN ran /ship-check. Codex's adversarial review found a **P0 the Agent missed**: the helper merges source into dest, then the caller's continuation at `collect-review-texts.js:5069` writes `data` (source's in-memory object) to `review.filePath` — which now points at the merged dest. **Net effect of every merge action: source deleted, dest clobbered with source's data, dest unique fields lost.** The Agent reviewed the helper as a unit; Codex traced the integration with the caller. Result: PR reverted within 30 min via PR #291.

**Lesson:** /ship-check's value is the **adversarial Codex round** specifically. It's the only reviewer that consistently traces helper-vs-caller integration paths. The general-purpose Agent reviewer evaluates correctness inside the diff; Codex evaluates whether the diff's effects survive the surrounding code's continuation. **Run /ship-check BEFORE merge, not after.** If the post-merge ship-check finds a P0, the cost is a revert PR cycle (~90 min in this session). Pre-merge ship-check would have caught it in 3 min.
