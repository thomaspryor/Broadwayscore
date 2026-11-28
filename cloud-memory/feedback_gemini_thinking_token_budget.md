---
name: gemini-thinking-token-budget
description: "Gemini 2.5 Flash uses internal \"thinking\" tokens that count against maxOutputTokens — pass thinkingConfig.thinkingBudget=0 or your response truncates silently"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a0a2119-edf5-4d95-8afa-782753dcc756
---

`gemini-2.5-flash` (and other 2.5 series) use internal "thinking" tokens by default. They count against `maxOutputTokens` AND are returned in `usageMetadata.thoughtsTokenCount` separately from `candidatesTokenCount`. If thinking consumes most of the budget, the actual response text gets silently truncated with `finishReason: "MAX_TOKENS"` and you get back a partial answer.

**Why:** 2026-05-16 opera review — first Gemini call set `maxOutputTokens: 2000` and got back a 68-character truncated response. `usageMetadata` showed `thoughtsTokenCount: 1918, candidatesTokenCount: 68`. Re-ran with `thinkingConfig: { thinkingBudget: 0 }` and got a full 4-section JSON answer.

**How to apply:**
For tasks that don't benefit from thinking (most one-shot prompts: summaries, formatting, simple Q&A), disable it:
```json
"generationConfig": {
  "maxOutputTokens": 4000,
  "responseMimeType": "application/json",
  "thinkingConfig": { "thinkingBudget": 0 }
}
```
For tasks that DO benefit from thinking (complex reasoning, multi-step proofs), either:
- Leave thinking on but allocate `maxOutputTokens` 2-3x larger than your expected response size, OR
- Set `thinkingBudget` to a specific cap (e.g. 512) and add that on top of response budget.

Always check `finishReason` and `usageMetadata.thoughtsTokenCount` when debugging short Gemini responses — the answer is often "thinking ate the budget".
