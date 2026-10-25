---
name: ScrapingBee credit budget caps
description: "SB_CREDIT_BUDGET=250, SB_PAGE_CREDIT_BUDGET=200; override for bulk runs."
type: feedback
---

Per-run SB credit budgets prevent runaway spending. Normal runs use 20-50 credits; caps are safety nets.

**Why:** SB credits exhausted quickly in April 2026 due to render_js=true default (5-10 credits/call) and no caps.

**How to apply:**
- `scraper.js`: `SB_CREDIT_BUDGET` env var, default 250. Covers all scripts using `fetchPage()`.
- `collect-review-texts.js`: `SB_PAGE_CREDIT_BUDGET` env var, default 200. Covers its own SB function.
- For bulk runs (backfills, large dispatches, opening night surges): override via env, e.g. `SB_CREDIT_BUDGET=1000`.
- In workflow steps: add `env: { SB_CREDIT_BUDGET: '1000' }`.
- When budget is hit, SB is skipped and Playwright handles remaining requests (graceful degradation, not failure).
- render_js defaults to false (1 credit) for most domains; only JS_REQUIRED_DOMAINS get render_js=true (5 credits).
- Paywalled/cookie-forwarding domains in collect-review-texts.js use premium_proxy (10 credits); all others use standard (1 credit).
