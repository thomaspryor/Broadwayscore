---
name: Image placeholder prevention
description: "TodayTix Coming Soon uses NORAM/square_photo; 3-layer defense."
type: feedback
archived: true
---

TodayTix "Coming Soon" placeholders use NORAM_*.jpg (poster/hero) and square_photo.png (thumbnail) filename patterns. These slip past the Contentful asset ID blocklist because TodayTix uses different IDs per show.

**Why:** On March 3 2026, the archive script downloaded a Coming Soon placeholder for Burnout Paradise, then deleted the existing real poster.jpg (different extension cleanup). The show displayed a placeholder for days until a later pipeline run fixed it.

**How to apply:**
- `fetch-show-images-auto.js` `isComingSoon()` checks URL patterns (NORAM, square_photo) + asset IDs + file hashes
- `archive-show-images.js` rejects Coming Soon URLs before download AND checks hashes after download
- `--missing` filter treats placeholder files on disk as missing
- Venue override only fires when `non_broadway` is the sole LLM issue (prevents accepting wrong-show images)
- Hash-based detection only works for compressed/archived versions; URL detection is the primary defense for fresh downloads
