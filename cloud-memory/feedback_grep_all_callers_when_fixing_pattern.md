---
name: Grep ALL callers when fixing a bug class, not just the "biggest" callers
description: When extracting a helper or adding a pattern (Cloudflare detection, title-match, dedup), grep every caller of the containing function/module and verify the pattern lands everywhere. Unit tests on the helper don't catch integration gaps.
type: feedback
originSessionId: 074db50f-1651-4986-98f8-5b1abe14fd3d
archived: true
---
When a bug class spans multiple call sites, fixing it requires TWO passes:

1. Build the helper / pattern.
2. Grep EVERY caller of the surrounding function and verify the pattern is applied at each one.

Unit tests validate the helper in isolation. They do NOT catch "helper exists but 3 of 5 callers forgot to use it" — and ship-check reviewers specifically hunt for that gap.

**Why (two cases from the same Session 1, 2026-04-24):**

1. **Callers of a shared helper.** Shipped `isCloudflareChallenge()` wired into 2 of 5 BWW fetch sites in `gather-reviews.js`. 21 unit tests green. Ship-check review found the 3 missed sites (Priority 0 runtime override, Priority 1 manual override, Priority 2.5 homepage). Follow-up commit 190dd3fc0d applied the pattern everywhere.

2. **Parallel implementations in peer functions.** Even after fix #1, an end-to-end probe against `hamlet-off-broadway-2026` revealed `scrapeBWWRoundupWithPlaywright` had its OWN internal Cloudflare-title check that silently returned `null` — a third parallel implementation that wasn't a "caller" of the helper at all. 27 consecutive Playwright CF hits before the fallback took over. Follow-up commit 00ee1da6dc made the Playwright function return a structured `{ cloudflareChallenge: true }` signal so callers break the loop.

**How to apply:**
- When adding a pattern (guard, short-circuit, validator) to a function, grep (a) every call site of that function AND (b) every peer function with the same responsibility. Both lists matter.
- `grep -n "searchAggregator\|fetchPage\|scrapeX" <file>` plus `grep -n "<symptom-string>" <file>` — e.g., for Cloudflare work, also `grep -rn "Just a moment\|cf_chl_opt"` to find independent handlers.
- Count the sites and verify the count matches your applied-pattern count before claiming done.
- Don't trust "the helper is exported → callers will use it" — callers (and sibling functions that do their own detection) won't.
- For pipeline/discovery refactors: an e2e probe against real external services is mandatory. Unit tests cover isolated behavior; only live data exposes parallel-implementation gaps that manifest as inefficiency rather than incorrectness.

**Related:**
- memory/feedback_refactor_parity_test.md — parity-check old vs new predicate on real data.
- memory/feedback_real_html_integration_test.md — integration tests on real HTML for extraction fixes.
- memory/feedback_ship_check_finds_real_bugs.md — Opus ship-check subagent catches integration bugs that unit tests miss.
