---
name: Excerpt guard allowlist FP rate
description: Vocabulary allowlist guards for excerpt quality have ~20% false-positive rate; use blocklist (positive non-theater signals) approach instead
type: feedback
originSessionId: 3e8d1e0d-4360-4252-a94d-4e0e090d1923
archived: true
---
Domain-word allowlist guards for pull-quote quality are too aggressive at the sentence level. An `isOffTopicExcerpt()` guard checking for theater vocabulary (actor, stage, musical, etc.) rejected 20.59% of 18,680 llmPullQuote fields in production — all legitimate theater criticism that happened to use metaphorical or emotional language without standard theater vocabulary ("It has remembered the ladies. But it can't make them live.").

**Why:** Theater critics write about themes, characters, and emotions without theater jargon. Single-sentence excerpts don't have enough vocabulary for reliable classification via allowlist.

**How to apply:** If re-implementing an off-topic guard for excerpts, use a BLOCKLIST approach (reject when positive non-theater signals present — medical, sports, cooking, technology terminology) rather than an ALLOWLIST approach (reject when theater vocabulary absent). Only apply the guard to full paragraphs (100+ words), not single sentences. Always audit FP rate against the full dataset before enabling in the pipeline.

The functions `isInternalNote()` and `hasCopyrightChrome()` are safe — they check for specific positive signals (brackets, copyright text) and had 0% FP rate on 35,413 files.
