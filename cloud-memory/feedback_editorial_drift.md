---
name: Guide editorial drift guard gotchas
description: "Drift guard silently discards LLM content when show counts change."
type: feedback
---

Guide editorial drift guard (`src/lib/data-guides.ts` getGuideEditorial) silently falls back to a 1-sentence intro when the editorial's showCount drifts from actual. No error, no alert — the page just looks thin.

**Why:** The musicals guide had 10-show editorial but 21 actual shows after score filter was added to guide-pages.ts but NOT to generate-guide-editorials.js. Drift was 110% → editorial discarded → 25 words instead of 260 words rendered for weeks.

**How to apply:**
- When changing guide filters in `src/config/guide-pages.ts`, also update the duplicated filters in `scripts/generate-guide-editorials.js`
- After regenerating editorials, verify they actually render on the live page (check for multi-paragraph content, not single-sentence fallback)
- The drift threshold is 65% with symmetric math (`Math.max` denominator). If a guide's show count changes significantly, editorials may need regeneration.
