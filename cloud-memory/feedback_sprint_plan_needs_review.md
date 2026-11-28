---
name: sprint-plan-needs-review
description: Multi-sprint plans authored without /plan-review almost always contain false premises about existing code or under-scoped sprints. Always run /plan-review before handing off.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8debe801-af8a-4b99-88e2-4398b678f90d
---

When authoring a multi-sprint plan (≥3 sprints, intended for autonomous /loop execution or hand-off to a fresh session), **always run `/plan-review` before declaring the plan ready.** Do not wait for the user to ask.

**Why:** On 2026-05-17 I authored an 8-sprint plan for awards data completeness without running /plan-review. The user had to flag it: "Shouldn't we have made a plan first and then got a plan review on it...? That feels like the normal border."

The 6-reviewer plan-review then surfaced 4 P0 + 5 P1 issues I missed:
- **Sprint B premise was factually wrong.** I claimed `scrape-tony-awards.js` only covers 2005+; the script actually has `START_YEAR=1970` (line 44) and `--year=YYYY` support (line 528). Codex caught this by reading the file. The entire "manual rebuild required for pre-2005" framing was wasted scaffolding.
- **F/G/H render path coupling under-budgeted.** `AwardsCard.tsx:254-356` hardcodes 4 ceremonies as parallel copy-paste; adding 3 new ones without first extracting a registry doubles the copy-paste debt. Design reviewer caught.
- **classifyCategory regex collision risk** — adding OBIE "Direction" could silently re-bucket existing Tony Direction wins. Pre-Mortem caught. Required adding golden-fixture parity test as Sprint 0 prereq.
- **Sprint E unnecessary** — Pulitzer consolidation was already happening in `enrich-awards-with-precursors.js:594`. Codex caught by reading the file.

Revised plan grew from 8 sprints (12-17h) to 14 sprints (14-20h). The extra ~2-3h prevented all 9 surfaced issues.

**How to apply:**
- When the work involves authoring a plan that another session will execute, `/plan-review` is non-negotiable. The autonomous session can't course-correct on premise errors mid-flight.
- For plans authored from prior `/right-problem` output, `/plan-review` is still required (different lens).
- The cost is ~5 min for 6 parallel reviewers; the prevented cost is hours of grinding on bad scaffolding.
- Per [[silent-merge-loss-on-reformat]] pattern: solo-authored plans tend to make assumptions about existing code (file paths, function signatures, year ranges, schema shapes) that turn out wrong. Codex / Design / Pre-Mortem reviewers reading the actual files catch these.

**When NOT required:**
- Single-sprint or single-task plans
- Pure data fixes with no architectural decisions
- Bugfixes following a clear repro
