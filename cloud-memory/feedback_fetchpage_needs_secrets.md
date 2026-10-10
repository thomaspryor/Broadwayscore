---
name: fetchPage needs BD+SB secrets in workflow env
description: "Workflow steps using fetchPage() need BRIGHTDATA_TOKEN + SCRAPINGBEE_API_KEY."
type: feedback
archived: true
---

When adding fetchPage() to a workflow step, always add BRIGHTDATA_TOKEN and SCRAPINGBEE_API_KEY to the step's `env:` block. Without them, fetchPage skips BD and SB, falls through to Playwright (which isn't installed in most workflows), and gets 100% failure rate.

**Why:** The backfill-unknown-critics step in rebuild-reviews.yml was upgraded to use fetchPage but the env vars weren't added. All 200 URLs failed because Playwright wasn't installed. Fixed by adding the secrets and reducing the limit from 200 to 50 (each URL takes ~5-10s through the BD→SB fallback chain).

**How to apply:** Any new workflow step that calls a script using fetchPage() needs:
```yaml
env:
  BRIGHTDATA_TOKEN: ${{ secrets.BRIGHTDATA_TOKEN }}
  SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
```
