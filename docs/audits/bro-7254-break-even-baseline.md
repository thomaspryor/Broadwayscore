# BRO-7254: baseline investigation, 2026-11-15

Status: baseline reconstructed and committed as the replacement protocol; see the follow-up section at the end. This is
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

## Follow-up, 2026-11-15: replacement protocol, recalibration trials, provenance

**Replacement protocol.** The original BRO-7246 scratch logic, frozen inputs and
twelve-show cohort are not recoverable. The reconstruction above is now the
protocol, committed as `scripts/backtest-closing-watch.mjs`
(`runClosingWatchBacktest`, same rules, production functions imported). It
reproduces 54/78 = 69.23% in window and 3 false alarms (moulin-rouge,
mamma-mia-2001, kinky-boots-2013) on the 2026-11-15 snapshot. "False alarm"
means a closed show that ran 104+ weeks after its first forecast; the 12 in
the card used the lost protocol and is not comparable.

**Misses.** 24 of 78 forecasts fall outside the window: 14 late (ran past p75)
and 10 early. Of the late ones 10 rest on estimated break-evens, 4 on cited
press costs (Cabaret 2024, The Play That Goes Wrong, Once on This Island,
Legally Blonde).

**Recalibrations tried, none kept** (in window / forecasts, false alarms):

| Change | Result |
| --- | --- |
| baseline | 54/78 = 69.2%, 3 |
| estimated break-evens x0.80 / 0.85 / 0.90 / 0.95 | 58.8% / 58.9% / 66.2% / 64.5%, 1-3 |
| estimated break-evens x1.05 / 1.10 | 67.1% / 65.0%, 3 |
| all break-evens x0.90 / 0.95 / 1.05 | 69.1% / 69.3% (52/75, fewer forecasts) / 65.8% |
| raw weekly cost instead of model break-even (estimated / all) | 58.7% / 56.2% |
| estimateWeeklyNut x 1.269 (median reported break-even / nut, n=35) for estimated | 63.0% |
| same, only for type-default records (20) | 68.8%-70.0% depending on the 4th decimal of the ratio; x1.35-1.45 adds false alarms (4-5) |
| fill missing break-evens with that comparable (345 runs) | 60.5%, 12 |
| min / max of estimate and comparable | 64.5% / 65.1% |

The type-default variant flips between 55 and 56 hits on a ratio change in the
fourth decimal, so it is noise, not an improvement, and was not kept.

**Upper bound.** Lowering each late-miss estimated break-even alone by 10-30%
gives at most 55/78 (70.5%); lowering all ten by 20% at once gives 53/77
(68.8%). Because every break-even also feeds the survival calibration, no
break-even change reaches 72% under this protocol. The remaining misses come
from the window model (how wide p25-p75 is and when the first forecast fires),
not the break-even inputs.

**Provenance.** `scripts/lib/break-even-provenance.js` derives
`breakEvenSource` (which field the figure is and what it rests on, no copied
citations or amounts) and `breakEvenQuality` (`reported` only on a cited
press, SEC or producer cost; otherwise `estimated`; `unavailable` when no
break-even shows). The commercial write guard stamps both on every save, the
merge re-derives them, record checks refuse only an invalid quality (a stale one is
re-derived on the next save), and the next guarded save stamps every record,
the four named shows included (all `estimated`: their costs are analyst or industry estimates; Wanted's
"trade-reported" label sits on a forum citation). On the snapshot, the 39
running Broadway records come out 8 reported, 14 estimated, 17 unavailable.

Test: `node --test scripts/closing-watch-breakeven.test.mjs`. The 72% target
is a visible TODO test, not a pass.

REMAINING: 72% in window is not reached (69.23%). Raising it needs a change to the window model in src/lib/closing-watch.ts (p25-p75 choice, first-forecast timing), tested with the committed backtest, which is outside break-even calibration.
REMAINING: Press-reported weekly costs for the ten estimated late misses would improve their provenance, but the upper bound above shows they cannot move the metric to target.
