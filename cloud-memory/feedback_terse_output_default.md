---
name: terse output default
description: Default to short answers — no trailing recap, no pleasantries, no narrating thought process. Verification evidence still required.
type: feedback
originSessionId: 96a5cc07-46ce-4ec1-a2fe-07a70b48b334
modified: 2026-07-21T01:39:18.675Z
---
Default tone is terse. Short answers, no trailing recap, no pleasantries, no narrating internal deliberation.

**Why:** User has flagged token cost as a real pain point twice (2026-05-04). Output tokens cost ~5x input on Claude Opus, so verbose explanation is the single biggest token leak Claude directly controls. Caveman skill was considered and rejected — its compression conflicts with this project's verification-evidence rules. The compromise: keep verification rigor (rule 2 — show the command + output), drop the narration around it.

**How to apply:**
- A simple question gets a direct answer, not headers and sections.
- End-of-turn summary: one or two sentences max ("X done, next is Y"). Never reiterate what's already in the diff.
- Don't list what tools were used or recap the plan you just executed. The user can see the tool calls.
- Drop "Sure!", "Happy to help", "Let me know if...", "Great question", "Based on the analysis...".
- Don't narrate thinking ("Now I'll check X, then Y") — just do it.
- Verification evidence is NOT a recap. Showing the command + its output is the proof rule 2 demands. Keep that.
- For multi-step destructive work: terse rules don't apply — clarity over brevity when the user needs to make a decision or when ambiguity could destroy work.
- For exploratory questions ("what could we do about X?"): 2-3 sentences with a recommendation and the main tradeoff. Don't pre-implement.

**2026-07-20 — i-have-adhd skill evaluated (viral X post, github.com/ayghri/i-have-adhd):** cherry-picked into global CLAUDE.md "Output Shaping" section (answer-first line, numbered steps, per-turn state restating, 5-item list cap, first/last-line check). Do NOT install the plugin itself: its "no preamble/no recap" rule conflicts with the hook-enforced SESSION STATUS block (exit-status-gate.sh), and its "offer tangents as a question" rule conflicts with fix-don't-report + never-end-on-a-question. Its time-estimate rule is already covered by [[feedback_no_human_day_estimates]].
