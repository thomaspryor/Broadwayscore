---
name: scraper_testing_rule
description: After migrating a scraping script, run it with --limit 1 and confirm non-zero results before committing
type: feedback
archived: true
---

After migrating a scraping script to a new fetch library, ALWAYS run it with `--limit 1` (or `--theater X`, etc.) and confirm the output contains actual data — not just that it exits without error.

**Why:** Migrated `scrape-theater-tips.js` to use `fetchPage()` from scraper.js. `fetchPage()` returns `{content, format, source}` not a plain string. Passed an object to the HTML parsers, which silently returned 0 results. `node --check` passed. CI lint passed. Empty output was the only signal — and we only caught it because the user asked "did you test it?"

**How to apply:**
- After any scraping script migration: run with smallest possible scope (`--limit 1`, `--theater X`, `--show X`), check that result count > 0, and inspect a sample record
- `node --check` is syntax validation only. Never claim a script "works" based on `node --check` alone
- Empty results after a migration = broken until proven otherwise (check what the old code returned first)
- For scripts that require private data (e.g., `review-texts/`), test the fetch path directly with a one-off `node -e` call
