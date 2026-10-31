---
name: Syndication dedup must check primary file flags
description: KNOWN_SYNDICATION_PAIRS dedup must verify primary file is unflagged before blocking secondary
type: feedback
archived: true
---

The known-syndication dedup in rebuild-all-reviews.js (KNOWN_SYNDICATION_PAIRS) checks if a primary file EXISTS to skip the secondary. But if the primary is wrongProduction/wrongShow, it shouldn't block the secondary.

**Why:** CATS: The Jellicle Ball had a wrongProduction theatermania file (from OB) that blocked the valid Broadway whatsonstage file for Zachary Stewart. Fixed 2026-04-07.

**How to apply:** The fix reads the primary file's JSON to check flags. If adding new syndication pairs, ensure the primary outlet is the one more likely to have unflagged files.
