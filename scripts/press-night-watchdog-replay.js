#!/usr/bin/env node
'use strict';
/**
 * press-night-watchdog-replay.js (BRO-6858): replays a recorded press night through the watchdog's decision rules
 * (scripts/lib/press-night-watchdog.js evaluateTick) at its real 10-minute tick, from the embargo to +3h, and prints
 * what it would have dispatched or paged, and when.
 *
 * Inputs, all recorded, nothing fetched:
 *   - data/audit/press-night/<show>-<night>.json: fileState.files (when each review file was first seen) and
 *     perReview[].firstLiveAt (when each review went live on the site).
 *   - --runs=FILE: the night's GitHub runs of the five watched workflows ({workflow,status,conclusion,displayTitle,
 *     startedAt,updatedAt}); a run counts as active between startedAt and updatedAt. Without it, the replay assumes
 *     no pipeline ran (the worst case). Fixtures: tests/fixtures/press-night-watchdog-replay/.
 *   - reviews.json at the time is not recorded, so a review is never in the "deploy" stage here, and scoring time is
 *     not recorded, so a pending review sits in the "score" stage.
 *
 * --project: also project the night's first-live and coverage-2h under the 5-min first-2h sleep
 * (press-night-poll-plan.js, Broadway only). Conservative model, every assumption leans toward "no gain":
 *   - chain: a poller run that started 12-22 min after another ended (the orchestrator's 15-min sleep) follows it;
 *     each run has at most one follower. If that sleep began inside [embargo, +2h] the follower starts 10 min earlier,
 *     and later runs of the chain inherit the shift.
 *   - a review is credited the smallest shift of the runs that could have found it, and none at all unless the
 *     lane shadow saw it published by the shifted find time (no proof it existed earlier, no gain).
 *   - it cannot go live before the first successful vercel-deploy run that ends after the shifted find (a deploy
 *     outage holds it), nor later than it really did.
 *   - first-live is the earliest of the night's own reviews (isNightReview: a preview-period review does not count).
 *   - coverage-2h moves only for a census outlet the record has missing at +2h whose shifted review crosses +2h.
 *   - not modelled: the poller's SERP sweep spacing (60 min) may skip a shifted run's SERP; the watchdog adds
 *     nothing while a poller is moving (it retries only a stalled stage).
 *
 * Usage: node scripts/press-night-watchdog-replay.js --show=ID --night=YYYY-MM-DD [--runs=FILE|--no-runs] [--project] [--json]
 * Exit 0 replayed, 2 bad args or missing record.
 */
const fs = require('fs');
const path = require('path');
const wd = require('./lib/press-night-watchdog');

const ROOT = path.join(__dirname, '..');
const MIN = 60000;
const TICK_MIN = 10;
const UNTIL_MIN = 180;

/** The runs as they looked at nowMs: started ones only, active until they finished. */
function runsAt(runs, nowMs) {
  const out = [];
  for (const r of runs || []) {
    const start = Date.parse(r.startedAt || r.createdAt);
    const end = Date.parse(r.updatedAt);
    if (!Number.isFinite(start) || start > nowMs) continue;
    const done = r.status === 'completed' && Number.isFinite(end) && end <= nowMs;
    out.push({ ...r, status: done ? 'completed' : 'in_progress', conclusion: done ? r.conclusion : null });
  }
  return out;
}

/** Replays one night; returns [{atMin, actions, summary}] for every tick with an action, plus totals. */
function replayNight({ record, runs, normOutlet, tickMin = TICK_MIN, untilMin = UNTIL_MIN }) {
  const embargoMs = Date.parse(record.embargoAt);
  const files = ((record.fileState && record.fileState.files) || []).map((f) => ({ ...f, scoredAt: null }));
  const lives = (record.perReview || []).filter((p) => p.firstLiveAt).map((p) => ({ ms: Date.parse(p.firstLiveAt), o: p.outlet, cn: p.critic }));
  let state = {};
  const ticks = [];
  for (let m = 0; m <= untilMin; m += tickMin) {
    const nowMs = embargoMs + m * MIN;
    const liveRows = lives.filter((l) => l.ms <= nowMs).map((l) => ({ o: l.o, cn: l.cn }));
    const r = wd.evaluateTick({ showId: record.showId, embargoMs, nowMs, files, coreRows: [], liveRows,
      runs: runs ? runsAt(runs, nowMs) : [], normOutlet, state });
    state = r.state;
    ticks.push({ atMin: m, at: new Date(nowMs).toISOString(), actions: r.actions, summary: r.summary });
  }
  const acted = ticks.filter((t) => t.actions.length);
  return { showId: record.showId, night: record.night, embargoAt: record.embargoAt, firstLiveAt: record.firstLiveAt || null,
    ticks: ticks.length, acted, dispatches: acted.flatMap((t) => t.actions.filter((a) => a.type.startsWith('dispatch')).map((a) => ({ atMin: t.atMin, ...a }))),
    pages: acted.flatMap((t) => t.actions.filter((a) => a.type === 'page').map((a) => ({ atMin: t.atMin, ...a }))) };
}

const POLLER = 'opening-night-poller.yml';
const SLEEP_SAVED_MIN = 15 - 5; // press-night-poll-plan: default 15 -> FAST_MIN 5 inside the first 2h
const FAST_WINDOW_MIN = 120;

/** Poller runs sorted by start, each with `shift`: minutes earlier it starts under the fast first-2h sleep. */
function chainShifts(runs, embargoMs) {
  const pollers = (runs || []).filter((r) => r.workflow === POLLER)
    .map((r) => ({ start: Date.parse(r.startedAt || r.createdAt), end: Date.parse(r.updatedAt), run: r }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end)).sort((a, b) => a.start - b.start);
  const followed = new Set();
  for (const r of pollers) {
    // The orchestrator sleeps 15 min after its poller finishes, then dispatches: the predecessor ended 12-22 min ago.
    const pred = pollers.filter((p) => p !== r && !followed.has(p) && p.end <= r.start - 12 * MIN && p.end >= r.start - 22 * MIN)
      .sort((a, b) => b.end - a.end)[0];
    r.shift = 0;
    if (pred) {
      followed.add(pred);
      const sleepFrom = pred.end - pred.shift * MIN;
      const fast = sleepFrom >= embargoMs && sleepFrom - embargoMs <= FAST_WINDOW_MIN * MIN;
      r.shift = pred.shift + (fast ? SLEEP_SAVED_MIN : 0);
    }
  }
  return pollers;
}

/** Projected first-live and coverage-2h of a recorded night under the fast first-2h sleep (model in the header). */
function projectNight({ record, runs, normOutlet }) {
  if (record.market !== 'broadway') return { skipped: `market ${record.market}: the fast sleep is Broadway only` };
  const { isNightReview } = require('./lib/press-night-record');
  const embargoMs = Date.parse(record.embargoAt);
  const pollers = chainShifts(runs, embargoMs);
  const deployEnds = (runs || []).filter((r) => r.workflow === 'vercel-deploy.yml' && r.conclusion === 'success')
    .map((r) => Date.parse(r.updatedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const discovered = (record.laneShadow && record.laneShadow.discoveredByOutlet) || {};
  const nightStart = embargoMs - wd.NIGHT_START_H * 60 * MIN;
  const seenBy = new Map();
  for (const f of (record.fileState && record.fileState.files) || []) {
    const ms = Date.parse(f.firstSeenAt);
    if (!f.includable || !f.outletId || !Number.isFinite(ms) || ms < nightStart) continue;
    if (!seenBy.has(f.outletId) || ms < seenBy.get(f.outletId)) seenBy.set(f.outletId, ms);
  }
  const shiftAt = (ms) => {
    const cands = pollers.filter((p) => p.start <= ms && ms <= p.end + 5 * MIN);
    return cands.length ? Math.min(...cands.map((p) => p.shift)) : 0;
  };
  const rows = [];
  for (const p of record.perReview || []) {
    const liveMs = Date.parse(p.firstLiveAt);
    if (!Number.isFinite(liveMs) || !isNightReview(p, record.night)) continue;
    const oid = normOutlet(p.outlet);
    const seen = seenBy.get(oid);
    let shift = Number.isFinite(seen) && liveMs > seen ? shiftAt(seen) : 0;
    const disc = Date.parse(discovered[oid]);
    if (shift && !(Number.isFinite(disc) && disc <= seen - shift * MIN)) shift = 0;
    let projectedMs = liveMs;
    if (shift) {
      const foundMs = seen - shift * MIN;
      const deploy = deployEnds.length ? deployEnds.find((d) => d >= foundMs) : foundMs;
      projectedMs = Math.min(liveMs, Math.max(liveMs - shift * MIN, deploy == null ? liveMs : deploy));
    }
    rows.push({ outletId: oid, liveMs, projectedMs, shift });
  }
  const mins = (ms) => (Number.isFinite(ms) ? Math.round((ms - embargoMs) / MIN) : null);
  const minOf = (k) => (rows.length ? Math.min(...rows.map((r) => r[k])) : NaN);
  const ref = (record.reference && record.reference['2h']) || null;
  let coverage = null;
  if (ref && ref.count) {
    const at2h = embargoMs + FAST_WINDOW_MIN * MIN;
    const nowLive = (ref.missing || []).filter((o) => rows.some((r) => r.outletId === o && r.shift && r.liveMs > at2h && r.projectedMs <= at2h));
    const covered = ref.covered + nowLive.length;
    coverage = { count: ref.count, recordedCovered: ref.covered, projectedCovered: covered, projected: Math.round((covered / ref.count) * 1000) / 1000, newlyLive: nowLive };
  }
  return {
    shiftedRuns: pollers.filter((r) => r.shift).map((r) => ({ startMin: mins(r.start), shift: r.shift })),
    shiftedReviews: rows.filter((r) => r.liveMs !== r.projectedMs).map((r) => ({ outletId: r.outletId, liveMin: mins(r.liveMs), projectedMin: mins(r.projectedMs) })),
    firstLive: { recordedMin: mins(minOf('liveMs')), projectedMin: mins(minOf('projectedMs')) },
    coverage2h: coverage,
  };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const showId = arg('show');
  const night = arg('night');
  if (!showId || !/^\d{4}-\d{2}-\d{2}$/.test(night || '')) { console.error('need --show=ID --night=YYYY-MM-DD'); return 2; }
  const recPath = path.join(ROOT, 'data', 'audit', 'press-night', `${showId}-${night}.json`);
  if (!fs.existsSync(recPath)) { console.error(`no record at ${path.relative(ROOT, recPath)}`); return 2; }
  const record = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  let runs = null;
  if (!args.includes('--no-runs')) {
    const runsPath = arg('runs') || path.join(ROOT, 'tests', 'fixtures', 'press-night-watchdog-replay', `runs-${showId}-${night}.json`);
    if (fs.existsSync(runsPath)) runs = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
    else if (arg('runs')) { console.error(`no runs file at ${runsPath}`); return 2; }
  }
  const { normalizeOutlet } = require('./lib/review-normalization');
  const normOutlet = (o) => (o ? normalizeOutlet(String(o)) || String(o).toLowerCase() : null);
  const out = replayNight({ record, runs, normOutlet });
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log(`${showId} ${night}: embargo ${out.embargoAt}, first review live ${out.firstLiveAt || 'never'}, runs ${runs ? `recorded (${runs.length})` : 'none (worst case)'}`);
  if (!out.acted.length) console.log('  no action in any tick: every found review was live or moving');
  for (const t of out.acted) {
    for (const a of t.actions) {
      const what = a.type === 'dispatch' ? `retry ${a.stage}` : a.type === 'dispatch-orchestrator' ? 'start orchestrator' : a.type === 'page' ? `PAGE owner: ${a.reason}` : 'resolve page';
      console.log(`  +${String(t.atMin).padStart(3)} min ${t.at.slice(11, 16)}Z  ${what}   [pending ${t.summary.pending.length}, live ${t.summary.live}/${t.summary.found}]`);
    }
  }
  console.log(`  totals: ${out.dispatches.length} dispatch(es), ${out.pages.length} page(s) over ${out.ticks} ticks`);
  if (args.includes('--project')) {
    if (!runs) { console.error('--project needs the recorded runs (drop --no-runs)'); return 2; }
    const p = projectNight({ record, runs, normOutlet });
    if (p.skipped) { console.log(`  projection skipped: ${p.skipped}`); return 0; }
    console.log(`    reviews live earlier: ${p.shiftedReviews.map((r) => `${r.outletId} +${r.liveMin}->+${r.projectedMin}`).join(', ') || 'none'}`);
    console.log(`  projection (5-min sleep in the first 2h): poller runs started earlier: ${p.shiftedRuns.map((r) => `+${r.startMin}m by ${r.shift}`).join(', ') || 'none'}`);
    console.log(`    first-live (night reviews): recorded +${p.firstLive.recordedMin} min, projected +${p.firstLive.projectedMin} min after the embargo (bar 30)`);
    if (p.coverage2h) console.log(`    coverage-2h: recorded ${p.coverage2h.recordedCovered}/${p.coverage2h.count}, projected ${p.coverage2h.projectedCovered}/${p.coverage2h.count} = ${p.coverage2h.projected} (bar 0.8)${p.coverage2h.newlyLive.length ? `; newly live by +2h: ${p.coverage2h.newlyLive.join(', ')}` : ''}`);
  }
  return 0;
}

module.exports = { replayNight, runsAt, projectNight, chainShifts };
if (require.main === module) process.exitCode = main();
