---
name: Star ratings are authoritative — never override with LLM scores
description: "Stars are ground truth; 5/5=100 is correct, never cap with LLM."
type: feedback
---

Published star ratings are ground truth — the critic chose that rating. LLM scores are guesses from reading text. Stars ALWAYS win.

- 5/5 = 100 (correct, not capped)
- 3/5 = 60
- 4/4 = 100
- Stars override LLM scores at any confidence level

**Why:** The user explicitly confirmed this. A critic giving 5/5 IS giving their maximum. Previous sessions tried capping 5/5→95 or letting LLM override stars — both were wrong.

**How to apply:** Never override a published star rating with an LLM score. If a review has both `originalScore: "5/5"` and `llmScore: 89`, the score is 100.
