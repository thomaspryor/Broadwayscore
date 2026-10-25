---
name: Optional-qualifier regex traps silently reject good content
description: Paywall/garbage regex patterns with all-optional qualifier groups match bare keywords in nav chrome — every WSJ review was rejected for months.
type: feedback
originSessionId: 7db74cc2-13a5-4bf5-aa34-d42de500ab54
archived: true
---
Paywall/garbage detector regex patterns in `scripts/lib/content-quality.js` (`PAYWALL_PATTERNS`, `NAVIGATION_PATTERNS`, `WRONG_ARTICLE_PATTERNS`, etc.) must NOT have all qualifier groups marked optional. A pattern like `/subscriber(s)?(\s+only)?(\s+content)?/i` matches the bare word "Subscriber" alone — which is a common nav-chrome word (e.g., "Subscriber Sign-In" on WSJ, "Subscriber" link on NYT), not a paywall signal.

**Why:** 2026-04-22 — the above regex matched WSJ's "Subscriber Sign-In" nav and rejected every WSJ opening-night Browserbase capture YTD as garbage ("Paywall/subscription prompt: 'Subscriber'"), despite Browserbase returning ~5900 chars of real review content with valid cookies injected. 7 Broadway openings (Schmigadoon, Fallen Angels, Proof, Fear of 13, Becky Shaw, Dog Day Afternoon, Every Brilliant Thing) required manual ingestion. Fix was to require `(only|content|exclusive|access)` after `subscribers?`.

**How to apply:** When writing or reviewing a garbage/paywall regex pattern, check every optional group `(...)?`. If all qualifiers are optional, the pattern collapses to the bare keyword — which will false-positive on nav chrome, footers, or incidental mentions. Every paywall regex must have at least one required qualifier. The test pattern is `tests/unit/content-quality-paywall-subscriber.test.mjs` — follow it: assert both (a) real WSJ review content with the nav word passes, and (b) real paywall strings still trigger. Parity audit across existing review-text corpus before shipping: `node -e "..."` iterating all `{outlet}--*.json` files comparing old-regex vs new-regex to confirm 0 regressions.

**Adjacent watch:** `NAVIGATION_PATTERNS`, `NEWSLETTER_PATTERNS`, `LEGAL_PAGE_PATTERNS` in the same file have similar optional-qualifier shapes. Likely carry latent false-positives. A batch audit of each pattern against real outlet content would surface other silent filtering losses.
