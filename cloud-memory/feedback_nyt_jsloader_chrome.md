---
name: NYT bot-detection JS-loader chrome appears as trailing junk in archived reviews
description: NYT serves bot-detected requests partial article + "We are having trouble retrieving the article content" stub; covered by PAYWALL_PATTERNS as of 2026-04-25.
type: feedback
originSessionId: 54f662de-dd33-4644-9d1d-ea9fb9fbd62f
archived: true
---
NYT serves bot-detected scraper requests a partial article followed by:

> "We are having trouble retrieving the article content. Please enable JavaScript in your browser settings. Thank you for your patience while we verify access."

Found in 171 archived NYT reviews. The first ~paragraph or two of real prose is captured, then this anti-bot stub.

**How to apply:**
- `scripts/lib/content-quality.js` PAYWALL_PATTERNS includes `/trouble\s+retrieving\s+the\s+article\s+content/i` (2026-04-25). When the chrome is in trailing-junk position with substantial review prose preceding, `cleanText` strips it; otherwise classified invalid.
- LLM ensemble's scoreability check correctly rejects these as `garbage_text` even when classifyContentTier (running first in the rebuild) marks the file as 'complete'. Don't try to clear `rejectionReason='garbage_text'` on these — the rejection is correct, the partial review just shouldn't be in reviews.json without a Browserbase re-fetch.
- For future operational work: 124 reviews stuck this way still need re-fetch via Browserbase + NYT login session to get full text. Tracked in card 34c637c5-416f-81a8.

**Don't pattern-match every variant.** 79 of those 124 stuck files have non-NYT chrome (NYDN page-bottom email, AP/WSJ login prompts, archive OCR junk). Each is heterogeneous — chasing them all would create false positives in real review prose. The right systemic fix is re-fetch, not regex.

**Audit:** raw 171 corpus hits is expected. Allowlisted in `scripts/audit-regex-patterns.js` PATTERN_ALLOWLIST as `'PAYWALL_PATTERNS::15': 250`.
