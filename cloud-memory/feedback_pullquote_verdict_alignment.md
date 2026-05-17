---
name: Pull-quote LLM must receive review verdict direction
description: "LLM must receive verdict direction; reject hedge openers on score ≥70."
type: feedback
originSessionId: 060d6a80-c39c-49da-9353-8d2ba4df13ac
archived: true
---
Pull-quote LLM extraction (`scripts/extract-pull-quotes.js`) must pass the review's `assignedScore` to the prompt AND post-validate the response against a hedge-opener guard (`scripts/lib/pull-quote-guards.js` → `shouldRejectAsReservation`). Without both, the LLM reliably picks middle-paragraph reservation sentences as "most quotable" on reviews that are overall positive.

**Why:** NYT critics especially (Helen Shaw, Jesse Green, Ben Brantley) structure positive reviews with a mid-review caveat before a positive closer. The LLM reads the caveat as "most memorable" and picks it. Without verdict context, the LLM has no signal to prefer endorsements. Real regression cases that motivated this rule:
- `giant-2026/nytimes--helen-shaw.json` (score 77): "I found Lithgow's performance a fascinating study in monstrosity, but I found myself more engaged by the conversations I've had since seeing Giant."
- `back-to-the-future-2023/nytimes--jesse-green.json` (score 73): "Though large, it's less a full-scale new work than a semi-operable souvenir."
- `a-christmas-carol-2019/nytimes--jesse-isaenberg.json` (score 72): "Perhaps the production assumes an audience's universal familiarity, but Cerveris is given more story points to hit than psychological depths to plumb."

**How to apply:**
- Any new LLM prompt that selects "the best sentence" from a corpus must also receive the item's verdict/sentiment direction as input.
- Any LLM response that picks a sentence must be post-validated against a pattern that matches the expected direction (for pull quotes: hedge-opener guard on score ≥70).
- On reject, retry once with a stronger hint — then decline. Don't keep retrying and don't overwrite with a 2nd bad result. Genuinely hedged reviews (Helen Shaw on Giant) have no clean endorsement and should keep whatever was there rather than get replaced with another misleading sentence.
- Extract the guard to `scripts/lib/*.js` and `require()` it in tests — never copy the regex into the test file (CLAUDE.md §15).
