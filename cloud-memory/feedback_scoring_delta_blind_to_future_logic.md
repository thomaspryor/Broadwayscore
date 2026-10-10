---
name: scoring-delta is blind to changes that only affect future extractions
description: scoring-delta.js replays stored originalScore values against new logic. Zero flips ≠ "new logic is correct" — it means "no existing files changed." Changes to extractors only show up when re-run on real fetched HTML.
type: feedback
originSessionId: a97024db-80fe-4390-980a-840a895de55d
archived: true
---
# scoring-delta blind spot

`scripts/scoring-delta.js` (Phase B watchlist) is mandatory before pushing
changes to `score-extractors.js` etc. It replays `getBestScore()` and
extractor outputs on EXISTING review-text files in the corpus.

**What it catches:** changes in scoring/inclusion logic that produce different
outputs from the SAME stored input. Inclusion flips, score routing changes,
parser disagreements on already-stored `originalScore` strings.

**What it does NOT catch:** changes to extractor functions that produce
DIFFERENT outputs only when given fresh HTML/text input. The corpus has
stored `originalScore` values from past extraction runs; the new extractor
logic doesn't run because the stored value is consumed directly.

In this codebase 2026-04-24/25:
- 4 scoring-extractor changes shipped, scoring-delta showed 0 flips each
  time across 35,773 / 35,799 / 35,910 reviews.
- All 4 changes added URL/anchor guards to text-pattern fallbacks.
- The reason scoring-delta was clean: those fallbacks rarely fire on the
  current corpus (most outlets had structured selectors hit first), so the
  new guards rejected nothing that wasn't already null.

**Implication:** "scoring-delta clean" is necessary but not sufficient for
extractor changes. To verify the change actually does what you intend:

1. **Synthetic fixture tests** — feed the new extractor inputs that would
   have triggered the old behavior and confirm rejection/acceptance.
2. **Live corpus probe** — grep recently-fetched files (last 30 days) for
   the input pattern you're guarding against. If the corpus has examples,
   verify the new logic handles them.
3. **End-to-end after deploy** — run the next pipeline cycle (collect-
   review-texts.js) against a real opening-night URL and confirm the
   extractor produces the expected `originalScore`.

## How to apply

When the change description is "harden extractor X against false positive Y":
- Don't end the guard suite at scoring-delta + temporal regression.
- Add ≥3 synthetic test cases (FP rejected, legit start accepted, legit
  end accepted) hitting the specific input pattern.
- Add a corpus grep that returns >0 examples of the input you're guarding,
  then run the extractor against them and verify behavior.
