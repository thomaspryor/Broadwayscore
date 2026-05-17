---
name: Aggregator soft-404s return homepage with 200 OK
description: "BWW returns homepage with 200 OK; check <title> tag in validators."
type: feedback
originSessionId: 9d267f5d-b0d8-44f9-ad26-e0d3090bc86b
---
**Rule:** Aggregator content validators (`isBWWRoundupContent`, future equivalents) must verify that article-identifying text appears in the `<title>` tag, NOT just anywhere in the HTML body.

**Why:**
- Fear of 13 opening night (2026-04-15): BWW returned homepage HTML with 200 OK for Review-Roundup URLs that didn't exist. The homepage contained "Review Roundup" and "Opens-On-Broadway" in teaser link text, so `html.includes(...)` checks all passed.
- This created a double failure: (1) Priority 4 URL-guessing returned false positives for any non-existent URL pattern, (2) Priority 3 SERP returned the homepage URL, which also passed validation.
- `isBWWRoundupContent` in `scripts/lib/bww-roundup-validator.js` now early-rejects if `<title>` contains "BroadwayWorld:" (homepage pattern) and requires "Review Roundup" in `<title>` for secondary markers.

**How to apply:**
- When building content validators for any aggregator (DTLI, Show Score, Playbill Verdict, etc.), test against the aggregator's homepage FIRST. If the homepage passes, the validator is weak.
- Prefer `<title>` tag checks over full-body text checks — teaser/nav links pollute the body but rarely the title.
- Add a negative check for known homepage title patterns (e.g., "Latest News", the aggregator's name with a colon).
- Never trust HTTP 200 alone. Soft-404 behavior is common in article-heavy sites.
