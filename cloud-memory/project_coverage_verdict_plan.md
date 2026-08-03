---
name: coverage-verdict-plan-approved
description: "Coverage Verdict system plan FULLY APPROVED (Option A, all sprints S0-S5) by owner 2026-08-02 — do not re-ask; chain must run to completion without owner intervention"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0bb4f0cb-c00e-4d66-a31b-8aef1dea1697
  modified: 2026-08-03T03:30:51.607Z
---

Owner approved the FULL Coverage Verdict plan (Option A: S0–S5) on 2026-08-02, with an explicit mandate: "make sure this does not get lost mid-way or unfinished — it needs to happen all the way through without my intervention." Do NOT re-ask for approval of any sprint.

Plan document: `~/Documents/claude-outputs/coverage-verdict-system-plan-2026-08-02.md` (six-reviewer revised v2).

Execution chain (task numbers in the shared store, cards in Notion with acceptance criteria + chain-forward instructions in their notes):
- S0 = task #902, S1 = #901 (dispatched 2026-08-02, headless Opus — cmux launcher broken, task #900)
- S2 = #906 (blocked by 901+902) → S3 = #905 (blocked by 906)
- S4 = #904 (blocked by 902, parallel to S2/S3) → S5 = #903 (blocked by 904+905)
- S5 ends PAUSED with RECHECK-AFTER (2-week seeded adversarial probe window) via autonomous-acceptance-recheck — never claimed Done early.

**Why:** ~150 coverage gaps found by the owner via naive Googling; this plan is the systemic fix (fail-open verdicts, private exclusion reasons, recall measurement, email gate with swap-and-report). Ten+ prior sessions claimed fixes Done that never held — hence the chain-forward cards and falsifiable S5 acceptance.

**How to apply:** If you find any Coverage Verdict card (search Notion for "Coverage Verdict") pending with its blockers Done and no live worker on it, dispatch it (bsc-next, headless fallback per [[feedback_github_polling_rate_limit]] era launcher breakage #900). Each card's notes carry its own CHAIN instruction to dispatch the successor. Related: [[project-session-system-v2-overhaul]].
