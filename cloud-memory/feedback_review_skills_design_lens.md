---
name: /plan-review and /second-opinion now check design quality, not just correctness
description: "/plan-review and /second-opinion now check design quality too."
type: feedback
originSessionId: c7e55600-9e8d-468b-9f85-de2eda90226d
archived: true
---
**Background:** Sessions repeatedly used `/plan-review` and `/second-opinion`, got "ready to implement," shipped working code, and the code became tech debt within weeks. Investigation (2026-04-10) confirmed both skills' agent prompts were correctness-only — `/second-opinion` had 6 questions all about "will it compile / break / miss callers"; `/plan-review`'s 5 reviewers covered production failures, structure, pre-mortem, consistency, and user impact, but NONE were dedicated to "is this the right shape of code for this codebase?"

**Fix shipped (2026-04-10):**

`/second-opinion` agent prompt restructured into two equally-weighted parts:
- **PART 1 — WILL IT WORK?** (the original 6 correctness questions)
- **PART 2 — IS IT WELL DESIGNED?** (new 6 design questions: codebase fit / inconsistency tax, wrong abstraction, wrong layer, deletion cost, aging, API surface & naming)
- Output format split into `CORRECTNESS BLOCKERS` and `DESIGN BLOCKERS` columns so design issues cannot hide behind a clean correctness pass
- Verdict explicitly distinguishes the two: "Fix N correctness blockers" / "Fix N design blockers" / "Rethink approach"
- Mandatory pre-reading: agent must read 1–3 SIMILAR files in the codebase before reviewing — a design review without seeing the existing patterns is worthless

`/plan-review` got a 6th reviewer: **Code Design & Maintainability** (Claude Task agent with file access). It runs in parallel with the existing 5. Critical traits:
- Mandatory file reading before review (current files + 2–3 similar features for pattern context)
- 10 design lenses: codebase fit, wrong abstraction, reinventing primitives, wrong layer, coupling/deletion cost, aging, API surface, naming, test surface, delete-and-rewrite test
- Output requires `EXISTING PATTERNS YOU FOUND` references with file:line so the critique is grounded
- Phase 4 consensus weighting: **a solo design finding from this reviewer is high signal, not low signal** — it's the only reviewer qualified to spot wrong-shape issues, so its findings get full weight even when no other reviewer raises them
- Skill description updated so it's discoverable: "Six independent reviewers — covering correctness, structure, failure modes, consistency, user impact, AND code design"

**Smoke tests (against deliberately bad-design plan via GPT-4o):**
- `/plan-review` design reviewer prompt: caught 5/8 deliberate smells (wrong layer, hardcoded brand color, premature abstraction, coupling, API surface). The 3 it missed were ones that require actual file access (directory pattern, switch coupling, hardcoded list scaling) — the real reviewer is a Claude Task agent with file access, so it'll do better than this curl-only smoke test.
- `/second-opinion` two-part prompt: produced **3 correctness blockers AND 3 design blockers**, with verdict "Fix 3 correctness blockers, Fix 3 design blockers." Exactly the desired behavior — design issues are tracked separately and cannot hide behind correctness.

**How to apply / when to use:**
- For ANY plan touching `/src/` or `/scripts/` that's >1 file or introduces new abstractions, design quality matters as much as correctness. Use `/second-opinion` for quick 1–4 file plans, `/plan-review` for anything larger or architecturally significant.
- If a session runs one of these skills and the agent's output only has correctness findings (no `DESIGN PROBLEMS` / `DESIGN BLOCKERS` section populated), that's a red flag — the agent didn't read the existing code or didn't do the design lens. Re-run with an instruction to "read 2 similar files first."
- The design reviewer is the *only* one that can catch "works but bad design." Don't accept a `/plan-review` output that's missing the `Code Design & Maintainability` section.

**Test fixtures:** `/tmp/skill-test/bad-design-plan.txt` is a known-bad plan with 8 deliberate design smells. Re-run the smoke tests against this plan whenever the prompts are touched, to confirm the design lens still surfaces real findings.
