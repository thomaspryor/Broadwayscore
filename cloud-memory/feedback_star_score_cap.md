---
name: Star ratings are authoritative — never override with LLM scores
description: "Stars are ground truth, but since anchored-v6 they set a score BAND (2/5=31-50, 3/5=51-70, 4/5=71-90, 5/5=91-100) the LLM lands inside, not a flat number. Never override outside the band."
type: feedback
---

**CURRENT RULE (anchored-v6, supersedes the flat numbers below):** a star/grade is a band, not a fixed score. 2/5→31-50, 3/5→51-70, 4/5→71-90, 5/5→91-100 (`starToBand`, `scripts/llm-scoring/config.ts`). The LLM position inside the band comes from the review text; `llmScore.band` proves it was anchored. Never set `humanReviewScore` outside the band (`scripts/lib/human-score-star-guard.js`; `batch-correct-reviews.js` refuses). Read the whole article for the rating first: it sits at the end of the page or in image alt text. See `feedback_anchored_v6_stamp_and_rescore_starvation.md`.

Original (pre-v6) note, kept for history: published star ratings are ground truth — the critic chose that rating. LLM scores are guesses from reading text. Stars ALWAYS win.

- 5/5 = 100 (correct, not capped)
- 3/5 = 60
- 4/4 = 100
- Stars override LLM scores at any confidence level

**Why:** The user explicitly confirmed this. A critic giving 5/5 IS giving their maximum. Previous sessions tried capping 5/5→95 or letting LLM override stars — both were wrong.

**How to apply:** Never override a published star rating with an LLM score. If a review has both `originalScore: "5/5"` and `llmScore: 89`, the score is 100.
