---
name: ask-with-recommendation
description: "Every AskUserQuestion must lead with a recommended option marked \"(Recommended)\" — never present a neutral menu and force the user to do my synthesis."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 20a2d2fa-ff38-4aa7-bcf7-0f8c4c9f64ff
---

When using AskUserQuestion, ALWAYS:

1. Pick my preferred option first based on the evidence I just gathered
2. Put it as option 1 with `(Recommended)` appended to the label
3. Order the rest by next-best
4. Make the description for option 1 say *why* I'd pick it ("simplest", "matches the existing pattern", "second opinion confirmed", etc.)

**Why:** The user explicitly called this out 2026-05-16 after I dispatched a 4-option menu about hook strictness with no recommendation. Their words: "I don't like being asked these questions lately, when they don't come with a recommendation." Forcing the user to synthesize when I already have the relevant evidence wastes their attention and signals I'm dodging the call.

**How to apply:** Every AskUserQuestion call. If I genuinely cannot pick a recommendation, that's a sign I should keep researching, not punt to the user. The only exception is when the choice depends on user preference I can't infer (visual taste, business strategy, time budget) — and even then I should pick the safest default and say so.

**Cross-reference:** Tool spec itself documents this — `AskUserQuestion` description says: *"If you recommend a specific option, make that the first option in the list and add '(Recommended)' at the end of the label."* I'd been ignoring this.

**Anti-pattern (what NOT to do):**
> Q: "Which approach?"
> 1. Option A — does X
> 2. Option B — does Y
> 3. Option C — does Z

**Correct pattern:**
> Q: "Which approach?"
> 1. Option B (Recommended) — does Y, fastest path, matches existing pattern in scripts/lib/foo.js
> 2. Option A — does X
> 3. Option C — does Z

Related: [[feedback_terse_output_default]] (don't pad the question with reasoning the user can re-derive — just state the recommendation).
