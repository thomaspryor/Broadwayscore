---
name: Retired-critic guards need bounded freelance window, not binary flag
description: A `freelanceAfter: true` flag treats post-cutoff attributions as soft-warn forever; a `freelanceUntilDate` bounded window correctly hard-blocks parser garbage past the freelance era
type: feedback
archived: true
---

When building a temporal guard for retired critic attributions (Brantley, Stasio, etc.), don't use a binary `freelanceAfter: true` flag. It treats every post-cutoff date as soft-warnable, even years past when the critic stopped freelancing. Parser garbage attributing 2026 reviews to a critic last seen 2023 silently passes.

**How to apply:** Use bounded `freelanceUntilDate` instead. Three states:
- `pubDate <= lastActiveDate`: pass clean (within active period)
- `lastActiveDate < pubDate <= freelanceUntilDate`: soft-warn (real freelance possible)
- `pubDate > freelanceUntilDate`: HARD-BLOCK + downgrade to Unknown (parser garbage)

For deceased critics, never set freelanceUntilDate — death is a hard cutoff.

**Real incident:** 2026-04-26 integration test caught Brantley 2026-04-15 attribution soft-warning when it should hard-block. Brantley retired Oct 2020, last freelance ~2023 → freelanceUntilDate: '2023-12-31' fixed it. Same pattern applied to Stasio, Gerard, Marks.

See: `scripts/lib/temporal-byline-guard.js`
