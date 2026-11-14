---
name: Always wait for async operations
description: Never end a turn while a dispatched workflow, deploy, or rebuild is still in progress. User confirmed this preference 2026-04-25.
type: feedback
originSessionId: 66add4a9-4817-4099-a620-3023958a503b
---
When I dispatch async work (gh workflow run, deploy, scoring batch, rebuild, anything that returns a run ID), I must monitor it to completion before ending the turn. "Should be fine" / "kicked off, will land in next deploy" is not acceptable handoff language.

**Why:** User said "Yes always wait" on 2026-04-25 after I asked whether to wait for LLM scoring + rebuild + deploy or call it good. CLAUDE.md global rule already says "Kicked off ≠ done" but the user reaffirmed it explicitly when given the choice — preference is the strict reading.

**How to apply:**
- After any `gh workflow run` or `vercel deploy`, set up a Monitor (state-change-only filter) and wait for terminal status.
- After workflow completes, verify the actual output (reviews.json shows the new entries, deploy returns 200, etc.) — completion ≠ correctness.
- If the wait would exceed ~30 min, say so explicitly and ask before stopping. Do not silently stop.
- This applies even if the next thing the user might ask is unrelated; the async work I started must reach a terminal verified state before I move on.
