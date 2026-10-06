---
name: Star ratings are authoritative — never override with LLM scores
description: "Stars are ground truth, but since anchored-v6 they set a score BAND (2/5=31-50, 3/5=51-70, 4/5=71-90, 5/5=91-100) the LLM lands inside, not a flat number. Never override outside the band."
type: feedback
---

A published star or letter grade is ground truth: the critic chose that rating, and an LLM reading the text must not move the review outside it.

**Rule (anchored-v6):** the rating sets a score BAND, not a fixed number.

- 5/5 (and 4.5/5, 4/4) → 91-100
- 4/5 (3/4) → 71-90
- 3/5 → 51-70
- 2/5 → 31-50
- 1/5 → 0-30

The LLM chooses the position inside the band from the review text (`starToBand`, `scripts/llm-scoring/config.ts`; letter grades have narrower bands). `llmScore.band` is the durable proof a review was anchored. Never cap a 5/5 below its band, and never let the text push a score outside it.

**Why:** the user confirmed stars are authoritative. Sessions that capped 5/5 or let the LLM override stars were wrong. Flat conversions (3/5 = 60) were the pre-v6 approach and leak past the anchored system (see `feedback_anchored_v6_stamp_and_rescore_starvation.md`). On 2026-10-05 a session hand-overrode a 2/5-star Slam Frank review (Culture Sauce, anchored 39 inside 31-50) to 58 then 66 after reading only part of the article, and had to revert.

**How to apply:**
- Before judging or overriding any score, read the whole article for the rating: it is often at the very end, or in an image's alt text (1minutecritic `alt="4 star review"`).
- Never set `humanReviewScore` outside the band. `scripts/lib/human-score-star-guard.js` makes `batch-correct-reviews.js` refuse it (exit 3); `--allow-outside-star-band` only if the star itself was extracted wrong.
- A new URL ingest records HTML-only ratings via `scripts/lib/ingest-html-score.js` (BRO-4764), so the review is anchored on first scoring.
