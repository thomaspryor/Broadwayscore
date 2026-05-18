---
name: feedback_audience_buzz_commit_before_rebuild
description: "After running audience scrapers locally, commit audience-buzz.json to the private repo BEFORE any CI rebuild runs, or the public show files will be regenerated without the new data."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 25ad55c5-64f7-4001-93df-9387c7dab492
---

After running audience scrapers locally (scrape-show-score-audience.js, scrape-mezzanine-audience.js, etc.), commit `audience-buzz.json` to the private repo (`~/broadway-scorecard-data/`) immediately before any CI rebuild runs.

**Why:** The scrapers write to `data/audience-buzz.json` (a symlink to the private repo). `generate-mobile-show-details.js` reads from the GitHub-hosted version of that file. If the local changes aren't committed and pushed, the CI rebuild reads the old file from GitHub and regenerates `public/data/shows/{id}.json` WITHOUT the new data, silently overwriting it.

This happened in the 2026-05-17 session: 7 shows had Show Score data scraped locally, committed to public repo in `public/data/shows/`, but the private `audience-buzz.json` was never pushed. A subsequent CI rebuild overwrote the public files. Required a second commit cycle to fix.

**How to apply:** After any audience scraping session, immediately run:
```bash
cd /Users/tompryor/broadway-scorecard-data
git add audience-buzz.json
git commit -m "data: Update audience-buzz with [source] data for [shows]"
git pull --rebase && git push origin main
```
Then verify the public show files have the new data after the next CI rebuild.
