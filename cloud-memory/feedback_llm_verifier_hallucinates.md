---
name: LLM contentVerification hallucinates isValid:true on garbage
description: "Gemini isValid:true at 48% on garbage; post-check with findShowKeywordInText."
type: feedback
originSessionId: 8a4c950a-3ec6-4d56-9a7a-77582b696569
---
The contentVerification step (verifiedBy:llm:gemini) hallucinates isValid:true at a measured 48% rate on garbage pages. Spot-checked 31 review files where the rebuild auto-clear had restored wrongFullText → fullText based on isValid:true; 15 were actually browser-update prompts, paywall walls, Bloomberg gift-link nav, or completely wrong-show content (Memphis review file got My Fair Lady sidebar; Hamilton got an AMP shareholder news brief; Lucky Guy got Brendan Fraser/Mummy 4; Kite Runner got an essay about Nazis as villains).

**Why:** Gemini-2.0-flash, when given a scraped page and asked "is this a review of show X," will confidently affirm isValid:true even when the content has zero overlap with the show. The verifier prompt doesn't include negative examples, and confidence:high doesn't correlate with accuracy.

**How to apply:** Before trusting `contentVerification.isValid === true` to make any destructive decision (auto-clear, restore from wrongFullText, scoring), run a programmatic final-mile keyword check:

```js
const { buildShowKeywordSet, findShowKeywordInText } = require('./lib/review-guards');
const show = showsData.shows.find(s => s.id === data.showId);
const kw = buildShowKeywordSet(show);
const matched = findShowKeywordInText(data.fullText, kw);
if (!matched) {
  // LLM said valid, but text mentions zero show keywords — likely hallucination
  // Defer the destructive action and flag for human review instead
}
```

The keyword check is conservative: false negatives (legitimate review where the body doesn't repeat the title) are OK because the file just stays flagged for human review. False positives (garbage restored as fullText) are bad because it corrupts scoring.

**See:** Broadwayscore@47b1dd1da0 (rebuild-all-reviews.js auto-clear hardening), Notion card "Reduce contentVerification LLM hallucination rate".
