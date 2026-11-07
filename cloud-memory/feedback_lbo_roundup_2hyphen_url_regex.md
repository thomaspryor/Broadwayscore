---
name: LBO Review-Round-Up uses 2-hyphen URL the regex didn't match
description: isRoundupUrl regex for LBO matched only `review-roundup` (1 hyphen). Real URL pattern is `Review-Round-Up` (2 hyphens) and `review-round-up`. 17 files silently scored as individual reviews for >1 month. Stuart King email 2026-04-27 surfaced.
type: feedback
originSessionId: b979be02-2974-4428-ab37-f8eadbd2bad6
archived: true
---
When LBO publishes an aggregator roundup, the URL pattern is one of:
- `/news/post/Review-Round-Up%3A-{SHOW}-at-the-{Venue}` (live as of 2026-04-27)
- `/news/post/review-round-up-{slug}-{venue}`
- `/news/post/review-roundup-{slug}` (older/rare)

`scripts/lib/review-guards.js:409` `isRoundupUrl` had `/londonboxoffice\.co\.uk\/.*review-roundup/i`
— matches only the 1-hyphen form. The 2-hyphen `Review-Round-Up` (the actual common pattern) was
missed. 17 lbo-roundup files were unflagged and being scored as individual critic reviews —
Paranormal Activity's Sherri roundup at score 81 was alongside Stuart's individual review at 76,
skewing the composite (Stuart's complaint).

Fix (commit f3b819c974 + 0afe794405): regex now `/review-round[-_ ]?up/i` and the
`INDIVIDUAL_REVIEW_URL_PATTERNS` negative lookahead matches the same family. Plus
`scripts/lib/review-file-writer.js` Guard E2 auto-flags isRoundupArticle at write time on the URL
pattern (URL, NOT `source: lbo-roundup` field — that's a discovery-path tag and many tagged files
are full Stuart King individual reviews at `/news/post/{slug}-review`).

**Why:** A regex looking for `review-roundup` won't match `Review-Round-Up` because the hyphen
positions differ. Case-insensitive doesn't help. When auto-flagging URL patterns from a single
publisher, sample multiple real URLs (don't assume hyphenation is consistent) and prefer
character-class lookarounds (`[-_ ]?`) over literal hyphens.

**How to apply:** When fixing or adding URL-pattern detection in review-guards.js, fetch 5+ real
URLs and confirm the regex matches all variants. Don't trust commit messages or memory entries
that describe URL patterns — only real URLs. After any change to roundup-detection regex, rerun
`scripts/scoring-delta.js` and verify the included/excluded counts match expectations.
