---
name: DTLI critic name regex truncates at <br/>
description: DTLI HTML splits first/last name with <br/> tag; [^<]+ regex captures only the first name
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
archived: true
---
DTLI's per-review HTML formats the critic name as `<h2 class="review-item-critic-name">First<br />Last</h2>`. An extractor using `[^<]+` to capture the name truncates at the `<br />` tag, yielding just "First" (e.g. "Patrick" instead of "Patrick Gomez"). This silently mismatched every review to the wrong existing file (or created a junk one) on Schmig opening night 2026-04-20.

**Why:** `[^<]+` stops at any `<`. DTLI introduced (or always had) the `<br />` linebreak. Fix is a lazy-match regex `[\s\S]*?)(?:<\/a>|<\/h2>)` plus `.replace(/<br\s*\/?>/gi, ' ').trim()` downstream.

**How to apply:** When writing/reviewing extractors for any HTML with person names, never assume `[^<]+` covers the full name — names can contain inline tags (`<br />`, `<strong>`, etc.). Prefer lazy-match to a known closing tag, then strip inline tags.

Fix: `scripts/scrape-dtli.js:292` in commit 8b068eb8f4. Pattern applicable to any similar aggregator HTML parsing.
