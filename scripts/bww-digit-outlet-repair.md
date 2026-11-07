# BRO-4371: repair archived BWW quote boundaries

The parser already recognizes digit-leading outlets. The normal excerpt merge
only replaces an existing quote when the replacement is longer, so it cannot
remove a previously swallowed byline. The explicit repair mode uses the audit's
source evidence instead of that length preference.

## Run in a checkout authorized to write private reviews

Preview first. This scans local archives and reports file paths and lengths,
without review text or network calls:

```bash
node scripts/merge-aggregator-excerpts.js --repair-bww-digit-outlets --bww-archive-dir=data/review-texts/aggregator-archive/bww-roundups
```

Use `data/aggregator-archive/bww-roundups` instead if that is where the private
archives are mounted. To apply the reviewed targets, repeat with `--write`.
The audit mode, `--audit-bww-digit-outlets`, is always read-only.

The repair requires the production archive checker and the same outlet, exact
normalized quote prefix, and following digit-outlet byline as the audit. It
changes only proven corrupt `bwwExcerpt` or `fullText` fields. Clean longer
excerpts and unrelated full articles are preserved. Locked/excluded records and
conflicting source quotes go to manual review. Writes use `safeWriteReview`
without force, then check that the intended fields persisted. Full-text repairs
refresh existing word counts and record `fullTextTrimmed` for restore protection.

After applying, repeat the audit and run:

```bash
node scripts/verify-review-recovery.js --show=SHOW_ID --production
```

Run this recovery check for each repaired show before closing the card.

## Local snapshot verified on 2026-10-28

The sweep scanned 844 HTML archives and found seven corrupted excerpts:

| Show ID | Stored length | Clean length |
| --- | ---: | ---: |
| and-then-the-rodeo-burned-down-off-broadway-2026 | 500 | 352 |
| bigfoot-off-broadway-2026 | 500 | 444 |
| bloodlove-off-broadway-2026 | 500 | 341 |
| disruption-off-broadway-2026 | 500 | 416 |
| jerome-off-broadway-2025 | 500 | 406 |
| the-whoopi-monologues-off-broadway-2026 | 500 | 437 |
| the-winters-tale-off-broadway-2026 | 500 | 277 |

On disposable copies of 311 real review records, the repair changed exactly
these seven `bwwExcerpt` fields. The other 304 records stayed byte-identical.
The audit went from seven findings to zero, and a second repair wrote nothing.
No private source records were changed. Applying these repairs and running the
seven recovery checks remains necessary; replacement review text cannot go in
a public pending-fix plan.

All 16 warnings in the available snapshot were inspected:

- Eight compact `1minutecritic` spellings were URLs, with no compact bylines.
- Six malformed JSON-LD blocks each accompanied a readable article body already
  scanned. Their 79 recoverable liveblog bodies contained no digit-outlet pairs.
- The Blackout Songs archive passed the checker against
  `blackout-songs-off-broadway-2026`; its 23 reviews had no findings.
- The archive keyed `imitation-of-life-2026` actually names The Unknown in page
  metadata. It passes the checker against `the-unknown-off-broadway-2026`, whose
  21 reviews had no findings. Correcting that private archive's storage key
  requires a separate authorized file move.

The six wrong-production archives mentioned in earlier card comments are not
reproduced by this snapshot: none of its parsed digit-outlet archives is rejected
by the production checker, and no Lion King archive is present. Obtain the
historical archives and their correct-production replacements, then audit them
before declaring those older warnings resolved.

## Validation

The acceptance command passed all five tests:

```bash
node --test tests/unit/bww-roundup-parser-digit-outlet.test.mjs
```

The changed test and all discovered parser/merge dependents passed 78 tests:

```bash
rg -l 'bww-digit-outlet-audit|merge-aggregator-excerpts|bww-roundup-parser' tests scripts --glob '*.test.*' > /tmp/bro-4371-tests.txt
node --test --test-timeout 300000 $(cat /tmp/bro-4371-tests.txt)
```

The lint-workflows gauntlet completed its code audits. Its only failed subgate
was the unavailable `actionlint` binary. The parser, acceptance test, and parser
dependencies matched `origin/main`; no parser changes were needed. History
search with `git log -S` could not complete because the shallow clone attempted
to fetch missing objects into the read-only shared Git directory.
