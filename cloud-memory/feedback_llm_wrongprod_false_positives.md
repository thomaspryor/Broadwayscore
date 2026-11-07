---
name: LLM wrongProduction false-positive rate at high confidence
description: "~15% FP on high-conf flags; temporal override is a safety net."
type: feedback
---

**Rule: The 30-day temporal override in `applyTemporalOverrides` (scripts/lib/review-guards.js) is a SAFETY NET, not a bug. Do not remove or weaken it without empirical LLM false-positive measurement.**

## Why

On 2026-04-13, audit session flagged the temporal override as letting wrong-production reviews through near opening. Shipped a fix keeping high-confidence LLM flags at their original confidence. Unit tests passed.

User asked for verification against real data. Found 183 reviews that would be newly excluded. Spot-checked 30 "suspicious" ones (the rest were clearly correct London/regional/off-Broadway flags). **4-6 of the 30 were FALSE POSITIVES** — legitimate T1 Broadway reviews flagged as wrongProduction at high confidence:

- Giant / Timeout / Adam Feldman — review explicitly opens with Mark Rosenblatt's Giant, correct playwright
- Giant / Vulture / Sara Holdren — names Aya Cash, John Lithgow + Music Box Theatre
- Every Brilliant Thing / EW — "Daniel Radcliffe... which just opened at the Hudson Theatre on Broadway"
- Becky Shaw / theatre-reviews-limited — URL says Helen Hayes Theatre (correct), but fullText was empty so LLM couldn't verify

Extrapolating 4-6 false positives in a 30-item sample → ~15-20% FP rate on the suspicious bucket → 25-35 false positives hiding in the full 183.

## How to apply

- The LLM is NOT reliable enough at high confidence to override the temporal window without additional signal
- Before touching this logic, measure the FP rate empirically (sample N, compare LLM flag to actual review text)
- If >5% FP rate, require EXTRA signal: URL domain change, or publish date outside 30-day window, or roundup source disagrees
- Don't ship "simple fix" that removes safety nets without understanding why they exist
- This reinforces: audit findings are HYPOTHESES, not facts. Validate against real data before shipping.
