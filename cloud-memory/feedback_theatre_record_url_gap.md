---
name: Theatre Record URL Gap
description: "TR extraction hardcodes url:null; Phase 0 recovery exists but unused."
type: feedback
archived: true
---

Theatre Record extraction (`extract-theatre-record.js` line 949) hardcodes `url: null` for all reviews. This was a design decision from the initial integration (commit c91783d157, Apr 3 2026) based on the false assumption that TR "doesn't provide original URLs."

**Why:** TR HTML pages DO contain links to original review sources, but the extraction script was never updated to capture them. 30+ subsequent sessions refined TR extraction (title matching, PDF parsing, guards) but none questioned the original assumption.

**How to apply:**
- `recover-explicit-ratings.js` Phase 0 (lines 150-209) has SERP-based URL recovery infrastructure — connect it to TR pipeline
- Or modify `extract-theatre-record.js` to parse `sourceUrl` from TR HTML cards
- Current state after WE launch audit: 123/807 WE reviews (15.2%) still missing URLs, down from 175 (22.6%)
- Remaining gaps are mostly paywalled UK outlets (Daily Mail, Observer, Spectator) or pre-web era (1999 Lion King)
