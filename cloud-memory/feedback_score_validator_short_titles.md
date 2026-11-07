---
name: score-input-validator short-title gate
description: keyword gate in score-input-validator.js uses fullTitle length check — any future edit must test with short show titles
type: feedback
originSessionId: ad07f333-0334-4853-a39e-87dfbfc8af47
archived: true
---
When editing `scripts/lib/score-input-validator.js`'s keyword gate, always test with short single-word show titles.

**Why:** The original implementation had `if (fullTitle.length >= 4) keywords.add(fullTitle)` which silently blocked 26 shows: Wit, SIX, Bug, Red, Art, Elf, Ink, Tru, Da, Rex, QED, Ann, 1776, 13, etc. Fixed to `>= 2` (2026-04-18 ship-check catch).

**How to apply:** Any change to `countShowKeywords()` in score-input-validator.js must include a test case with a 3-char title like "Wit" or "Six". The test is in `tests/unit/score-input-validator.test.mjs` — run it before committing.
