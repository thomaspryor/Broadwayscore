---
name: feedback_newspapers_com_vision_pipeline
description: How to extract pre-2010 reviews from newspapers.com (Browserbase login + local Chrome + GPT-4o vision OCR); NYT/WSJ are DataDome bot-walled
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1c1bfed9-71e6-4247-8a81-a0ba690028c9
---

For pre-2010 shows, aggregators don't exist and SERP returns the most-recent same-title production. newspapers.com has digitized archives (Newsday, Daily News, LA Times, Chicago Tribune, Philadelphia Inquirer — but NOT NY Post or USA Today). Built 2026-06-04.

**Auth (newspapers.com killed the old `/ocr/` text API; renders pages as tiled `<img>`; Cloudflare blocks automation browsers):**
1. One-time: `node scripts/newspapers-browserbase-login.js` — live-view login into a PERSISTENT Browserbase context (passes Cloudflare). Saves to data/collection-state/browserbase-newspapers-context.json. Session cookies expire ~hours-to-days; re-login when stale.
2. Export full httpOnly cookies (Safari extraction can't get them on macOS Tahoe — its binarycookies store lacks the auth cookies) → data/cookies/np-full.json.

**Extract:** `node scripts/newspapers-com-extract.js --show=ID --local --vision --force [--paper=X]`
- `--local`: real Chrome on this machine's RESIDENTIAL IP (Cloudflare passes here; Browserbase datacenter proxies get CF-blocked on content pages).
- `--vision`: downloads the page via subscriber "Save as JPG", splits into bands, GPT-4o vision-OCRs ONLY the target show's review (returns NONE for non-reviews). Captures byline.
- ~40% false-positive rate (duplicates, previews, wrong-production, syndicated reprints) — **manually verify every extracted -bway file** before it counts: is it a real critical review of THIS production? not a dup of another outlet? Then score + rebuild.

**NYT / WSJ articles are DataDome bot-walled** — local Chrome 403, Bright Data empty-200, Browserbase 403. Can't fetch the article body by any scraper. Find the URL via the authenticated NYT search page (`nytimes.com/search?query=...&startDate=...`), but the article itself is unreachable; last resort is excerpt-tier from verbatim published quotes.

A non-review gate now blocks weather/sports/junk pages pre-save and in CI: [[feedback_rebuild_rewrites_review_texts]], scripts/lib/non-review-patterns.js.
