# BRO-5801: existing hosted-blog outlet tiers

The 2026-10-20 owner rule assigns small hosted blogs T4 (base weight 0.20),
while publications with real editorial staff stay T3. BRO-5795 already uses
`newOutletTier()` in `scripts/lib/regular-poster.js` for new registrations.
The writer is `scripts/rebuild-all-reviews.js:7237`, which writes the registry
at line 7363. This migration corrects existing registry records rather than
changing a downstream score reader.

The original evidence identifies 45 T3 hosted-platform IDs. After individual
review, 40 move to T4 and five stay T3. The T4 cohort is pinned in
`tests/unit/blog-platform-tiers-adopted-2026-10.json`; named `KEPT_T3`
exceptions in `scripts/lib/tier-migration-verify.test.mjs` explain the rest.
The scan still rejects any additional T3 hosted-platform outlet.

Medium is kept at T3 per the adopted audit
(`outlet-tier-audit-2026-10.md:185` and the `medium` justification in
`outlet-tier-audit-2026-10.justifications.json`) and the card's Suggested
approach, pending any owner decision to reverse that exception. The audit
identified Christian Lewis as the principal contributor and an Outer Critics
Circle member. This run restores both Medium's registry tier and config
override to T3; the earlier attempt incorrectly treated the acceptance list
as permission to reverse the adopted exception.

## Editorial staff exceptions

The review's proposed count of 44 assumed only Medium would be exempt.
Primary evidence found four more publications with editorial staff, so using
44 would still violate the card's staff exception. Their existing T3 tiers
are restored, with no changes to domains, names, bylines or regional metadata.

- **Yonkers Tribune: keep T3.** The publication identifies Hezi Aris as its
  publisher/editor, separate from registered theatre critic John Simon.
  Its [August 2014 archive](https://www.yonkerstribune.com/2014/08) names
  Editor Hezi Aris, John Simon's theatre column and other contributors;
  its [publisher's article](https://www.yonkerstribune.com/2014/09/the-hezitorial-blue-truth-too-little-too-late-to-clean-house-at-the-yonkers-police-department-by-hezi-aris)
  also identifies Aris as publisher/editor. Hosting on Typepad does not make
  Simon the sole writer/editor of the publication. The legacy Typepad host
  could not be opened; the publication's own archive supplies the evidence.
- **TotalTheater (`totaltheater1`): keep T3.** Its
  [About Us](https://totaltheater1.wordpress.com/about-us/) names editor in
  chief David Lefkowitz and editorial staff member Stephen Odessa Fisch,
  and describes commissioned freelance contributions. This is a staffed
  publication hosted on WordPress, not an anonymous personal blog.
- **Number 9 Reviews (`number9reviews`): keep T3.** Its
  [editor's announcement](https://number9reviews.blogspot.com/2018/08/news-today-we-are-6-months-old.html)
  identifies Matthew Dougall as editor and thanks multiple reviewers.
  The stored review is by Mary Fogg, a different contributor. Evidence of
  a separate editor and reviewers supports keeping the existing T3 tier.
- **The Arts Dispatch (`theartsdispatch`): keep T3.** Its
  [contributor guidelines](https://www.theartsdispatch.com/write-for-us/)
  describe pitching to Jim, while [Vamos Theatre](https://www.vamostheatre.co.uk/shows/show/midwives-on-call-walkabout-theatre)
  identifies Jim Keaveney as its editor. Its
  [Substack](https://theartsdispatch.substack.com/) publishes by Keaveney,
  Alex Benjamin and Saskia Bibb. This supersedes the earlier audit's inability
  to verify an editor; the contributor positions being unpaid does not
  remove the editorial layer.

## Per-outlet review

Evidence is the existing registry's `defaultCritic`, published `reviews.json`
bylines, and prior audit editorial-model notes where present. Single-author
rows do not establish the absence of an editor by themselves. The table
records the evidence and the application of the small-blog rule; uncertain
staffing is explicitly marked rather than asserted as verified. The older
audit's recognized-critic keeps for individual personal blogs are superseded
by the newer small-blog rule, except the explicit Medium exception above.

| Outlet ID | Editorial review and decision |
| --- | --- |
| medium | Adopted data-artifact exception; keep T3 pending owner decision. |
| theatres-leiter-side | Prior audit: Samuel L. Leiter alone, no editor; T4. |
| reflections-in-the-light | Prior audit: Lauren Yarger writes and edits her own blog; T4. |
| show-showdown | Prior audit: volunteer group blog, no named editor; T4. |
| our-theater-blog | Registry and corpus: Tamara Beck; no separate editor evidenced; T4. |
| winningham-writes | Registry and corpus: Madie Winningham; no separate editor evidenced; T4. |
| yonkers-tribune | Aris edits, Simon contributes; staffed-publication exception; keep T3. |
| more-than-the-play-blog | Registry and corpus: Domenick Danza; no separate editor evidenced; T4. |
| 2ontheaisle | Prior audit: Karen Isaacs personal blog, single author; T4. |
| theatre-reviews-by-john-clum | Registry and corpus: John Clum; no separate editor evidenced; T4. |
| mildlybitter | Registry: defunct; Nicole Serratore's personal blog; T4. |
| upstage-downstage | Prior audit: Howard Miller's single-author blog; T4. |
| simon-seez | Prior audit: Simon Saltzman's single-author blog; T4. |
| says-me-says-mom | Registry: Jeryl Marcus; corpus also uses Jeryl M.; no editorial staff evidenced; T4. |
| theater-time | Registry and corpus: Joseph Cervelli; no separate editor evidenced; T4. |
| entertainmenthour | Corpus: Alexandra Lipari; no separate editor evidenced; T4. |
| nottingham-confidential | No published reviews or staff evidence in local data; staffing unverified; T4 under platform rule. |
| ethankanfer | Registry and corpus: Ethan Kanfer; no separate editor evidenced; T4. |
| royberkinfo | Registry: defunct; Roy Berko personal blog; T4. |
| seth-saith | Registry names Seth Arkin; no published reviews; no separate editor evidenced; T4. |
| cote-notices | Prior audit: David Cote single-author newsletter; T4. |
| acsntn | Corpus: August Cosentino; no separate editor evidenced; T4. |
| behindtheencore | Stored attribution is the publication name; staff unverified, About page unavailable; T4 under platform rule. |
| theartsdispatch | Keaveney edits outside contributors; staffed-publication exception; keep T3. |
| stanservice | Corpus: Molly Wilson; no separate editor evidenced; T4. |
| new-york-notebook | Prior audit: Sandy MacDonald single-author newsletter, no editor; T4. |
| thedaviddesk2 | No published reviews or staff evidence in local data; staffing unverified; T4 under platform rule. |
| timboatswain | Corpus: Tim Boatswain; no separate editor evidenced; T4. |
| cultural-capital | Prior audit: Maryam Philpott personal blog, single author; T4. |
| boycotting-trends | Corpus: Alex Ramon (also a malformed byline); no separate editor evidenced; T4. |
| emmatheatrics | Corpus: Emma Theatrics; no separate editor evidenced; T4. |
| theverdictnyc | Stored attribution is the publication name; staffing unverified; T4 under platform rule. |
| carlwoodward | Corpus: Carl Woodward; no separate editor evidenced; T4. |
| stephenkearley | Corpus: Stephen Kearley; no separate editor evidenced; T4. |
| wernerstheatrereviews | [About](https://wernerstheatrereviews.wordpress.com/about/) identifies Emily Werner's personal blog; T4. |
| totaltheater1 | Lefkowitz and Fisch editorial staff, commissioned contributors; keep T3. |
| juliarank | Corpus: Julia Rank; no separate editor evidenced; T4. |
| thepoplarreview | [About](https://thepoplarreview.substack.com/about) explicitly describes a personal theatre Substack; T4. |
| funfandomblog | Corpus: Audra Miller; no separate editor evidenced; T4. |
| matthewsplace1 | Corpus attribution is Matthew's Place; staff unverified; T4 under platform rule. |
| seenanythinglately | Corpus: Penelope Bao; no separate editor evidenced; T4. |
| theatrereviewskurahashi | Corpus: Yuko Kurahashi; no separate editor evidenced; T4. |
| littlelondonwhispers | [About](https://littlelondonwhispers.substack.com/about) describes the writer's personal London blog; T4. |
| mildconcern | Corpus: Tim Brandon; no separate editor evidenced; T4. |
| number9reviews | Dougall edits other reviewers including Fogg; keep T3. |

## Reproduction and real-data replay

The previous attempt's acceptance test passed 2/2 but had removed the Medium
keep assertion. Calling the real `getTier('medium', { showCategory: 'broadway' })`
returned 4; asserting the adopted tier 3 failed with `4 !== 3`. After restoring
exception tests but before changing tiers, the acceptance suite failed 1/3
on `medium registry: outlet-tier-audit-2026-10.md:185`. Afterwards it passes 3/3,
checking registry tiers, effective tiers and base weights in all four markets.

A structural comparison against this run's starting registry finds exactly
five changed records, each only `tier: 4 -> 3`. Medium, Yonkers Tribune and
TotalTheater now resolve to T3/0.40; Theatre's Leiter Side and Cultural Capital
remain T4/0.20. The config diff changes only Medium's override.

Replaying all real review groups through the existing
`loadScorerWithTiers()` canonical scorer before and after this correction
finds 42 review rows in the five restored IDs, 40 changed show scores and zero
changes to shows without a restored-outlet review. Deltas span -0.47 to +0.51:

| Show ID | Before correction | After correction |
| --- | ---: | ---: |
| a-month-in-the-country-west-end-2026 | 79.04 | 79.05 |
| all-male-as-you-like-it-regional-2026 | 85.35 | 85.60 |
| arcadia-duke-of-yorks-west-end-2026 | 73.40 | 73.43 |

Against the original registry before the earlier attempt (`HEAD^`), exactly
40 registry records change, all and only the pinned T4 cohort. There are 208
cohort review rows and 153 changed show scores, zero unrelated shows, with
deltas -0.55 to +2.55. Examples: `a-dolls-house-part-2-2017` 83.37 to 83.39;
`a-little-life-west-end-2023` 64.17 to 63.96.

## Wiring, main and cost

`git show origin/main:scripts/lib/tier-migration-verify.test.mjs` confirms the
acceptance path is absent on main. Main's config already keeps Medium T3.
`git log -S 'supersedes the earlier Medium exception' --oneline -5 -- tests/unit/outlet-tiers-adopted-2026-10.test.mjs`
identifies the earlier attempt `149bc36807c`; older history is incomplete
because unavailable promisor objects cannot be fetched into the read-only
Git object store. No claim of a live private-data update or landing is made.

The acceptance suite requires the real platform detector and tier lookup.
The existing adopted-tier suite imports the cohort fixture and again asserts
Medium T3. Existing scripts-lib CI collection executes the acceptance test;
no production script, flag, function or cron is added. New paid fetches,
LLM calls and API calls per production run: zero. One-time public web research
supported the staff review; it adds no recurring work.

## Fix-round verification

Commands below ran after the correction. No TypeScript files changed, so no
`tsc` invocation was required.

- `node --test scripts/lib/tier-migration-verify.test.mjs`: 3 passed. Before
  the tier correction the restored-exception test failed, as described above.
- `node --test --test-timeout 300000 tests/unit/outlet-tiers-adopted-2026-10.test.mjs tests/unit/cote-notices-registry.test.mjs tests/unit/regular-poster.test.mjs`:
  11 passed.
- `node --test --test-timeout 300000 $(rg -l 'outlet-tiers|regular-poster|blog-platform-tiers|tier-migration-verify' tests scripts --glob '*.test.mjs' --glob '*.test.js' | rg -v 'outlet-id-mapper|verify-outlet-tiers-published')`:
  281 passed.
- `npx --no-install tsx --test --test-timeout 300000 tests/unit/outlet-id-mapper.test.mjs tests/unit/scoring-parity.test.ts tests/unit/critic-score-canonical-parity.test.ts tests/unit/tier-config-consistency.test.ts tests/unit/mobile-feed-website-parity.test.ts`:
  123 passed.
- An additional related-file list was built with
  `rg -l 'outlet-registry\.json|outlet-tiers\.json|outlet-tiers\.js|regular-poster|blog-platform-tiers|tier-migration-verify' tests scripts --glob '*.test.mjs' --glob '*.test.js'`.
  After excluding files from the preceding batch and running the
  international-trade fixture separately, `node --test --test-timeout 300000`
  on the remaining list passed 850/851. The duplicate-cycle surge test failed
  its subprocess output assertion in the parallel batch. The exact focused
  rerun `node --test --test-timeout 300000 tests/unit/duplicate-of-url-mismatch.test.mjs`
  passed 16/16. It also passed 16/16 with origin/main registry/config inputs.
  Neither that test nor its implementation differs from origin/main. This
  appears to be a batch-only transient; no tier-related failure reproduced.
- `node --test --test-timeout 300000 scripts/lib/international-trade-cross-market.test.mjs`:
  7 passed with an isolated temporary working directory and matching
  `REVIEW_TEXTS_DIR`. The real discovery writer ran; the private corpus was
  never written. The fixture directory was removed afterwards.
- `node --test --test-timeout 300000 scripts/verify-outlet-tiers-published.test.mjs`:
  fails on 6/2,105 existing 4Columns/Billboard published reviews. Repeating
  the actual test with filesystem reads of registry/config redirected to
  `git show origin/main:<path>` fails on the identical six rows. These are
  outside this migration and the same baseline failure reported previously.
- `node scripts/scoring-delta.js`: exit 2, expected data-input drift. Exactly
  five tier restores: Medium (22 reviews), Yonkers Tribune (2), The Arts
  Dispatch (15), TotalTheater (2), Number 9 Reviews (1). It reports that no
  Phase A/B inclusion flip count exists for data-input changes and cannot
  compare the private critic-registry baseline. The canonical replay above
  measures all affected reviews instead.
- `node scripts/test-temporal-override-regression.js`: overall PASS, 31 shows,
  1,689 real reviews plus 2 synthetic, 10 eligible flags downgraded, zero
  survivors at high/medium confidence; same-title/festival suite also passes.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  exit 1 solely because `actionlint: command not found` (exit 127). Every
  available gate passes, including top-level test path coverage and library
  dependency coverage. The full lint-workflows log was inspected. Per worker
  instructions, missing actionlint is ignored, not misreported as installed.
- `git diff --check`: passes. Final status contains only the registry,
  Medium config, cohort fixture, two tests and this audit document.
- `npx --no-install next lint`: exit 0, existing source warnings only.

Reproduce both real-data comparisons without modifying input files:

```sh
node <<'NODE'
const { execFileSync } = require('node:child_process');
const { loadScorerWithTiers } = require('./scripts/lib/outlet-tier-audit');
const { reviews } = require('./data/reviews.json');
const data = require('./data/shows.json');
const shows = new Map((data.shows || data).map(s => [s.id, s]));
const current = require('./data/outlet-registry.json').outlets;
const after = loadScorerWithTiers(require('./src/config/outlet-tiers.json'));
const groups = Map.groupBy(reviews, r => r.showId);
for (const ref of ['149bc36807c', '149bc36807c^']) {
  const read = p => JSON.parse(execFileSync('git', ['show', `${ref}:${p}`], { encoding: 'utf8' }));
  const registry = read('data/outlet-registry.json').outlets;
  const before = loadScorerWithTiers(read('src/config/outlet-tiers.json'));
  const changed = new Set(Object.keys(current).filter(id => current[id].tier !== registry[id]?.tier));
  const moved = [];
  let unrelated = 0;
  for (const [id, rows] of groups) {
    const show = shows.get(id) || {};
    const b = before(rows, registry, show.category, show.type);
    const a = after(rows, current, show.category, show.type);
    if (!a || !b || Math.abs(a.s - b.s) < 1e-9) continue;
    if (!rows.some(r => changed.has(r.outletId))) unrelated++;
    moved.push({ id, before: b.s, after: a.s, delta: a.s - b.s });
  }
  console.log(ref, { records: changed.size,
    reviewRows: reviews.filter(r => changed.has(r.outletId)).length,
    shows: moved.length, unrelated,
    minDelta: Math.min(...moved.map(r => r.delta)),
    maxDelta: Math.max(...moved.map(r => r.delta)), examples: moved.slice(0, 3) });
}
NODE
```

The literal all-45 acceptance count conflicts with the stated editorial
review rule and the adopted Medium exception. Applying that count despite
these findings would require an owner decision. This worker preserves the
five justified T3 exceptions instead of authorizing that reversal.
