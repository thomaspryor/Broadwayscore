# BRO-6165: Bucknell recoupment backtest rerun

Checked October 25, 2026 against the runner's supplied private-data snapshot. Commercial metadata was last updated `2026-10-25T10:47:57.321Z`; all ten target records have `modelLastRun: 2026-10-25`.

The card's missing-script blocker is resolved on main. `test -f scripts/backtest-recoupment-bucknell.js` passes. The same script and helper exist on `origin/main` (`a764dce1662e2d40083fcdefffd7dea1ff76d352`) and have no implementation diff from this checkout. No code or data fix is needed. Changes are this report and a narrow `.gitignore` exception so the runner retains it.

## Capitalization coverage

The applied plan `data/pending-fixes/bro-6137-r3.json` contains 20 successful field edits for ten shows. Every current capitalization and capitalizationSource matches the plan's newValue. Reversing only those 20 fields to their recorded oldValue **in memory**, while keeping all other snapshot data fixed, gives:

| Measure | Reconstructed before fills | Current snapshot |
| --- | ---: | ---: |
| Study musicals | 133 | 133 |
| Matched commercial records | 88 | 88 |
| Matched commercial records without capitalization | 33 | 23 |
| Target shows without capitalization | 10 | 0 |

Exactly the ten target slugs leave the no-cap list, with no additions or other removals. These are missing capitalization counts among matched commercial records, separate from the 41 study shows that have pages but no commercial record.

| Slug | Plan's prior capitalization | Current capitalization | Reported / model recouped | Model central % |
| --- | ---: | ---: | --- | ---: |
| amazing-grace-2015 | null | 16,000,000 | false / false | -45.2 |
| bright-star-2016 | null | 10,500,000 | false / false | -43.3 |
| disaster-2016 | null | 6,500,000 | false / false | -51.8 |
| tuck-everlasting-2016 | null | 11,000,000 | false / false | -39.0 |
| cirque-du-soleil-paramour-2016 | null | 25,000,000 | false / false | -31.7 |
| fiddler-on-the-roof-2015 | null | 11,500,000 | false / false | -0.9 |
| school-of-rock-the-musical-2015 | null | 15,000,000 | true / true | 184.9 |
| shuffle-along-or-the-making-of-the-musical-sensation-of-1921-and-all-that-followed-2016 | null | 12,000,000 | false / false | 18.7 |
| spring-awakening-2015 | null | 4,500,000 | false / false | 15.6 |
| the-color-purple-2015 | null | 8,000,000 | false / false | 96.9 |

None of the ten targets has a current reported-field or model conflict with the study. Figures above are the public press figures already recorded in the applied plan. No sources were fetched or reverified during this rerun.

The remaining 23 matched records without capitalization are:

```text
13-2008
a-little-night-music-2009
annie-2012
baby-its-you-2011
cats-2016
dames-at-sea-2015
falsettos-2016
follies-2011
gigi-2015
glory-days-2008
groundhog-day-2017
hands-on-a-hardbody-2013
honeymoon-in-vegas-2015
in-transit-2016
lysistrata-jones-2011
on-your-feet-2015
prince-of-broadway-2017
scandalous-2012
shrek-the-musical-2008
soul-doctor-2013
sunday-in-the-park-with-george-2017
sunset-boulevard-2017
the-scottsboro-boys-2010
```

## Current backtest results

`node scripts/backtest-recoupment-bucknell.js` exits 0 and reports 133 study musicals, 88 commercial records, four never-opened productions, zero missing show pages, 41 pages without commercial records, and six looser title/date matches.

| Comparison | Agreement | No answer | Always-no baseline |
| --- | --- | ---: | --- |
| Reported, firm labels | 76/76 (100.0%) | 0 | n/a |
| Reported, soft labels | 8/10 (80.0%) | 2 | n/a |
| Model, firm labels | 70/74 (94.6%) | 0 | 64.9% |
| Model, soft labels | 8/11 (72.7%) | 0 | 72.7% |

Three ai-estimated passthrough records are excluded from model scoring. There are no firm-label cases with an empty reported field. Reported agreement is a consistency check because the study and our reported field often use the same press sources.

Reported-field conflicts, both soft study judgments:

| Slug | Study classification | Reported | Model | Model central % |
| --- | --- | --- | --- | ---: |
| cats-2016 | Plausible | false | false | 68.3 |
| sunset-boulevard-2017 | Plausible | false | false | 30.1 |

Additional model-only conflicts:

| Slug | Study classification | Reported | Model | Model central % |
| --- | --- | --- | --- | ---: |
| evita-2012 | No - Press | false | true | 161.1 |
| falsettos-2016 | Plausible | null | false | -14.2 |
| memphis-2009 | Yes - Press | true | false | 35.8 |
| next-to-normal-2009 | Yes - Press | true | false | 88.5 |
| sunday-in-the-park-with-george-2017 | Yes - Press | true | false | 30.6 |

## Interpretation and limits

The no-cap comparison reconstructs the isolated coverage effect of the applied plan. It is not the original BRO-6143 snapshot. The original comment's pre-fill conflict counts are not available in the supplied files, and Linear operations are prohibited for this worker. No claim about a historical change in conflicts is made.

The backtest reads stored `recouped` and `modelRecouped`; it does not calculate a new model from capitalization. Reversing capitalization fields while holding those stored answers fixed changes zero backtest output records, as expected. That zero is not evidence that rerunning the model before and after the fills would give identical results.

Writer/caller tracing: `scripts/backtest-recoupment-bucknell.js:23` imports `runBacktest()` from `scripts/lib/bucknell-backtest.js`. Its commercial values come from `commercial.json`. `scripts/merge-model-recoupment.js:159` writes `modelRecouped`; `.github/workflows/execute-approved-fix.yml:123` already refreshes the model after a commercial fix. No downstream patch is warranted.

## Verification

Commands run and results:

- `test -f scripts/backtest-recoupment-bucknell.js`: PASS before and after this report.
- `git cat-file -e origin/main:scripts/backtest-recoupment-bucknell.js`: PASS.
- `git diff --exit-code origin/main -- scripts/backtest-recoupment-bucknell.js scripts/lib/bucknell-backtest.js`: PASS, no implementation differences.
- `git log -S 'backtest-recoupment-bucknell' --oneline -5`: printed `b3d3ce96` and `8218043d`. This checkout is shallow, so these results do not identify the original introduction commit. Main's file presence was checked directly above.
- `git show --stat e778ffc0568`: unavailable locally, `unknown revision or path not in the working tree`. The applied plan and its 20 successful results supply the fill evidence instead.
- `node scripts/backtest-recoupment-bucknell.js`: PASS, results above.
- `node --test --test-timeout 300000 scripts/lib/bucknell-backtest.test.mjs`: PASS, 14 tests, zero failures.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`: PASS, exit 0, `lint-workflows: all gates green`. Read the complete log. Existing advisory findings were reported; actionlint is absent and was skipped as allowed. Removed the temporary output directory afterwards.
- `rg -l 'bucknell-backtest' tests scripts --glob '*.test.*'`: only `scripts/lib/bucknell-backtest.test.mjs`.
- The read-only reproduction below: PASS, ten exact removals, zero additions, zero commercial file writes, zero target conflicts.

No tests or executable code were edited. TypeScript, scoring-delta and regex checks do not apply to this report and ignore-exception change. Final `git status --short` contains only `.gitignore` and this report; no unrelated tracked files needed restoration.

Reproduce the coverage comparison from the repository root:

```sh
node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runBacktest } = require('./scripts/lib/bucknell-backtest');
const study = require('./data/analysis/bucknell-recoupment-2008-2017.json');
const shows = require('./data/shows.json').shows;
const commercialText = fs.readFileSync('data/commercial.json', 'utf8');
const after = JSON.parse(commercialText).shows;
const plan = require('./data/pending-fixes/bro-6137-r3.json');
assert.equal(plan.status, 'applied');
const before = structuredClone(after);
for (const a of plan.plan.actions) {
  assert.equal(a.file, 'commercial.json');
  assert.deepEqual(after[a.showSlug][a.field], a.newValue, `${a.showSlug}.${a.field}`);
  before[a.showSlug][a.field] = a.oldValue;
}
const targets = plan.plan.actions.filter(a => a.field === 'capitalization').map(a => a.showSlug);
const beforeResult = runBacktest(study.shows, shows, before);
const afterResult = runBacktest(study.shows, shows, after);
const noCap = (result, records) => result.rows.filter(r => r.commercialKey && !records[r.commercialKey].capitalization).map(r => r.commercialKey);
const beforeNoCap = noCap(beforeResult, before);
const afterNoCap = noCap(afterResult, after);
const removed = beforeNoCap.filter(k => !afterNoCap.includes(k));
const added = afterNoCap.filter(k => !beforeNoCap.includes(k));
assert.deepEqual(removed.toSorted(), targets.toSorted());
assert.deepEqual(added, []);
assert.deepEqual(beforeResult, afterResult); // Stored model fields held fixed, not a historical model comparison.
assert.equal(fs.readFileSync('data/commercial.json', 'utf8'), commercialText);
console.log(`PASS: ${targets.length} fills verified; matched no-cap ${beforeNoCap.length} -> ${afterNoCap.length}; removed ${removed.length}; added ${added.length}; data writes 0`);
console.log(`PASS: stored-result backtest differences 0 (no model recomputation)`);
console.log(`Current conflicts: reported ${afterResult.rows.filter(r => r.reportedConflict).length}; model-only ${afterResult.rows.filter(r => r.modelConflict && !r.reportedConflict).length}`);
for (const k of targets) {
  const row = afterResult.rows.find(r => r.commercialKey === k);
  assert.ok(row, k);
  assert.equal(row.reportedConflict, false, k);
  assert.equal(row.modelConflict, false, k);
  console.log(`${k}: capitalization ${before[k].capitalization} -> ${after[k].capitalization}; reported=${row.ourReported}; model=${row.ourModel}; conflicts=0`);
}
NODE
```

Checklist: (a) ten coverage changes, no other removals or additions; example fills are Amazing Grace null to $16M, Bright Star null to $10.5M and School of Rock null to $15M. (b) Real writer and caller traced above. (c) Already present on main; no code change. (d) No new script, flag or function; existing production helper exercised directly. (e) Zero paid fetches, LLM calls or external API calls. No cron was added or changed.

REMAINING: Compare these current conflict lists with the original BRO-6143 comment, then post the result to BRO-6137. Linear operations are outside this worker's authorization.
