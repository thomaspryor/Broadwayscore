---
name: word-order-slug-dedup
description: "normalizeTitle preserves word order — slugs that differ only in word order (\"musical parody\" vs \"parody musical\") generate different IDs and bypass dedup. Use jaccard token-set comparison for cross-source dedup."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f614bb18-b7c3-4fc0-8969-fe0774c404d4
---

`normalizeTitle()` in `scripts/lib/title-match.js` strips punctuation and lowercases but **preserves word order**. Slugs derived from `title.toLowerCase().replace(/[^a-z0-9]+/g, '-')` are also order-sensitive. This means two titles that mean the same thing but with words in different order generate different IDs.

**Live failure 2026-05-27:**
- TodayTix had "Heated Rivalry: The Unauthorized **Musical Parody**" → slug `heated-rivalry-the-unauthorized-musical-parody`
- Playbill OB schedule had "HEATED RIVALRY: THE UNAUTHORIZED **PARODY MUSICAL**" → slug `heated-rivalry-the-unauthorized-parody-musical`
- promote-ob-venue-candidates.js `existingTitleVenue` uses `normalizeTitle(title)+'|'+canonicalVenue(venue)` — same exact-string check.
- Result: both entries kept in shows.json; user saw "Heated Rivalry" listed twice on /off-broadway with the Playbill one as a TBA-venue stub.

**How to apply:**
- For cross-source dedup, prefer `jaccard(titleTokens(a), titleTokens(b)) >= 0.85` over exact string equality on `normalizeTitle`. The lib's `isCandidateConfirmed` already does this for Playbill/Lortel cross-validation; the promote-script needs the same upgrade.
- Add a one-time sweep over existing shows.json that flags pairs with jaccard ≥ 0.9 + same canonicalVenue as likely duplicates needing manual merge.
- When generating IDs from a venue scrape, prefer to look up an existing show by token-set jaccard before falling back to creating a new ID.

Related: [[manual-stub-bypasses-validation]] (same class of "should have caught this" bug — both need fixing in the `validate-show-venue.js` next-session work).
