# Hollywood Reporter Broadway coverage gap (BRO-4927)

Investigation date: 2026-10-20. Status: incomplete; a collection/retention gap is confirmed, but a general reduction in THR's published coverage is not established. This document satisfies the file-existence check, not the outstanding backfill and archive-verification work.

## Findings for the card

The supplied `reviews.json` contains **23 THR reviews of Broadway productions opening in 2023-2026**. At least one more published review exists: [THR's Purpose review](https://www.hollywoodreporter.com/lifestyle/arts/purpose-review-phylicia-rashad-1236166923/), independently indexed as [syndicated on Yahoo](https://www.yahoo.com/entertainment/purpose-review-broadway-directorial-debut-214632027.html) under Lovia Gyarkye, March 19, 2025. The private source file already contains the review, but it is excluded from the derived corpus. Thus the published-review inventory has a **lower bound of 24**, not an exhaustive site total.

| Broadway opening year | Count quoted in card | Current `reviews.json`, Broadway only | THR sources accounted for, minimum | Confirmed missing from `reviews.json` |
| --- | ---: | ---: | ---: | ---: |
| 2023 | 3 | 4 | 4 | 0 identified |
| 2024 | 8 | 8 | 8 | 0 identified |
| 2025 | 8 | 7 | 8 | 1: Purpose |
| 2026, through October 20 | 4 | 4 | 4 | 0 identified |
| Total | 23 | 23 | 24 | 1 |

The minimum combines the 23 included records, backed by stored complete THR source records, with Purpose. It must not be described as a successful enumeration of THR's live archive. Zero identified misses in a year does not establish complete collection.

Counts use `shows.json`'s explicit `category === 'broadway'` and `openingDate`, joined to `reviews.json` by `showId`, with `outletId === 'hollywood-reporter'`. No production, critic or publication metadata was inferred from URL strings. One review counts once even when multiple private files have the same article URL. Publication dates below are the stored dates, not newly verified live-page timestamps.

The card's earlier counts cannot be reproduced exactly from this snapshot. Without a market filter, the opening-year counts are 4, 8, 9 and 5. The extra records are the West End productions All My Sons and Evita in 2025 and Electra/Persona in 2026. The current Broadway-only baselines for 2019 and 2022 are 29 and 15 respectively. These differences are reasons to retain the counting definition, not to claim the card's discrepancy was already repaired.

## Included source inventory

Every link in this table comes from an existing `reviews.json` record and has a corresponding complete private THR source record. Direct live access to the linked articles was not established in this run.

| Opening year | Production and stored THR URL | Stored publication date |
| --- | --- | --- |
| 2023 | [A Doll's House](https://www.hollywoodreporter.com/lifestyle/arts/a-dolls-house-review-jessica-chastain-1235347184/) | 2023-03-10 |
| 2023 | [Fat Ham](https://www.hollywoodreporter.com/lifestyle/arts/fat-ham-broadway-theater-review-1235391595/) | 2023-04-13 |
| 2023 | [Back to the Future](https://www.hollywoodreporter.com/lifestyle/arts/back-to-the-future-the-musical-theater-review-a-fun-faithful-stage-adaptation-hits-broadway-1235548700/) | 2023-08-03 |
| 2023 | [Appropriate](https://www.hollywoodreporter.com/lifestyle/arts/appropriate-theater-review-sarah-paulson-elle-fanning-1235765661/) | 2023-12-19 |
| 2024 | [An Enemy of the People](https://www.hollywoodreporter.com/lifestyle/arts/an-enemy-of-the-people-theater-review-jeremy-strong-michael-imperioli-broadway-ibsen-revival-1235854269/) | 2024-03-18 |
| 2024 | [Stereophonic](https://www.hollywoodreporter.com/lifestyle/arts/stereophonic-review-theater-david-adjmi-broadway-1235877998/) | 2024-04-19 |
| 2024 | [Patriots](https://www.hollywoodreporter.com/lifestyle/arts/patriots-review-michael-stuhlbarg-peter-morgan-putin-1235879043/) | 2024-04-23 |
| 2024 | [Illinoise](https://www.hollywoodreporter.com/lifestyle/arts/illinoise-review-sufjan-stevens-justin-peck-broadway-theater-1235882171/) | 2024-04-25 |
| 2024 | [Oh, Mary!](https://www.hollywoodreporter.com/lifestyle/arts/oh-mary-theater-review-cole-escola-broadway-1235945864/) | 2024-07-11 |
| 2024 | [Sunset Boulevard](https://www.hollywoodreporter.com/lifestyle/arts/sunset-blvd-broadway-review-nicole-scherzinger-andrew-lloyd-webber-jamie-lloyd-1236038232/) | 2024-10-20 |
| 2024 | [Romeo + Juliet](https://www.hollywoodreporter.com/lifestyle/arts/romeo-and-juliet-theater-review-kit-connor-rachel-zegler-shakespeare-jack-antonoff-1236043115/) | 2024-10-24 |
| 2024 | [Gypsy](https://www.hollywoodreporter.com/lifestyle/arts/gypsy-theater-review-audra-mcdonald-broadway-1236091036/) | 2024-12-19 |
| 2025 | [Othello](https://www.hollywoodreporter.com/lifestyle/arts/othello-theater-review-denzel-washington-jake-gyllenhaal-shakespeare-broadway-1236170552/) | 2025-03-23 |
| 2025 | [Glengarry Glen Ross](https://www.hollywoodreporter.com/lifestyle/arts/glengarry-glen-ross-review-kieran-culkin-bob-odenkirk-1236175987/) | 2025-03-31 |
| 2025 | [Good Night, and Good Luck](https://www.hollywoodreporter.com/lifestyle/arts/good-night-and-good-luck-theater-review-george-clooney-broadway-1236181072/) | 2025-04-03 |
| 2025 | [John Proctor Is the Villain](https://www.hollywoodreporter.com/lifestyle/arts/john-proctor-is-the-villain-review-sadie-sink-broadway-1236190543/) | 2025-04-14 |
| 2025 | [Waiting for Godot](https://www.hollywoodreporter.com/lifestyle/arts/waiting-for-godot-broadway-review-keanu-reeves-alex-winter-1236387450/) | 2025-09-28 |
| 2025 | [Little Bear Ridge Road](https://www.hollywoodreporter.com/lifestyle/arts/little-bear-ridge-road-review-laurie-metcalf-broadway-1236414531/) | 2025-10-31 |
| 2025 | [Chess](https://www.hollywoodreporter.com/lifestyle/arts/chess-theater-review-lea-michele-aaron-tveit-abba-musical-1236427952/) | 2025-11-17 |
| 2026 | [Dog Day Afternoon](https://www.hollywoodreporter.com/lifestyle/arts/dog-day-afternoon-review-theater-jon-bernthal-broadway-1236551286/) | 2026-03-31 |
| 2026 | [Death of a Salesman](https://www.hollywoodreporter.com/lifestyle/arts/death-of-a-salesman-theater-review-nathan-lane-broadway-1236560881/) | 2026-04-10 |
| 2026 | [The Fear of 13](https://www.hollywoodreporter.com/lifestyle/lifestyle-news/the-fear-of-13-theater-review-adrien-brody-tessa-thompson-1236566080/) | 2026-04-15 |
| 2026 | [Other Desert Cities](https://www.hollywoodreporter.com/lifestyle/arts/other-desert-cities-theater-review-julia-louis-dreyfus-1236734079/) | 2026-10-19 |

Public corroboration includes [BroadwayWorld's Back to the Future review listing](https://www.broadwayworld.com/reviews-critics/Frank-Scheck?filter=up&page=3), [Playbill's Oh, Mary! verdict links](https://playbill.com/article/reviews-what-do-critics-think-of-cole-escolas-oh-mary-on-broadway), and [BroadwayStars' Rooney index](https://broadwaystars.com/search/?author=David+Rooney). The latter corroborates seven of the held 2024 Broadway articles and several in 2025, but jumps from February 2024 to 2018. It omits known 2023 articles and therefore cannot establish THR's annual publication totals. Its byline labels also disagree with some stored records. It is discovery evidence, not authority for correcting critic attribution.

## Confirmed retention gap: Purpose

`data/review-texts/purpose-2025/hollywood-reporter--lovia-gyarkye.json` has:

- A complete, approximately 1,012-word source record, with `bww-reviews`, `dtli` and `bww-roundup` provenance.
- The correct article URL, but the misspelled stored `criticName` of `Lovia Gayarkye`.
- `wrongAttribution: true` and `_c2FixReason: 'typo-variant'`.
- `_c2CorrectFile: 'hollywood-reporter--lovia-gyarkye.json'`, pointing to itself.
- A duplicate-cycle-clear breadcrumb. The directory currently contains only this one THR file, with no separate typo file and surviving canonical counterpart.

Calling the real `explainExclusion()` from `scripts/lib/review-guards.js` on this file returns `wrongAttribution`. The rebuild explicitly skips this flag at `scripts/rebuild-all-reviews.js:4382`. This explains the exclusion without changing the scoring gates. The [BroadwayWorld Purpose roundup](https://www.broadwayworld.com/article/Review-Roundup-Phylicia-Rashad-Directs-PURPOSE-By-Branden-Jacobs-Jenkins-On-Broadway-20250317) supplies an additional public recovery lead.

The source annotation identifies a typo correction as the intended operation. A related writer, `scripts/fix-critic-typos.js:178-195`, flags a typo record while preserving a separate canonical record. A repository search did not locate the writer of the exact `_c2FixReason` annotation, so this investigation does not claim that script caused the current self-reference.

Recovery requires access to write the private review-texts repo: verify the original byline, repair the canonical source's attribution and stale exclusion state while preserving provenance, then run the normal rebuild and `node scripts/verify-review-recovery.js --show=purpose-2025 --production`. Verify that exactly one Purpose THR record appears. Re-scraping is unnecessary if the stored article is verified complete. Do not manually add a derived `reviews.json` row or weaken the global wrong-attribution guard.

That repair was not attempted: the task explicitly makes `data/review-texts` read-only. Any edits to the supplied core-data copies would also be discarded by the runner.

## Unverified candidates and valid exclusions

A read-only scan found 69 THR-named private files under the relevant Broadway production directories, including duplicate bylines, stubs, news and rejected content. That is a file count, not 69 published Broadway reviews.

Do not bulk-promote these records:

- Parade and Shucked (2023) contain unverified `web-search` excerpt candidates. The real inclusion helper returns `unverifiableWebSearchRow` for the inspected candidates. Their review-like URLs and assigned numbers do not establish that those articles exist.
- Other excerpt-only leads include New York, New York; The Sign in Sidney Brustein's Window; The Shark Is Broken; The Notebook; and The Who's Tommy. They require source verification before any backfill.
- Mary Jane (2024) has a stored 404, a wrong-show flag and a feature classification. The helper returns `unverifiableWebSearchRow`. Re-fetch and inspect the actual article before deciding whether the earlier classification was correct.
- Cult of Love (2024) has stored text but the helper returns `crossOutletDuplicate`. Its THR attribution has not been verified. Do not count it as a confirmed THR miss.
- Other records refer to an earlier production, film/TV coverage, closing news, casting news or box-office reports. Examples include Parade's Mark Taper Forum production, Merrily's earlier New York Theatre Workshop run, the Wiz Live television production, and the 2026 Beaches closing article. They do not establish missing reviews of the requested Broadway openings.

## Discovery and access checks

The existing discovery path already includes THR:

- `scripts/lib/site-search-discovery.js:267-272` configures its title search with `requiresJs: true`.
- `scripts/gather-reviews.js:5424-5439` calls that JS search for missing outlets when a ScrapingBee key is available. Its imported `searchOutletSites()` implementation is the existing caller, not a proposed new path.
- `scripts/lib/rss-discovery.js:78` lists THR's feed.
- `scripts/gather-reviews.js:3164` defines `createReviewFile()`, the source-record writer, and the gather loop calls it at line 5790. The script then rebuilds the derived corpus. Purpose's aggregator provenance shows it was already discovered; its present failure is retention after attribution handling.

No discovery code change is justified by the evidence available here. A generic search or exclusion change could admit the unverified candidates above.

Attempts in this environment:

1. Web access to THR's arts archive, theater topic, author index and sample article pages failed. The arts archive and Purpose article returned `402 Payment Required`; other requests returned inaccessible/internal-error responses. Searches restricted to THR returned no results. Empty search results are not evidence that reviews were never published.
2. The real `fetchPage()` was tried on three distinct paths: `https://www.hollywoodreporter.com/c/lifestyle/arts/`, `https://www.hollywoodreporter.com/?s=Parade+review`, and the A Doll's House URL in the inventory. All returned `All scraping methods failed`. Bright Data, ScrapingBee and Browserbase credentials were absent, and Playwright reported that its Chromium executable does not exist. No browser or dependency installation was attempted.
3. Public secondary indexes and THR syndication were searched for all four years. These support individual articles and the Purpose miss, but do not yield a complete THR archive.

The outlet registry was left unchanged. Recording a verified cutback or suppressing missing-review expectations would overstate this evidence.

## Reproduction and verification

The acceptance command failed before the edit (exit 1) and passes after adding this report:

```sh
test -f docs/hollywood-reporter-coverage-gap.md
```

The supplied fresh-main check also reports that path missing. `git cat-file -e origin/main:docs/hollywood-reporter-coverage-gap.md` confirmed its absence in the available main tree. `git log -S 'hollywood-reporter-coverage-gap' --oneline -5` could not complete because a historical object was absent and lazy fetching tried to write the read-only parent Git object store. Repeating with `GIT_NO_LAZY_FETCH=1` also failed. No claim is made that the full history search passed.

The repository's `/docs/*` ignore rule initially hid the new report from `git status`. A narrow exception in `.gitignore` now includes this exact document, so the runner can retain it in the task diff.

Reproduce the current corpus counts without network access or writes:

```sh
node - <<'NODE'
const shows = new Map(require('./data/shows.json').shows.map(s => [s.id, s]));
const reviews = require('./data/reviews.json').reviews;
for (const year of [2023, 2024, 2025, 2026]) {
  const rows = reviews.filter(r => {
    const show = shows.get(r.showId);
    return r.outletId === 'hollywood-reporter' && show?.category === 'broadway'
      && show.openingDate?.startsWith(String(year));
  });
  console.log(year, rows.length, rows.map(r => r.showId).join(','));
}
NODE
```

Before and after this documentation edit, counts are **4, 8, 7, 4** and **zero data records change**. Real-code inclusion probes likewise preserve Purpose as `wrongAttribution`, A Doll's House and Back to the Future as eligible, Mary Jane and Shucked as `unverifiableWebSearchRow`, and Cult of Love as `crossOutletDuplicate`. SHA-256 comparisons of shows, reviews and the outlet registry verify no data mutation. No review text is copied into this report.

There are no new scripts, functions, flags, tests or workflow changes. No TypeScript, scoring or content-quality regex logic changed. There are **zero added paid fetches, LLM calls or API calls per run**, and no cron change.

Additional verification:

```sh
node --test --test-timeout 300000 tests/unit/reconcile-retired-ids.test.mjs scripts/tests/tracked-and-ignored-guard.test.mjs tests/unit/cloud-routines-docs.test.mjs
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
git diff --check
```

The three test files passed all 24 tests. The workflow audit log reported only the missing `actionlint` executable as a gate failure (`actionlint: command not found`, exit 127); the task explicitly permits ignoring that missing tool. Other audit gates passed, with existing advisory warnings. Whitespace checks passed. Ignore-rule probes confirmed that this report is included while an unrelated scratch document and `data/shows.json` remain ignored. The temporary gauntlet directory was removed after reading the log.

## Remaining work

- Enumerate the live THR archive for 2023-2026 with working scraper access, compare all relevant Broadway openings and verify the candidate records above. Backfill any verified discoveries through `fetchPage()` and `gather-reviews`, then validate recovery. Annual site totals remain unknown until that comparison is complete.
- Repair Purpose's canonical source in the private review-texts repo, rebuild the private core-data corpus and verify its inclusion. Investigate the original typo-correction writer before changing general migration logic.
- After the full comparison, either document a supported coverage reduction in the outlet registry or fix the demonstrated discovery defect. Neither outcome is established for the broader drop yet.
- Post these findings to BRO-4927 through the authorized runner/owner process. This unattended task was instructed not to touch Linear.
