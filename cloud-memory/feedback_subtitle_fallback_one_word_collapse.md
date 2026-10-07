---
name: Subtitle-fallback splits must guard against 1-word primary collapse
description: Splitting show title on `,` or ` - ` to recover a "primary title" for matching is dangerous when the primary collapses to 1 significant word. "Inherit, the Wind" → "Inherit", "Hello, Dolly!" → "Hello", etc. — any feed item containing that bare word matches.
type: feedback
originSessionId: daa181c6-4a0a-48e5-b11b-3b74229ebe61
archived: true
---
Several discovery / matching helpers split a show title to recover a shorter "primary" form when the full-title match fails. The naive split is `showTitle.split(/,| - /)[0]`. This is dangerous for shows where the comma is **title-internal**, not a subtitle separator:

- `"Hello, Dolly!"` → `"Hello"` (primary = 1 word "Hello") → matches any review with "Hello"
- `"Inherit, the Wind"` → `"Inherit"` (primary = 1 word) → false-matches
- `"Caroline, or Change"` → `"Caroline"` → matches any review with "Caroline"
- `"Oh, Mary!"` → `"Oh"` → matches almost everything

shows.json has 30+ comma-titled Broadway shows where the comma is title-internal vs ~5 where it's a true subtitle separator (`"Beaches, A New Musical"`, `"A Beautiful Noise, The Neil Diamond Musical"`).

**Why:** Caught by ship-check round 1 (2026-04-29) on `scripts/lib/theatermania-discovery.js` + `scripts/lib/omc-discovery.js`. Both Claude QA agent and Codex adversarial review independently flagged it as P0.

**How to apply:**

Use a `safeSubtitlePrefix` helper that:
1. Always splits on ` - ` (em-dash is reliably a subtitle separator).
2. Splits on comma ONLY if followed by an article (`a`/`an`/`the`/`or`): `/^(.+?),\s+(?:[Aa]|[Aa]n|[Tt]he|[Oo]r)\s+\S/`.
3. After either split, REQUIRE the primary to have ≥2 significant words (after stop-word filter: the/a/an/of/and/in/at/on/to/for) AND length ≥3.

Reference impl: `scripts/lib/theatermania-discovery.js`'s `safeSubtitlePrefix()` (also mirrored in omc-discovery.js).

**Cost:** Beaches' bare-"Beaches" fallback fails. Aggregator paths still cover it. Acceptable trade vs. false-matching 30+ comma-internal shows.

**Don't:** generalize this to all matching code in the repo without an audit. The existing `urlLooksLikeReview` short-title fallback in review-guards.js (line 285) has its own similar guard but accepts 1-word primaries. Different context (URL slug vs feed-headline) — the slug carries more disambiguation and the failure mode is different.
