---
name: Regex lookahead boundary must be LESS greedy than the capture
description: When extending a capture (e.g. allowing optional leading initial), keep the boundary lookahead at the original 2-word minimum shape — including the optional 3rd word in the lookahead changes where the previous quote ends and absorbs trailing context.
type: feedback
originSessionId: 025760e3-f28f-4371-ba24-b9ce9d7bf038
archived: true
---
The BWW articleBody regex captures `Critic Name, Outlet: quote` then uses a lookahead to find where the next critic starts (the boundary that ends the current quote). When extending the capture to allow new shapes, **the lookahead must NOT also accept the new shape unless the boundary semantics demand it.**

**Why:** Caught 2026-04-26 in `scripts/lib/bww-roundup-parser.js`. I copied the 3-word capture pattern (`NAME_WORD MIDDLE_INITIAL \s+ NAME_WORD (optional 3rd)`) into the lookahead too. That made the lookahead match earlier in the text — at "Faith" instead of "Joe" in "...Leap of Faith Joe Dziemianowicz, NY Daily News:" — so the previous quote ended before "Faith" and the next match captured "Faith Joe Dziemianowicz" as one critic name. 1 regression in the parity diff (a-bronx-tale-2007.html). Fixed by keeping the lookahead at 2-word minimum (no optional 3rd), matching the pre-fix lookahead shape.

**How to apply:** When changing a parser regex with a lookahead boundary:
1. Diff old vs new pattern: capture group AND lookahead group.
2. The lookahead's job is "find the *earliest* plausible next-match position." It should require the *minimum* shape that uniquely identifies a boundary.
3. The capture's job is "match as much as possible at this position." It can be more permissive.
4. After any change, run a parity diff against real corpus (e.g. all 926 BWW archives) — if any single capture now has an *extra* leading word (vs the old result), the lookahead is too greedy.

General rule: **the boundary is a `find`, not a `match`.** Don't widen what counts as a boundary just because you widened what counts as a match.
