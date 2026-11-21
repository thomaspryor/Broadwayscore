# BRO-3875: soft content-type wrong-show investigation

Measured 2026-10-20 against the supplied private corpus and canonical
`data/shows.json`. No private text or source records were changed.

## Result

There is an actionable population: **four confirmed files about other plays**
in the 20-file manually inspected sample below. A fifth concerns a different
concert. This is a confirmed lower bound, not an estimate of all mismatches
in the corpus. Files mentioning their filed title can still be misattributed,
and the existing permissive title matcher can hide candidates.

Do not generalize the automatic `nonReviewType === 'review'` promotion.
An absent filed title, even alongside repeated mentions of another title,
does not distinguish wrong-show content from a legitimate discussion of a
related work. The verified John Proctor case is a concrete counterexample.
The new audit section is report-only and never participates in `--apply`
or `--gate`. No classification, score or source flag changes.

## Measurement and reproducibility

Run `node scripts/audit-review-type-wrong-show.js --json` and inspect
`softTypes`. The same script already runs in `check-corpus-drift.yml`.
It reads local files, with zero paid fetches, LLM calls or API calls.

Before the change, the audit scanned 57,790 files, found one review-type
promotion candidate, and reported nothing about soft types. Afterward it
scans the same 57,790 files and returns the identical one review-type hit,
plus these mutually exclusive soft-type coverage counts:

| Coverage | Files |
| --- | ---: |
| Protected by human clear or opening-night lane | 8 |
| Missing usable text | 29 |
| Already excluded by canonical wrong-show/production, rejection or garbage checks | 261 |
| Missing canonical show metadata | 0 |
| Filed title mentioned | 84 |
| Filed title absent, requires inspection | 34 |
| Total soft-type files | 416 |

The six types contain 244 news, 69 feature, 66 preview, 24 interview,
11 profile and two obituary files. Before prioritizing human protections,
148/416 already carry `wrongShow` or `wrongProduction`; another 148 are
covered by existing exclusion mechanisms. These overlapping diagnostic
counts explain the original blind spot but are not additional records.

The absence check reuses `isMentioned()` and `normalizeForMatch()` from
`essay-intro-nonreview-fp.js`, applied to the canonical title, without reading
metadata from URLs or directory names. All six types are scanned regardless
of article length or URL shape. Missing text, missing metadata and existing
protections are counted separately. This is a triage pool, not a precision
rule. Searching other catalog titles in the text was also noisy: navigation
repeats current Broadway shows, film titles need not exist in our catalog,
and discussions of source works can mention those works more often.

## Hand-verified sample

Twenty files were deliberately selected from the 34 suspects to include
different sources, types and failure modes. Their full saved content was
inspected; the descriptions below are original summaries. This is an
enriched diagnostic sample, not a random prevalence estimate. Four of 20
(20%) are clearly about a different play; ten more concern other content
(two films, five unrelated news articles, two theater events and a concert).
The other six are related material, a correct review, extraction failures
or insufficient evidence. These results do not validate auto-application.

Paths are relative to the private `data/review-texts/` directory.

| File | Type | Inspection result |
| --- | --- | --- |
| `fully-committed-2016/theatermania--adam-feldman.json` | news | **Different play:** extension announcement for Incident at Vichy at Signature's Irene Diamond Stage, not Fully Committed at the Lyceum. |
| `kinky-boots-2013/theatermania--charles-isherwood.json` | news | **Different play:** casting and ticket announcement for A Raisin in the Sun at the Ethel Barrymore, not Kinky Boots at the Al Hirschfeld. |
| `school-of-rock-the-musical-2015/theatermania--jesse-green.json` | news | **Different play:** Bernadette Peters discussing Patti LuPone's phone incident at Shows for Days at Lincoln Center. No School of Rock coverage. |
| `shuffle-along-or-the-making-of-the-musical-sensation-of-1921-and-all-that-followed-2016/theatermania--jesse-green.json` | news | **Different play:** Preludes cast album announcement, describing its Claire Tow Theater production. No Shuffle Along coverage. |
| `sunset-boulevard-2017/theatermania--jesse-oxfeld.json` | news | Different concert: Broadway Sings Beyonce at Highline Ballroom. Cast credits for many musicals are incidental. |
| `death-of-a-salesman-2012/variety--marilyn-stasio.json` | feature | Different film: Werner Herzog's Death Row documentary, not the Miller play. |
| `fela-2012/variety--marilyn-stasio.json` | news | Different film: Peter Mettler's The End of Time, including documentary production credits. |
| `frozen-2018/usatoday--elysa-gardner.json` | news | Unrelated baseball game report about Florida State and Central Florida. |
| `king-kong-2018/usatoday--david-oliver.json` | news | Unrelated report on Sears store closures in Memphis malls. |
| `les-liaisons-dangereuses-2016/usatoday--elysa-gardner.json` | news | Unrelated Denville school district planning notice. |
| `meteor-shower-2017/usatoday--elysa-gardner.json` | news | Unrelated university fraternity suspension report. |
| `the-price-2017/usatoday--elysa-gardner.json` | news | Unrelated New Jersey state budget hearing report. |
| `indecent-2017/theatermania--jesse-green.json` | news | Unrelated NAMT festival casting announcement. Multiple musical titles are cast credits, not evidence for one alternate show. |
| `romeo-and-juliet-2013/theatermania--adam-feldman.json` | news | Unrelated 2014 Theatre World Awards ceremony. Multiple productions appear as honoree credits. |
| `john-proctor-is-the-villain-west-end-2026/british-theatre--keith-mckenna.json` | preview | **Correct show:** review of Belflower's students and teacher, discussing The Crucible as a work studied by its characters. The filed title is absent. Do not flag wrongShow. |
| `alice-in-wonderland-off-broadway-2026/goodstoriespodcast--unknown.json` | feature | Related Alice story podcast promotion. Missing the full title does not establish another show's identity. |
| `purlie-victorious-2023/cititour--brian-scott-lipton.json` | news | Ticket/social fragment with insufficient prose to establish another show. |
| `a-dolls-house-part-2-2017/off-script-with-dan-dwyer--dan-dwyer.json` | feature | Unrelated fandom/social posts, no identifiable alternate stage production. |
| `high-2011/bloomberg--jeremy-gerard.json` | news | Failed article-render message and site chrome. No alternate show. |
| `the-little-mermaid-the-musical-off-broadway-2026/thestage--katie-chambers.json` | news | Musical-theatre category/index with many unrelated headlines. No single alternate show. |

## Writer, wiring and limits

`classify-non-reviews.js` writes `isNonReview = true` and
`nonReviewType = nr.contentType`. This is correct for these articles; changing
that writer to infer wrongShow would overstate its evidence. The missing
consumer coverage is in `audit-review-type-wrong-show.js`, whose scan now
calls `bucketSoftTypeWrongShow()` from `scripts/lib/`. The original
`isReviewTypeWrongShowGap()` still exclusively controls promotion and gating.

HEAD and origin/main were both `da2bf4ee459bb38810fcbb80cb50f706ff14bca0`
at the start. The card's acceptance command failed there because its test
file was absent. `git log -S 'isReviewTypeWrongShowGap' --oneline -5` could
not complete: the partial clone needed an unavailable historical object
and lazy fetching failed against the read-only shared git object store.
Current main's checked-out source and real-data audit confirmed the missing
soft-type coverage independently.

This investigation adds monitoring and a hermetic acceptance test. It does
not backfill private records or claim an exhaustive mismatch count. A future
auto-apply rule needs additional verified evidence beyond title frequency.

## Validation

Reproduction: `node --test tests/unit/nonreview-soft-type-wrongshow.test.mjs`
failed before the change with `Could not find` that path. The identical
command now passes all 16 tests.

Related tests: 57 passed, zero failed:

```sh
node --test --test-timeout 300000 tests/unit/nonreview-contenttype-wrongshow.test.mjs tests/unit/nonreview-slug-coverage.test.mjs tests/unit/essay-intro-nonreview-fp.test.mjs scripts/audit-exclusion-flags.test.mjs scripts/lib/apply-scripts-verify-pushed-scan.test.mjs
```

Real-data checks, all exited zero:

```sh
node scripts/audit-review-type-wrong-show.js --json
node scripts/audit-review-type-wrong-show.js --show=fully-committed-2016
node scripts/audit-review-type-wrong-show.js --show=kinky-boots-2013
node scripts/audit-review-type-wrong-show.js --show=john-proctor-is-the-villain-west-end-2026
node scripts/audit-review-type-wrong-show.js --show=benevolent-off-broadway-2026
node scripts/audit-review-type-wrong-show.js --show=benevolent-off-broadway-2026 --gate --max=0
```

The first three scoped runs report one, two and one suspects respectively.
The Benevolent interview mentions its filed title, so both its report and
gate run return zero suspects. The full-corpus review-type hit list is
byte-for-byte equal before and after; the added report covers 416 soft-type
records and surfaces 34 suspects. Source records changed: zero.

No TypeScript, UI, scoring logic or content-quality pattern arrays changed.

`GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`
completed in 101 seconds. The gate exited 1 solely because `actionlint`
is unavailable (`actionlint: command not found`, exit 127), the exception
allowed by the task. Reading `lint-workflows.log` confirmed no other failing
checks, including test collection and top-level/lib dependency coverage.
`git diff --check` passed. Generated audit JSON was restored to HEAD;
temporary corpus copies and gauntlet output were deleted after inspection.
