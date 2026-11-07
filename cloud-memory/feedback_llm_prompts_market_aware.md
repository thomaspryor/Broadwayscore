---
name: feedback-llm-prompts-market-aware
description: "LLM classifier prompts that hardcode \"Broadway theater\" framing mis-classify any show type that lives as a category overlay (opera lives under category=off-broadway). Must inject market/type-specific context blocks."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7c68e149-3932-4186-acd0-19bd4a0ca41f
---

When an LLM classifier prompt says "You are an expert in Broadway theater" or "You classify whether a review is about a Broadway/theater show", it will mis-classify reviews of any show that isn't theater — opera at the Met, classical concerts, comedy specials. Symptoms: the LLM returns `wrong_show` / `wrong_production` with reasoning like "this is opera, not theater" or "this is a concert, not a Broadway show".

**Why:** Some show types live in the data model as overlays on existing categories (opera shows have `category='off-broadway'` + `type='opera'`). Theater-tuned prompts only see the category and conclude "this isn't a theater review".

**How to apply:** Before adding a new show `type` (opera, special, concert), audit every LLM gatekeeper prompt and inject type-aware context:
  1. `scripts/llm-scoring/input-builder.ts` (ensemble pre-scoring)
  2. `scripts/lib/content-verifier.js` (content verification)
  3. `scripts/classify-wrong-production.js` (wrong-production classifier)
  4. `scripts/classify-wrong-show.js` (wrong-show classifier)
  5. `scripts/adjudicate-review-queue.js` (LLM-vs-aggregator adjudication)

Use a single canonical helper (`scripts/lib/opera-prompt-context.js` is the pattern) that exports `isXxxShow(show)` + `getXxxContext()` for each classifier purpose. Don't duplicate the predicate across files.

**Prompt framing rule:** when adding a context block, spell out the WRONG verdict criteria BEFORE any leniency note. Stacking "be lenient" on top of an existing "lean toward CORRECT on ambiguous" instruction biases toward false negatives. Symmetric framing ("X is normal context, but Y is still WRONG") survives the multi-model ensemble.

**Reference:** Notion 363637c5-416f-81cc — opera classification root fix 2026-05-17. /ship-check caught the "Be lenient" wording before it caused production drift.

[[feedback_test_pure_function_at_io_boundary]] — same lesson at the test level: extract pure prompt builders to `scripts/lib/*` and exercise via behavior-level integration tests (not substring assertions on the context string alone).
