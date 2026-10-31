---
name: Bare X/Y regex FPs on URL fragments + dates
description: extractor regex matching `\d/\d` patterns false-positives on CDN URL paths (`/2026/01/23/12/50/`) and date headers (`Opens 3/5/2026`). Two real incidents in 2026-04-24/25.
type: feedback
originSessionId: a97024db-80fe-4390-980a-840a895de55d
---
# Bare digit/slash extractor FPs

When writing star-rating or fraction-form extractors, the bare `\d/\d` pattern
matches a lot more than ratings. Two real incidents in this codebase, both in
`scripts/lib/score-extractors.js`:

- **2026-04-24** — `extractUKStarRating` text-pattern step matched `2/5` inside
  a CDN URL path: `https://static.standard.co.uk/2026/01/23/12/50/Render-Final.jpg`.
  Date components + image dims, not a rating. Caught during backfill spot-check
  on `arcadia-west-end-2026/standard--nick-curtis.json`. Fix: URL/asset-context
  reject regex `(https?:\/\/|\.(jpg|...)|cdn|static|assets|\/\d{4}\/\d{2}\/\d{2}\/|\/\d{2,4}x\d{2,4}\b)`
  + position anchor (first/last 15%).

- **2026-04-25** — `extractNYSRScore` numeric "X/5" fallback matched the `3/5`
  in `Opens 3/5/2026 in New York` and `On 3/5 we saw the show`. URL filter
  didn't catch this because no URL markers. Position anchor alone isn't
  enough — verdict lines often live in the first 15% where dates also appear.
  Fix: require explicit rating keyword (stars/★/☆/rating) immediately after
  the `/5` via lookahead.

## How to apply

When adding a new pattern that includes `\d/\d` in a text extractor:

1. **Anchor** to first/last 15% of text (verdict line convention).
2. **URL/asset filter** — reject if ±30 char context contains: `http`, image
   extensions (`.jpg`, `.png`, `.webp`, etc.), `cdn`/`static`/`assets`, date
   path `/YYYY/MM/DD/`, or image dims `/NNxNN/`.
3. **Keyword guard** for bare X/5 — require `\s+(stars?|★|☆|rating)` after.
   The trailing `\b` is a footgun: `\b` matches between digit and any
   non-word char including spaces, so `(?=\s+...|\b)` accepts everything.
4. **Trailing date check** — even with a keyword, reject if `pos + match.length`
   is followed by `/\d{2,4}` (continued date fragment).

Lockdown convention used: `/(\d)\s*\/\s*5(?=\s+(?:stars?\b|★|☆|rating\b))/gi`
plus a post-match tail check `if (/^\s*\/\s*\d{2,4}/.test(tail)) continue;`.
