---
name: Possessive-prefix dedup gap (Disney/Roald Dahl allowlist was too narrow)
description: normalizeTitle in scripts/lib/deduplication.js used a 2-entry allowlist for possessive prefixes; now strips a generic 1-3-word prefix, with the FP risk caught by isMultiProduction venue/year check.
type: feedback
originSessionId: a1361909-77b0-4317-9634-c2c4716117d5
archived: true
---
`scripts/lib/deduplication.js::normalizeTitle` originally only stripped
`Disney's` / `Roald Dahl's` possessive prefixes. That meant titles like
"Thornton Wilder's The Emporium" stayed full-length and never collided
with the existing "The Emporium" entry — Two Off-Broadway entries
shipped at the same venue (Classic Stage Company), surfaced by the user
on 2026-05-03.

**Why:** Author/brand prefixes are a stable Broadway/Off-Broadway naming
pattern (Stephen Sondheim's, Andrew Lloyd Webber's, Bob Fosse's, etc.).
A hardcoded allowlist guarantees the next never-seen-before author
breaks dedup again.

**How to apply:**
- normalizeTitle now strips a generic `^(?:[\w\.\-]+\s+){0,2}[\w\.\-]+['’]s\s+(?:the|a|an)\s+?` prefix.
- The looser stripping creates collisions like "The Band's Visit" → "visit"
  vs "The Visit" → "visit". These are caught by `isMultiProduction`:
  - Different venues, both inactive → multi-production (NEW branch added).
  - Same venue, year gap > 2 → multi-production (existing).
  - Same venue, both active → same production (existing).
- Guard tests live in `scripts/test-deduplication.js` (16 cases). Run
  before any further normalize/dedup change.
- Corpus probe is the cheapest sanity check: pairwise-scan all shows
  with the new logic and confirm 0 net-new flags.

**False-positive mitigation:** `isMultiProduction` was extended with a
"same category + different non-empty venues + neither side active =
multi-production" branch. Without that, "Bob Fosse's Dancin'" (Music
Box) vs "Dancin'" (Broadhurst) would have flagged.
