---
name: Lottery/rush data pipeline lessons
description: Price pinning, URL validation, LuckySeat quirks, and stash-pop dangers learned from Reddit launch audit
type: feedback
archived: true
---

**Lottery/rush scraper has 3 protection mechanisms** — use them when manually correcting data:
- `_verifiedPrice`: set on a field to pin the price against scraper overwrites from conflicting sources
- `_skipFields`: array on show entry to block specific fields from being re-added by scrapers
- TodayTix API resolver: auto-resolves show-specific URLs after scraping

**Why:** bwayrush.com and Playbill disagree on prices ~10% of the time (e.g., Aladdin $35 vs $45). Without pins, the next scrape overwrites manual corrections.

**How to apply:** After manually verifying a price, set `_verifiedPrice` to the verified amount on that field in `data/lottery-rush.json`. The merge step in `scrape-lottery-rush.js` skips updates when the pin matches.

---

**LuckySeat show pages are behind auth/JS** — homepage URLs are the correct entry point. The scraper exempts `luckyseat.com` from generic URL stripping. Don't try to find show-specific LuckySeat URLs — they're not indexable or directly linkable.

---

**git stash pop can silently revert manual data fixes.** Happened twice this session. After any stash/rebase, verify data changes survived with `git diff` or direct file inspection.
