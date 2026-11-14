---
name: paywall-cancellation-verify-before-resubscribe
description: "Before recommending resubscription for a paywalled outlet's review-text gap, verify the free/cookie fetch path actually returns empty body — the real cause may be a missing extraction pattern, not lost access"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cc748607-9b21-4ce8-9a96-67f0a4c6e294
  modified: 2026-08-02T23:50:55.553Z
---

Owner asked (2026-08-02) whether Telegraph's Jul 21 subscription cancellation
broke free-tier access, given 156 telegraph.co.uk review files with no
`fullText`. The instinct was to assume the paywall now blocks the plain
cookie-fetch path and recommend resubscribing.

**What actually happened:** `fetchPage()` with `telegraph.co.uk` cookies
returned full 250K+ char pages on 5/5 live test URLs — no paywall gate, no
subscriber-only block, real review prose sitting in an
`article-body-text` div. The free path was never dead. `telegraph.co.uk`
simply had **no entry in `scripts/lib/article-extractor.js`'s PATTERNS
array** — task #720 wired it into WE discovery but extraction was never
built, so every fetch silently saved as a stub regardless of subscription
status. Fixed by adding one pattern (see [[feedback_content_quality_regex_fps]]-adjacent
class of "outlet onboarded but extractor never built").

**How to apply:** When a paywalled/formerly-paywalled outlet shows a batch
of no-text review files, don't assume "access died" from the subscription
event alone. First run the actual URL through `fetchPage()` and check
`result.content.length` — if it's large (tens of KB+) and contains the
outlet's known body-container class/selector, the fetch is fine and the
gap is an `article-extractor.js` PATTERNS gap, not an access problem. Only
recommend resubscription if the fetch genuinely returns an empty/small body
or a visible paywall/registration-wall marker.
