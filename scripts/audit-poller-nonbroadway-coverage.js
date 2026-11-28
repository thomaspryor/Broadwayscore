#!/usr/bin/env node
'use strict';
/**
 * audit-poller-nonbroadway-coverage.js (BRO-8294)
 *
 * Proves, from real data, the two claims behind "non-Broadway shows ride the auto run":
 *   1. REPLAY: for every 15-minute orchestrator tick in the last N days, the new plan (Broadway-only targeting) keeps
 *      every Broadway targeted dispatch the old plan made (new is a superset, at every rotation 0..5), and drops
 *      only non-Broadway ones. Prints old vs new targeted-dispatch counts per market.
 *   2. LATENCY: for every non-Broadway show whose press-night window fell in the period, the worst-case wait for the
 *      first auto-run poll after the embargo lifts and the worst gap between consecutive auto-run starts inside the
 *      window, plus the in-run position offset (front shows ahead x per-show cap). Must stay under --limit-hours (6).
 *
 * Auto-run starts come from a TSV of opening-night-poller runs (id, title, created_at, updated_at, conclusion, event):
 *   gh api -X GET repos/<o>/<r>/actions/workflows/opening-night-poller.yml/runs -f per_page=100 \
 *     -f "created=2026-11-11T00:00:00Z..2026-11-25T00:00:00Z" --paginate \
 *     --jq '.workflow_runs[] | [.id,.display_title,.created_at,.updated_at,.conclusion,.event]|@tsv' > runs.tsv
 *
 * Usage: node scripts/audit-poller-nonbroadway-coverage.js --runs=runs.tsv [--days=14] [--now=ISO] [--limit-hours=6] [--json]
 * Exit 1 when a Broadway dispatch is lost or the worst latency exceeds the limit.
 */
const fs = require('fs');
const path = require('path');
const { planPollerDispatch } = require('./lib/poller-dispatch-plan');
const { selectOpeningNightShows } = require('./lib/opening-night-selection');
const { defaultEmbargoAt } = require('./lib/press-night-record');
const { orderPollShows } = require('./lib/poller-loop-budget');

const MIN = 60000;
const TICK_MIN = 15; // POLL_INTERVAL_OR_DEFAULT
const PER_SHOW_CAP_MIN = Number(process.argv.find((x) => x.startsWith('--per-show-min='))?.split('=')[1]) || 10; // showTimeoutSec capSec=600 in the poller loop (a real poll is 4-6 min)
const LOOP_BUDGET_MIN = 70; // POLL_LOOP_BUDGET_SEC=4200: a show past the budget waits for the NEXT auto run
const arg = (k, d = '') => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

function loadRuns(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split('\t')).map(([id, title, created, updated, conclusion]) => ({
    id, target: (title.split('— ')[1] || '').trim(), start: Date.parse(created), end: Date.parse(updated), conclusion,
  })).filter((r) => Number.isFinite(r.start));
}

function replay(all, fromMs, toMs) {
  const counts = { old: { broadway: 0, nonBroadway: 0 }, new: { broadway: 0, nonBroadway: 0 } };
  const lost = [];
  let ticks = 0; let inWindowTicks = 0;
  const cat = new Map(all.map((s) => [s.id, s.category || 'broadway']));
  for (let t = fromMs; t <= toMs; t += TICK_MIN * MIN) {
    const sel = selectOpeningNightShows(all, { market: '', now: new Date(t) });
    const shows = sel.map((s) => ({ id: s.id, category: s.category, embargoMs: Date.parse(defaultEmbargoAt(s) || '') }));
    ticks += 1;
    for (let rotation = 0; rotation < 6; rotation++) {
      const o = planPollerDispatch({ shows, nowMs: t, rotation, includeNonBroadway: true });
      const n = planPollerDispatch({ shows, nowMs: t, rotation });
      if (rotation === 0 && o.targetedIds.length) inWindowTicks += 1;
      for (const id of o.targetedIds) counts.old[cat.get(id) === 'broadway' ? 'broadway' : 'nonBroadway'] += 1;
      for (const id of n.targetedIds) counts.new[cat.get(id) === 'broadway' ? 'broadway' : 'nonBroadway'] += 1;
      for (const id of o.targetedIds) if (cat.get(id) === 'broadway' && !n.targetedIds.includes(id)) lost.push({ t: new Date(t).toISOString(), rotation, id });
      for (const id of n.targetedIds) if (cat.get(id) !== 'broadway') lost.push({ t: new Date(t).toISOString(), rotation, id, why: 'non-Broadway still targeted' });
    }
  }
  const per = (x) => Math.round(x / 6); // counts were summed over 6 rotations
  return { ticks, inWindowTicks, old: { broadway: per(counts.old.broadway), nonBroadway: per(counts.old.nonBroadway) }, new: { broadway: per(counts.new.broadway), nonBroadway: per(counts.new.nonBroadway) }, lost };
}

function latency(all, runs, fromMs, toMs) {
  const okDur = runs.filter((r) => r.target === 'auto' && r.conclusion === 'success').map((r) => (r.end - r.start) / MIN);
  const cycleMin = (okDur.length ? Math.max(...okDur) : 120) + TICK_MIN; // longest auto run + the orchestrator's sleep before the next dispatch
  const autoStarts = runs.filter((r) => r.target === 'auto').map((r) => r.start).sort((a, b) => a - b);
  const rows = [];
  for (const s of all) {
    const c = s.category || 'broadway';
    if (c === 'broadway') continue;
    const emb = Date.parse(defaultEmbargoAt(s) || '');
    if (!Number.isFinite(emb) || emb < fromMs || emb > toMs) continue;
    const winStart = emb - 60 * MIN; const winEnd = emb + 420 * MIN; // poller-dispatch-plan window
    // Front size at the embargo (shows ahead of it in the auto run's order): in-window + last-night shows, same order the poller uses.
    const sel = selectOpeningNightShows(all, { market: '', now: new Date(emb), lookbackDays: 2 });
    const order = orderPollShows(sel, new Date(emb));
    const idx = order.order.indexOf(s.id);
    const offsetMin = (idx < 0 ? order.front : idx) * PER_SHOW_CAP_MIN;
    const nextAuto = autoStarts.find((a) => a >= emb);
    const first = nextAuto == null ? null : (nextAuto - emb) / MIN;
    // Largest gap between consecutive auto starts that overlaps the window (a poll lands at the next start, plus the offset).
    const inWin = autoStarts.filter((a) => a >= winStart - 200 * MIN && a <= winEnd + 200 * MIN);
    let maxGap = 0;
    for (let i = 1; i < inWin.length; i++) if (inWin[i] > winStart && inWin[i - 1] < winEnd) maxGap = Math.max(maxGap, (inWin[i] - inWin[i - 1]) / MIN);
    // Conservative: every show ahead takes its full 10-min cap; one past the 70-min loop budget is cut and waits a whole extra cycle.
    const cut = offsetMin > LOOP_BUDGET_MIN;
    const worst = Math.max(first == null ? 0 : first, maxGap, cycleMin) + Math.min(offsetMin, LOOP_BUDGET_MIN) + (cut ? cycleMin : 0);
    rows.push({ show: s.id, category: c, embargo: new Date(emb).toISOString(), firstAutoAfterEmbargoMin: first == null ? null : Math.round(first), positionOffsetMin: offsetMin, budgetCut: cut, maxAutoGapInWindowMin: Math.round(maxGap), worstCaseMin: Math.round(worst) });
  }
  rows.sort((a, b) => b.worstCaseMin - a.worstCaseMin);
  const durations = runs.filter((r) => r.target === 'auto' && r.conclusion === 'success').map((r) => (r.end - r.start) / MIN).sort((a, b) => a - b);
  return { rows, autoRunMin: durations.length ? { n: durations.length, p50: Math.round(durations[Math.floor(durations.length / 2)]), max: Math.round(durations[durations.length - 1]) } : null };
}

function main() {
  const days = Number(arg('days', '14'));
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const limitMin = Number(arg('limit-hours', '6')) * 60;
  const all = loadShows();
  const fromMs = now - days * 24 * 60 * MIN;
  const rep = replay(all, fromMs, now);
  const runsFile = arg('runs');
  const lat = runsFile ? latency(all, loadRuns(runsFile), fromMs, now) : null;
  const worst = lat && lat.rows.length ? lat.rows[0].worstCaseMin : null;
  const out = { days, ticks: rep.ticks, ticksWithTargetedDispatch: rep.inWindowTicks, targetedDispatchesOld: rep.old, targetedDispatchesNew: rep.new, broadwayDispatchesLost: rep.lost.length, lost: rep.lost.slice(0, 10), latency: lat && { autoRunMinutes: lat.autoRunMin, nonBroadwayShowsInPeriod: lat.rows.length, worstCaseMin: worst, top5: lat.rows.slice(0, 5) }, limitMin };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`replay ${days}d: ${rep.ticks} ticks, ${rep.inWindowTicks} with a targeted dispatch (old plan)`);
    console.log(`targeted dispatches (per rotation-0 ticks): old broadway=${rep.old.broadway} non-broadway=${rep.old.nonBroadway} | new broadway=${rep.new.broadway} non-broadway=${rep.new.nonBroadway}`);
    console.log(`Broadway dispatches lost or non-Broadway still targeted (all rotations 0-5): ${rep.lost.length}`);
    if (lat) {
      console.log(`auto runs: ${JSON.stringify(lat.autoRunMin)} min; non-Broadway shows with an embargo in the period: ${lat.rows.length}`);
      for (const r of lat.rows.slice(0, 5)) console.log(`  ${r.show} (${r.category}) embargo ${r.embargo}: first auto poll +${r.firstAutoAfterEmbargoMin}m, max auto gap in window ${r.maxAutoGapInWindowMin}m, position offset ${r.positionOffsetMin}m${r.budgetCut ? ' (past loop budget: +1 cycle)' : ''} => worst ${r.worstCaseMin}m`);
      console.log(`WORST-CASE non-Broadway discovery latency: ${worst}m (limit ${limitMin}m)`);
    }
  }
  const fail = rep.lost.length > 0 || (worst != null && worst > limitMin);
  process.exit(fail ? 1 : 0);
}

module.exports = { replay, latency, loadRuns };
if (require.main === module) main();
