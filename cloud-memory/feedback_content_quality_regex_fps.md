---
name: content-quality regex bare-keyword FPs
description: Four content-quality pattern sets had bare-keyword regex silently misfiring on legit reviews; /recipe|ingredients|cook(ing)?/i alone matched 5.9% of reviews via "cookie" substring and metaphor.
type: feedback
originSessionId: a0578512-e6e0-4e93-81e8-4bb716033bb9
---
Before editing NAVIGATION_PATTERNS / NEWSLETTER_PATTERNS / LEGAL_PAGE_PATTERNS / WRONG_ARTICLE_PATTERNS in `scripts/lib/content-quality.js`, audit empirically against real corpus — the patterns LOOK plausible but bare-keyword versions fire on metaphorical prose and substring matches. Theater criticism routinely uses "recipe for disaster", "cooking up a hit", "ingredients for a great show", "horror-movie genre", "stock-market crash" as figurative language.

**Why:** Audit on 2026-04-24 found against 2,832 real substantial reviews (all `contentTier=complete/truncated/excerpt`):

- `/recipe|ingredients|cook(ing)?/i` → 167 hits (5.9%). `cook` matched inside `cookie` and `cookie-cutter`; `recipe for disaster` metaphor common.
- `/breaking\s+news/i` → 88 hits (3.1%). Fired on Deadline's "Get our Breaking News Alerts" newsletter boilerplate in EVERY Deadline scrape.
- `/horror\s+(film|movie)/i` → 19 hits. Legit comparisons ("trappings of the horror movie genre to prick our imaginations").
- `/stock\s+(market|prices|trading)/i` → 10 hits, all Lehman Trilogy (a play ABOUT the stock market).
- `/(footer|header|sidebar|menu|navigation)/i` → 43 hits without `\b`. Matched "drop-down menu for" dialogue, "mso-header-margin" Word-doc CSS in a review, "One sidebar to the play" metaphor.
- `/^insidious/im` — `/m` flag would match any line starting with Insidious, not just doc start.

**How to apply:** When adding or editing these regex families:
1. Require `\b` word boundaries on bare nouns.
2. Drop or narrow patterns that match theater metaphors (recipe / ingredients / breaking news / stock market / box office numbers / weather report).
3. Require context (quantitative terms, line anchors, uppercase proper nouns) for soft patterns — `horror film` alone isn't a signal; `horror film [Title]` at line start is.
4. **Run `node scripts/audit-regex-patterns.js --full` before pushing.** Exit 1 means the gate caught a new FP — tighten the pattern or add to the allowlist with a comment explaining why (typically, the pattern legitimately detects scrape pollution that's absorbed by trailing-junk mitigation downstream). CI in `test.yml` enforces this on merge. CLAUDE.md rule 12 requires it. Acceptance bar: default 5 hits/pattern across the 18,740-review corpus; per-pattern allowlist for known-noisy detectors calibrated to baseline + 30% headroom.
5. Most rejection damage came from the NAVIGATION `5+ patterns matched` threshold in `detectNavigationJunk`, NOT from wrong-article patterns directly — `detectWrongArticle` only adds to `assessTextQuality.issues[]`, which tolerates 1 issue as valid/medium-confidence. But defense-in-depth still matters: these guards may change, and bare substring matches are just wrong.

**Additional bugs the harness caught on 2026-04-24 (fixed in same PR):**
- `/ad\s*block(er)?/i` → matched inside "roadblock" (17 hits). Fix: add `\b`.
- `/not\s+(been\s+)?found/i` → matched "not been found guilty" (13 hits). Fix: drop the pattern (standard error-page phrases covered by siblings).
- `/404\s+(error|not\s+found)?/i` → matched SVG path `d="M11.404 8.74"` (12 hits). Fix: require the error suffix + `\b` boundary.
- `/has\s+been\s+(removed|deleted|taken\s+down)/i` → matched "the song has been removed", "that has been deleted" (14 hits). Fix: require page/article/content subject.
- `/election\s+(results|coverage)/i` → metaphorical ("diversion from the onslaught of election coverage"). Fix: narrow to line-start or concrete-news qualifier.

Fix shipped as part of opening-night-hardening work after the `rebuild-all-reviews.js` regex FP (`/not a review/` matching a quoted critic phrase) revealed this whole class of bug. See scripts/lib/content-quality.js:119-155 for current patterns.
