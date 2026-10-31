---
name: sb-quota-ride-out
description: "Settled owner decision (repeated to many sessions): ScrapingBee quota exhaustion = ride it out, never re-ask about topping up; SB is a fallback, not a dependence"
type: feedback
---

Owner decision, restated with frustration 2026-08-03 after being asked "many" times: when ScrapingBee monthly credits are exhausted, **ride it out until the billing reset. Never raise a DECISION NEEDED about SB billing or suggest topping up/upgrading.**

**Why:** SB is one link in the fallback chain (Scrapingdog → Bright Data → ScrapingBee → Playwright), not a dependence. Exhaustion only degrades: the SERP arm auto-skips (`check-sb-credits.js` gate) and each fetch wastes one failed SB attempt before falling through — runs do not fail because of it. The 2026-08-03 poller failures that the auto-investigation email blamed on "credit exhaustion" were actually git push races between concurrent pollers.

**How to apply:**
- `check-sb-credits.js` shows 0 remaining → at most a one-line FYI, then move on. No decision block, no billing options.
- If a run fails, identify the failing STEP before blaming scraper credits — per-scraper ⚠️ warnings in logs are normal chain noise, not root causes ([[sb-serp-invisible-burn]] covers the separate silent-burn issue; [[ScrapingBee credit budget caps]] covers per-run caps).
