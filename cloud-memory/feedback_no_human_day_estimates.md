---
name: no-human-day-estimates
description: "Don't quote human-day/half-day time estimates for assistant work; give realistic Claude-pace minutes instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b3a133cd-01f9-476c-9ab1-2983b58b3272
---

When estimating how long a small change will take that *I'm* doing, I default to human-engineer estimates ("half a day", "a couple hours") even though I work in minutes. The user called this out: "Half a day sounds way high but I'm guessing you're using human estimates here because you do that a lot" (2026-05-30, hook-shortening task).

**Rule:** For work I'm executing myself, estimate in actual Claude-pace wall-clock — typically minutes for text edits / config changes, tens of minutes for multi-file refactors, longer only when bounded by external waits (CI runs, deploys, LLM rate limits, large rebuilds). Don't anchor on human-engineer time.

**How to apply:**
- "10–15 min" not "half a day" for hook editing, regex tweaks, small refactors.
- For genuinely bounded work (full ship-check + reviewers, multi-deploy verification, large data backfills) say what the bottleneck is — "~3 min wall but bottlenecked on the CI run, ~8 min".
- Skip estimates entirely for tiny changes ("quick edit" or just do it).
- Reserve "hours" / "days" for things that legitimately exceed those bounds (CI dispatch chains, multi-show data audits, etc.), and explain why.
