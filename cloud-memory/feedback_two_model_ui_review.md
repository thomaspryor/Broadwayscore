---
name: two-model-ui-review
description: "For \"would this embarrass me?\" UI reviews on a domain you don't deeply know, send screenshots + text to GPT-4o AND Gemini in parallel — convergent findings are gold, divergent findings need human verification"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a0a2119-edf5-4d95-8afa-782753dcc756
---

For UI/copy review on a domain you (or the user) aren't expert in, running the same screenshot + text payload past BOTH GPT-4o (vision) and Gemini 2.5 Flash (vision) in parallel and treating overlapping findings as high-confidence works much better than a single-model pass.

**Why:** 2026-05-16 opera-page review (user asked "what would embarrass me before I send this to opera people?") — convergent findings caught 3 real blockers (Off-Bway pill on Met show pages, missing conductor/cast in Quick Facts, editorialized Critics' Take). Divergent findings caught real adds from each side (GPT-4o: TOP CRITIC badge on all 5 reviewers, intermissions field empty; Gemini: tagline overclaims "every Met production", BWW in critic list dilutes credibility for opera audience). One false positive from Gemini was easy to catch and discard ("synopsis conflates Madama Butterfly with Onegin" — misparse, the synopsis was actually correct).

**How to apply:**
- When the user asks "review this before I send it out" or "what looks wrong here?" — load both reviewers in parallel.
- Same prompt to both. Ask for JSON output with `blockers` / `embarrassments` / `what_works` / `factual_check`.
- Gemini 2.5 Flash: pass `thinkingConfig: { thinkingBudget: 0 }` or you'll hit MAX_TOKENS silently (see [[gemini-thinking-token-budget]]).
- For images: GPT-4o uses `image_url: { url: "data:image/png;base64,..." }`; Gemini uses `inline_data: { mime_type, data }`.
- Synthesize for the user as: (a) both-flagged → ship the fix, (b) one-flagged but credible → mention with context, (c) likely false positives → say so.
- The pattern works for any visual surface: opera pages, marketing copy, email templates, dashboards. Doesn't replace actual domain experts but caches well for catching obvious sins before sending.
