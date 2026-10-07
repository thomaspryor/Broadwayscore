---
name: Cached aggregator archives need page-title validation on every read
description: Every script that reads data/aggregator-archive/*/{showId}.html must verify the cached HTML actually matches that show before extracting reviews. Cache key alone is not integrity.
type: feedback
originSessionId: 66add4a9-4817-4099-a620-3023958a503b
archived: true
---
When an aggregator archive is keyed by `{showId}.html`, the file path is just a *claim* about what the cache holds. The original fetch may have written the wrong show's HTML (URL-matching bug, ID recycling, race), and once a poisoned archive is on disk every downstream reader that trusts the path will file reviews against the wrong show.

**Why:** Stuart King (LBO Head Reviewer) reported on 2026-04-25 that we'd attributed an Oh, Mary! roundup excerpt to him on Magic Mike Live and a Paddington excerpt on Teeth 'n' Smiles. Audit found 14 of 29 cached LBO roundup archives held the wrong show's HTML — and three independent readers (`scrape-london-box-office-roundups.js`, `opening-night-poller.js`, `gather-reviews.js`) were each consuming those archives without checking. Even the LBO scraper's own page-title check ran *after* the archive write, so a rejected fetch still poisoned the cache for the others.

**How to apply:**
- Any script that reads `data/aggregator-archive/<source>/<showId>.html` must call a `validateRoundupPageTitle(html, show.title)`-equivalent before doing anything with it.
- Validation runs *before* archive write on the producer side too — never persist HTML you've already decided not to use.
- On read, quarantine bad archives by renaming to `*.mismatch` so the next run rediscovers fresh content instead of re-poisoning. Don't silently delete (loses forensic data).
- Use whole-word matching (e.g. `titleWordsMatchWithConfidence` in `scripts/lib/show-matching.js`), not `pageTitle.includes(word)` — substring matching lets "lively" satisfy a check for "live".
- Sitemap fallback URL→show matching should reuse `matchTitleToShow` with `confidence === 'high'`, not bespoke "≥N word overlap" rules. Common words like "the" and "musical" cause false positives that look reasonable in isolation (e.g. "Trainspotting the musical" fuzzy-matched the Paddington The Musical roundup URL because both share "the" and "musical").

Helper: `scripts/lib/show-matching.js#validateRoundupPageTitle`. Regression test: `tests/unit/lbo-roundup-page-validation.test.mjs`.
