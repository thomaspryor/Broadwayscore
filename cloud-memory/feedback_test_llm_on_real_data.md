---
name: Test LLM/prompt changes on real data
description: Any change to LLM prompts, scoring logic, or content classification MUST be tested against a diverse sample of real reviews before committing
type: feedback
originSessionId: 13c6f36a-95ef-4c58-8291-5792091f9fa2
---
Any change to LLM prompts, scoring logic, or content classification MUST be tested by calling the actual LLM against a diverse sample of real reviews before committing. Syntax checks and logic verification are not enough.

**Why:** A prompt change to wrong_production detection initially passed 4/6 tests — the LLM scored two wrong-production reviews instead of rejecting them because the venue signal was too subtle. Only discovered by running the actual LLM against 6 diverse real review files. Without this test, the change would have shipped with a 33% miss rate on the exact case it was supposed to catch.

**How to apply:** Before committing any change to:
- `scripts/llm-scoring/config.ts` (prompts)
- `scripts/llm-scoring/input-builder.ts` (context construction)
- `scripts/llm-scoring/index.ts` (scoring pipeline logic)
- Any content classification or filtering logic

Run the change against at minimum 6 diverse real reviews covering:
1. True positives (reviews that should pass/be scored)
2. True negatives (reviews that should be rejected/flagged)
3. Edge cases (borderline reviews where the signal is subtle)
4. Cross-market cases (Broadway reviews on WE shows and vice versa)

Use `npx ts-node` with the actual API (Claude/GPT/Gemini) — not mocked or simulated. Run borderline cases 3x to check consistency. Accept ~66%+ hit rate as defense-in-depth; require 100% on clear-cut cases.
