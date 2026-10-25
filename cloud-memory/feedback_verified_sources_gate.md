---
name: New scoreSource values must be added to OUTLET_VERIFIED_SOURCES
description: Rebuild silently ignores originalScore if its scoreSource isn't in the verified set — 55 reviews were invisible
type: feedback
archived: true
---

Any new `scoreSource` value (e.g., `explicit-rating`, `manual-verified`, `reviewshub-percentage`, `afridiziak-star-image`) MUST be added to `OUTLET_VERIFIED_SOURCES` in `scripts/lib/score-extractors.js` or the rebuild will silently ignore the `originalScore` and use LLM instead.

**Why:** `explicit-rating` was set on 55 review files but never added to the verified set. All 55 were invisible to the rebuild — they showed LLM scores on the site instead of the verified star ratings.

**How to apply:** When adding a new extractor or score source, always add its source string to `OUTLET_VERIFIED_SOURCES` AND verify with a rebuild that reviews using it show `scoreSource: originalScore-priority0`.
