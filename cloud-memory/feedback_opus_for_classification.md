---
name: Use Opus for content classification, Sonnet for scoring
description: "Sonnet 75% FN on review vs commentary; use Opus for classification."
type: feedback
---

Use Opus (not Sonnet) for classifying whether content is a "review" vs "commentary."

**Why:** During VideoScore development (2026-04-13), Sonnet classified 75% of borderline video transcripts as "commentary" when they actually contained show opinions. Examples: "the score was weak" rejected as "not a review," "It was good, it was great" rejected as "incoherent." Opus correctly identified these as opinions. Sonnet is too literal about what counts as a "review" — it requires formal structure. Opus understands that informal opinions count.

**How to apply:** In any pipeline that classifies content as review/non-review, use Opus for classification and Sonnet for scoring. The cost difference is small at classification scale (short prompts, batch processing). Scoring can stay on Sonnet since it's a more structured task with clear rubrics.
