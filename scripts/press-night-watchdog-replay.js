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
 * Usage: node scripts/press-night-watchdog-replay.js --show=ID --night=YYYY-MM-DD [--runs=FILE|--no-runs] [--json]
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
  return 0;
}

module.exports = { replayNight, runsAt };
if (require.main === module) process.exitCode = main();
