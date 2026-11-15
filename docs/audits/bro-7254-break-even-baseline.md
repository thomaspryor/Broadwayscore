# BRO-7254: baseline investigation, 2026-11-15

Status: incomplete. No estimate, model, or private data was changed. This is
reproducible audit evidence, not a claim that the acceptance criteria passed.

## Findings

The named acceptance command fails before running tests:

```text
$ node --test scripts/closing-watch-breakeven.test.mjs
Could not find 'scripts/closing-watch-breakeven.test.mjs'
```

`git ls-tree origin/main scripts/closing-watch-breakeven.test.mjs` also returns
no entry. Searches of scripts, src, and cloud-memory find the production
functions and unit tests, but not BRO-7246's backtest or its 12-show cohort.
The card's latest supplied comment also says its referenced Outcome lacks the
scratch logic. Historical `git log -S 'breakEvenSource' --oneline -5` could not
complete: fetching missing objects tried to write into the read-only shared
Git object directory (`fatal: Unable to create temporary file ...:
Read-only file system`). This does not establish that no earlier fix exists.

All **39** Broadway shows with status `open` or `previews` have commercial
entries but lack both `breakEvenSource` and `breakEvenQuality` in this snapshot.
This includes 32 open shows and seven in previews. The four named records
already have weekly cost source text citing analyst estimates on Reddit:

| Commercial slug | Weekly running cost | Stored cost methodology | Evidence assessment |
| --- | ---: | --- | --- |
| the-lost-boys | $950,000 | industry-estimate | Estimate, not a verified press cost |
| schmigadoon | $750,000 | reddit-standard | Estimate, not a verified press cost |
| the-rocky-horror-show | $750,000 | reddit-standard | Estimate, not a verified press cost |
| wanted | $700,000 | trade-reported | Method conflicts with its estimate citation; modelInputBasis already says estimate |

These are observations of existing records, not newly verified financial
claims. A named cost source alone does not establish an accurate break-even.

## Reconstructed leave-one-show-out baseline

The read-only command below imports the actual production functions. It
restricts gross weeks to 2026-11-09, uses the same final-continuous-run and
shutdown rules as `getClosingWatchCalibration`, removes the held-out show's
observations from training, and takes its first eligible forecast. A closing
is in-window when the remaining weeks fall between p25 and p75, with a null
p75 treated as an unbounded upper limit. It separately counts first watch
flags even when a forecast is unavailable.

Results on the supplied current snapshot:

- 123 eligible calibration runs, including 103 closed runs.
- 79 closed runs first flagged; 78 received a forecast.
- 54 / 78 forecasts in-window: **69.23%**, below 72%.
- Three shows ran at least 104 more weeks after their first watch flag.
  The same three meet that definition after their first forecast.

| Show | First forecast | Weeks until last gross | Break-even used | Existing source tier |
| --- | --- | ---: | ---: | --- |
| moulin-rouge | 2022-01-02 | 243 | $1,179,775 | industry-estimate |
| mamma-mia-2001 | 2012-02-12 | 187 | $589,654 | industry-estimate |
| kinky-boots-2013 | 2013-03-24 | 315 | $714,971 | industry-estimate |

Mamma Mia's first watch flag was earlier, 2011-02-06, 240 weeks before its
last gross. Moulin Rouge and Mamma Mia have research-derived cost estimates.
Kinky Boots has no weekly cost or cost citation; its displayed break-even
comes from the model. The `industry-estimate` tiers above come from the real
`legacySourceType` function, not from the model's overall data quality.

**This is not the original 80-show/12-false-alarm baseline.** Current commercial
values and statuses are used, not a frozen 2026-11-09 commercial snapshot.
Historical closing announcement dates are unavailable, so closingDate is
cleared during replay. The seasonal index uses the full market; only the
survival calibration excludes the held-out show. These choices must be
reconciled with the original protocol before attributing any metric change
to recalibration. The original twelve cannot be identified from these three.
No numerical changes were retained without a demonstrated improvement.

## Writers and existing behavior

- `scripts/merge-model-recoupment.js:161` writes `modelBreakeven` from
  `result.weeklyBreakeven`, then records `modelCostBasis` and `modelDataQuality`.
- `scripts/lib/recoupment-model.js:1235` implements `estimateWeeklyNut`.
  Existing defaults already adjust for show category, era and venue size.
  This is the place to evaluate a new cost estimator, rather than changing
  the downstream Closing Watch reader.
- `scripts/lib/commercial-write-guard.js:84` calls `syncBreakevenToCost` on
  saves; `scripts/lib/commercial-breakeven.js` rescales a stale break-even
  after a cost change.
- `src/lib/commercial-display.ts:398` implements `getBreakEven`, including
  its quality floor and fallback to weekly running cost.
- `src/lib/data-commercial.ts:806` builds Closing Watch calibration;
  `src/lib/closing-watch.ts` supplies the shared forecasting functions.

No new production function, script, flag, network request, paid fetch, LLM
call, or cron job is introduced by this audit.

## Reproduce the snapshot audit

Run from the repository root with the supplied private data and installed
`tsx`. This command only reads data and imports the real implementation.
It does not write commercial.json or the review-texts clone.

```sh
node <<'NODE'
require('tsx/cjs');
const cw=require('./src/lib/closing-watch.ts');
const {getBreakEven}=require('./src/lib/commercial-display.ts');
const {legacySourceType}=require('./scripts/lib/cost-history.js');
const shows=require('./data/shows.json').shows, commercial=require('./data/commercial.json').shows;
const history=require('./data/grosses-history.json').weeks;
const weeks=Object.keys(history).filter(w=>w<='2026-11-09').sort();
const seasonal=cw.seasonalIndexSeries(weeks.map(w=>{const rows=Object.values(history[w]).filter(r=>r?.gross>0); return rows.length?rows.reduce((n,r)=>n+r.gross,0)/rows.length:null;}));
const runs=[];
for(const [slug,comm] of Object.entries(commercial)) {
 const show=shows.find(s=>s.slug===slug);
 if(!show||!['closed','open','previews'].includes(show.status)||!cw.isBoxOfficeDriven(comm.designation,show.limitedRun))continue;
 const be=getBreakEven(comm); if(!(be>0))continue;
 let weekly=weeks.map(w=>history[w]?.[slug]?.gross??null);
 const last=weekly.findLastIndex(g=>g>0); if(last<0||show.status==='closed'&&/^2020-03-/.test(weeks[last]))continue;
 if(show.status==='closed')weekly=weekly.slice(0,last+1);
 const ratios=cw.adjustedRatioSeries(weekly,seasonal,be), banked=cw.bankedShareSeries(weekly,be,comm.capitalization);
 const start=cw.finalRunStart(weekly);
 runs.push({slug,show,comm,be,weekly,ratios,banked,closed:show.status==='closed',start});
}
const out=[], firstFlags=[];
for(const run of runs.filter(r=>r.closed)) {
 const calibration=cw.calibrateClosingWatch(runs.filter(r=>r!==run));
 for(let i=0;i<run.ratios.length;i++) {
  const seen=run.weekly.slice(run.start,run.start+i+1).filter(g=>g>0).slice(-4);
  const avg=seen.reduce((a,b)=>a+b,0)/seen.length;
  if(!cw.isOnClosingWatch({status:'open',designation:run.comm.designation,limitedRun:run.show.limitedRun,closingDate:null,today:weeks[run.start+i],avgGross:avg,breakEven:run.be,adjustedRatio:run.ratios[i]}))continue;
  if(!firstFlags.some(r=>r.slug===run.slug))firstFlags.push({slug:run.slug,first:weeks[run.start+i],weeksRemaining:run.ratios.length-1-i,tier:legacySourceType(run.comm)});
  const est=cw.estimateClosing(run.ratios.slice(0,i+1),calibration,run.banked.slice(0,i+1)); if(!est)continue;
  const remaining=run.ratios.length-1-i;
  out.push({slug:run.slug,first:weeks[run.start+i],weeksRemaining:remaining,inWindow:remaining>=(est.p25??0)&&(est.p75===null||remaining<=est.p75),p25:est.p25,p75:est.p75,be:run.be,method:run.comm.costMethodology||null,tier:legacySourceType(run.comm)});break;
 }
}
console.log(JSON.stringify({runs:runs.length,flagged:out.length,inWindow:out.filter(r=>r.inWindow).length,share:out.filter(r=>r.inWindow).length/out.length,falseAlarms:out.filter(r=>r.weeksRemaining>=104)},null,2));
console.log('First watch flags',JSON.stringify({count:firstFlags.length,falseAlarms:firstFlags.filter(r=>r.weeksRemaining>=104)},null,2));
NODE
```

## Validation and remaining work

- `node --import tsx --test --test-timeout 300000 tests/unit/closing-watch.test.ts`:
  18 passed, zero failed.
- `node --test --test-timeout 300000 tests/unit/commercial-breakeven.test.mjs`:
  four passed, zero failed.
- `node --test --test-timeout 300000 tests/unit/audit-log-gitignore.test.mjs`:
  11 passed, zero failed. The only .gitignore change permits this report.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  lint-workflows=1 solely because `actionlint: command not found` (exit 127),
  the exception permitted by the worker instructions. Read the completed log;
  all other checks passed or reported advisory findings. Removed the temporary
  log directory after review.
- `git diff --check`: passed. Final status contains only .gitignore and this report.
- The reconstruction was rerun after adding this report with identical results.
  Zero commercial records or numerical estimates changed. The three examples
  above retain the same break-evens before and after.
- The card's acceptance command remains missing, hence fails. No replacement
  test was added that would give a false impression of meeting its data and
  backtest criteria.

REMAINING: Recover the original backtest protocol, frozen inputs and twelve-show cohort, or explicitly reconcile a replacement baseline.
REMAINING: Audit all twelve historical false alarms and calibrate comparable/press-backed estimates, including cast size; retain changes only after the specified backtest improves.
REMAINING: Populate breakEvenSource and a quality assessment for every running Broadway commercial record, including the four named shows, through the writer and approved data-fix path.
REMAINING: Provide the missing acceptance test and demonstrate at least 72% in-window detection with fewer than twelve long-survival false alarms.
