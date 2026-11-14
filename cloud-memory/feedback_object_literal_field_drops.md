---
name: Object-literal boundary silently drops interface fields
description: When a caller builds a typed object literal from a source object, check that it copies ALL relevant fields — optional fields are easy to miss and TypeScript won't flag the omission.
type: feedback
originSessionId: f6db618e-65be-467b-86e4-545db1fefd5b
archived: true
---
When `ensemble-scorer.ts` built `ReviewInputData` from `reviewFile`, it silently omitted `category` and `venue` even though both were populated upstream at `index.ts:1070-1071` and fully supported by `input-builder.ts`. The `ReviewInputData` interface marked them optional, so TypeScript didn't flag the missing fields. Every review emitted `"Show: X at Y (Broadway)"` in LLM context regardless of market — including every West End review, causing 27 false `wrong_production` rejections.

**Why:** Object-literal construction (`{ showId, outletId, fullText, ... }`) gives no compile-time warning when optional fields are dropped. The bug is invisible until you trace actual runtime values through the whole pipeline.

**How to apply:**
- When a bug's symptom is "wrong context / missing metadata in downstream component", grep the caller chain for object-literal constructions and verify every field of the target interface is either passed through or explicitly defaulted.
- When adding new optional fields to an input interface, grep callers in the same commit and update them. Otherwise the field is dead weight.
- For cases where the input type has 10+ fields, prefer spread with allowlist: `{ ...allowedFields(reviewFile), fullText: reviewFile.fullText }` over hand-enumerated fields.

Fixed 2026-04-23 (Notion 34b637c5-416f-81ad-8afb-e39b9de9e926) by adding `category: (reviewFile as any).category, venue: (reviewFile as any).venue` to the reviewData construction at `scripts/llm-scoring/ensemble-scorer.ts:292-306`.
