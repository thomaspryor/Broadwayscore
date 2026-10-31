---
name: three-model-audit-modality
description: "Vision-only models hallucinate \"missing\" data in audits; pair with a code-reading model"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ed01c2ad-8952-416f-be83-ac5b273583e7
---

For multi-model UI/data audits, **pair vision-only models with at least one model that reads the source code.** Vision-only models (GPT-4o, Gemini on screenshots) systematically false-positive on "X is missing from screenshot" findings because they didn't capture every scroll position. Code-reading models (Claude subagent with file access) catch logic bugs the vision models miss entirely.

**Why:** On the 2026-05-20 Tony Nominations Center audit, GPT-4o and Gemini *both* flagged "Fallen Angels missing from Best Revival of a Play" as P0 — it was actually rendering correctly, just below the scroll fold in the screenshots. Meanwhile, the Claude subagent (with file access) was the only one to find the two real P0/P1 bugs: trailing-space GD persons keys (silent lookup miss) and 9 missing GD_TO_TONY craft category mappings (real data shown as "—"). Neither vision model could have found these — they're logic bugs in code paths the screenshots don't expose.

**How to apply:**
- Use vision models (GPT-4o, Gemini) for: visual hierarchy, alignment, copy, mobile UX, missing affordances
- Use a code-reading model (Claude subagent) for: data-layer bugs, mapping gaps, dead code paths, type/logic issues, "what shouldn't be on this page that is" inversions
- **Verify any "X is missing" finding from a vision model by direct grep/curl before reporting it.** Vision models confuse "I didn't see it" with "it isn't there."
- Take full-page screenshots OR multiple scroll positions — but still verify missing-content claims.

**Related:** [[two-model-ui-review]] — for pure "would this embarrass me" UI/copy reviews, vision models alone are fine. This rule applies when data correctness is part of the audit.
