#!/usr/bin/env node
'use strict';
/**
 * press-night-watchdog.js (BRO-6858): the old-path press-night watchdog. Started by press-night-clock.yml at the
 * night's kick (embargo -2h) through press-night-watchdog.yml. Sleeps to the embargo, then ticks every 10 min to +3h.
 * Decisions are scripts/lib/press-night-watchdog.js (pure, unit tested); this file gathers state and acts.
 *
 *   node scripts/press-night-watchdog.js --show=ID --night=YYYY-MM-DD [--embargo-at=ISO] [--dry-run]
 *        [--once] [--now=ISO] [--interval-min=10] [--until-min=180] [--tick-log=PATH]
 *
 * Each tick: REFRESH_CMD (the workflow's pull of core data + the show's review texts), the review files
 * (press-night-review-state), core data/reviews.json, the live https://broadwayscorecard.com/data/shows/<id>.json,
 * recent runs of the workflows that move a review (gh run list), the broadcast state, and LANE_ONLY_MARKETS /
 * LANE_STANDDOWN (read live). --dry-run decides and logs only: no dispatch, no claim, no alert (off-Broadway nights,
 * which BRO-6687 owns, always run dry). Exit 0 unless the watchdog itself could not run.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const wd = require('./lib/press-night-watchdog');

const argv = process.argv.slice(2);
const arg = (k) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : ''; };
const flag = (k) => argv.includes(`--${k}`);
const ROOT = path.join(__dirname, '..');
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const SITE = process.env.PRESS_NIGHT_SITE || 'https://broadwayscorecard.com';
const MIN = 60000;
const log = (s) => console.log(s);

function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; } }
function showsList() { const raw = loadJson(path.join(ROOT, 'data', 'shows.json'), []); return Array.isArray(raw) ? raw : raw.shows || []; }

function gh(args, timeout = 30000) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

function recentRuns() {
  const out = [];
  for (const workflow of ['opening-night-orchestrator.yml', 'opening-night-poller.yml', 'llm-ensemble-score.yml', 'rebuild-fast.yml', 'vercel-deploy.yml']) {
    try {
      const rows = JSON.parse(gh(['run', 'list', `--workflow=${workflow}`, '--limit', '20', '--json', 'status,conclusion,displayTitle,createdAt,updatedAt,databaseId']));
      for (const r of rows) out.push({ workflow, ...r });
    } catch (e) { log(`::warning::could not list ${workflow} runs (${String(e.message).split('\n')[0].slice(0, 100)})`); }
  }
  return out;
}

async function liveRows(showId) {
  try {
    const res = await fetch(`${SITE}/data/shows/${showId}.json?wd=${Date.now()}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, rows: [], why: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, rows: Array.isArray(j.rv) ? j.rv : [] };
  } catch (e) { return { ok: false, rows: [], why: String(e.message).slice(0, 80) }; }
}

function broadcastDone(showId) {
  try {
    const raw = execFileSync('gh', ['api', 'repos/thomaspryor/broadway-scorecard-data/contents/opening-night-sent.json', '--jq', '.content'],
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, GH_TOKEN: process.env.CORE_DATA_TOKEN || process.env.GH_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
    const d = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const e = d.shows && d.shows[showId];
    return !!(e && (e.completed || e.discardedAt));
  } catch (_) { return false; } // unknown = not done: the orchestrator exits early on its own if it is
}

function laneOwnsNight(show) {
  const read = (name) => {
    try {
      const v = execFileSync('bash', [path.join(ROOT, 'scripts/lib/read-actions-variable.sh'), name],
        { encoding: 'utf8', timeout: 25000, env: { ...process.env, GH_TOKEN: process.env.VARS_TOKEN || process.env.GH_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, value: v.trim() };
    } catch (_) { return { ok: false }; }
  };
  const lom = require('./lib/opening-night-lane/lane-only-markets');
  const { standsDown } = require('./lib/opening-night-lane/standdown');
  const only = read('LANE_ONLY_MARKETS');
  if (!lom.coversShow(only, show)) return false; // unread or not covering = the old path is on, so is this watchdog
  const sd = read('LANE_STANDDOWN');
  return !(sd.ok && standsDown(sd.value, show));
}

/** Once-per-night claim on the lane fallback branch. The orchestrator stage shares the lane watchdog's own key. */
function claim(showId, night, stage, holder) {
  const store = require('./lib/opening-night-lane/lease-store');
  const af = require('./lib/opening-night-lane/auto-fallback');
  const id = stage === 'orchestrator' ? showId : `${showId}~pnw-${stage}`;
  const now = new Date().toISOString();
  try {
    const got = store.casTransition({ repoDir: ROOT, branch: af.FALLBACK_BRANCH, message: `press-night watchdog claim ${id}|${night} (BRO-6858)` },
      (s) => af.claimFallback(s, { show: id, night, holder, now }));
    if (!got.ok) return got;
    store.casTransition({ repoDir: ROOT, branch: af.FALLBACK_BRANCH, message: `press-night watchdog dispatched ${id}|${night} (BRO-6858)` },
      (s) => af.markFallbackDispatched(s, { show: id, night, holder, now }));
    return { ok: true };
  } catch (e) { return { ok: false, reason: `claim write failed: ${String(e.message).slice(0, 100)}` }; }
}

function dispatchArgs(stage, showId, night) {
  if (stage === 'score') return ['workflow', 'run', 'llm-ensemble-score.yml', '-f', `show_id=${showId}`];
  if (stage === 'rebuild') return ['workflow', 'run', 'rebuild-fast.yml', '-f', `reason=press-night watchdog ${showId} ${night} (BRO-6858)`];
  if (stage === 'deploy') return ['workflow', 'run', 'vercel-deploy.yml', '-f', 'source=press-night-watchdog'];
  if (stage === 'orchestrator') return ['workflow', 'run', 'opening-night-orchestrator.yml', '-f', `show_id=${showId}`, '-f', 'market=broadway'];
  throw new Error(`unknown stage ${stage}`);
}

async function alert(kind, showId, night, reason) {
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  const conditionKey = `press-night:stuck:${showId}:${night}`;
  if (kind === 'resolve') { resolveCondition(conditionKey, { reason: 'every found review is live' }); return 'resolved'; }
  const runUrl = process.env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const res = await routeAlert({
    conditionKey, severity: 'error', disposition: 'human', cooldownHours: 24,
    title: `Press night: ${showId} reviews found but not on the site`,
    description: `${reason}. The press-night watchdog already retried the stuck step once; a worker session or the next poller run picks it up. Watchdog run: ${runUrl || 'local'}`,
    url: runUrl,
  });
  return (res && res.action) || 'sent';
}

async function main() {
  const showId = arg('show');
  const night = arg('night');
  if (!/^[a-z0-9-]+$/.test(showId) || !/^\d{4}-\d{2}-\d{2}$/.test(night)) { console.error('--show=ID --night=YYYY-MM-DD required'); return 2; }
  const dryRun = flag('dry-run');
  const once = flag('once');
  const intervalMin = Number(arg('interval-min')) || 10;
  const untilMin = Number(arg('until-min')) || 180;
  const tickLog = arg('tick-log');
  const holder = `pnw-${process.env.GITHUB_RUN_ID || process.pid}`;
  let show = showsList().find((s) => (s.id || s.slug) === showId);
  if (!show) { console.error(`${showId} is not in data/shows.json`); return 1; }
  const { defaultEmbargoAt, DEFAULT_GATES } = require('./lib/press-night-record'); // lane lib: required, never edited
  if (DEFAULT_GATES && DEFAULT_GATES.nightStartH !== wd.NIGHT_START_H) log(`::warning::nightStartH is ${DEFAULT_GATES.nightStartH}, watchdog uses ${wd.NIGHT_START_H}`);
  const embargoOf = () => Date.parse(arg('embargo-at') || defaultEmbargoAt(show) || '');
  let embargoMs = embargoOf();
  if (!Number.isFinite(embargoMs)) { console.error('no embargo for the show'); return 1; }
  const nowFn = () => (arg('now') ? Date.parse(arg('now')) : Date.now());
  log(`press-night watchdog ${showId} ${night}: embargo ${new Date(embargoMs).toISOString()}, ${dryRun ? 'DRY RUN' : 'live'}, every ${intervalMin} min to +${untilMin} min`);

  if (!once) {
    const wait = embargoMs - nowFn();
    if (wait > 0) { log(`sleeping ${Math.round(wait / MIN)} min to the embargo`); await new Promise((r) => setTimeout(r, wait)); }
  }
  const { readReviewFileState } = require('./lib/press-night-review-state');
  const { normalizeOutlet } = require('./lib/review-normalization');
  const normOutlet = (o) => (o ? normalizeOutlet(String(o)) || String(o).toLowerCase() : null);
  let state = {};
  for (;;) {
    if (process.env.REFRESH_CMD) {
      try { execSync(process.env.REFRESH_CMD, { stdio: 'ignore', timeout: 180000, shell: '/bin/bash' }); } catch (e) { log(`::warning::refresh failed (${String(e.message).split('\n')[0].slice(0, 100)}); judging from the last copy`); }
      const fresh = showsList().find((s) => (s.id || s.slug) === showId);
      if (fresh) show = fresh;
      if (!arg('embargo-at')) { const e = embargoOf(); if (Number.isFinite(e) && e !== embargoMs) { log(`embargo moved to ${new Date(e).toISOString()}`); embargoMs = e; } }
    }
    const nowMs = nowFn();
    let fileState = readReviewFileState(showId, show);
    // Review texts checked out but no folder for the show yet (no file of the night written): none found, not blind.
    if (!fileState.available && fs.existsSync(path.join(ROOT, 'data', 'review-texts', '.git'))) fileState = { available: true, files: [] };
    const reviews = loadJson(path.join(ROOT, 'data', 'reviews.json'), { reviews: [] });
    const coreRows = (Array.isArray(reviews) ? reviews : reviews.reviews || []).filter((r) => r.showId === showId);
    const live = await liveRows(showId);
    const runs = recentRuns();
    const lane = laneOwnsNight(show);
    const done = broadcastDone(showId);
    const r = wd.evaluateTick({ showId, embargoMs, nowMs, files: fileState.files, coreRows, liveRows: live.rows, runs,
      broadcastDone: done, laneOwnsNight: lane, state, normOutlet });
    const prevState = state;
    state = r.state;
    const notes = [];
    if (!fileState.available) notes.push('review texts not checked out');
    if (!live.ok) notes.push(`live JSON unreadable (${live.why})`);
    const acted = [];
    // A tick that cannot see the site or the files must not dispatch or page from a blind spot.
    const blind = !fileState.available || !live.ok;
    for (const a of r.actions) {
      // A dry run advances state as if sent (it shows the night's decisions); a blind or failed action does not.
      if (dryRun && !blind) { acted.push(`dry-run: would ${a.type}${a.stage ? ' ' + a.stage : ''}`); continue; }
      if (blind) { acted.push(`blind: would ${a.type}${a.stage ? ' ' + a.stage : ''}`); state = wd.undoUnsent(prevState, state, a); continue; }
      if (a.type === 'dispatch' || a.type === 'dispatch-orchestrator') {
        const stage = a.stage || 'orchestrator';
        const c = claim(showId, night, stage, holder);
        // Claimed by another tick or run = sent this night; a failed claim write is retried next tick.
        if (!c.ok) { acted.push(`${stage}: not dispatched (${c.reason})`); if (/claim write failed/.test(c.reason || '')) state = wd.undoUnsent(prevState, state, a); continue; }
        try { gh(dispatchArgs(stage, showId, night), 60000); acted.push(`${stage}: dispatched`); } catch (e) { acted.push(`${stage}: dispatch failed (${String(e.message).split('\n')[0].slice(0, 80)})`); }
      } else if (a.type === 'page' || a.type === 'resolve') {
        try { acted.push(`${a.type}: ${await alert(a.type, showId, night, a.reason)}`); } catch (e) { acted.push(`${a.type} failed (${String(e.message).slice(0, 80)})`); state = wd.undoUnsent(prevState, state, a); }
      }
    }
    const row = { ...r.summary, notes, actions: acted };
    log(JSON.stringify(row));
    if (tickLog) fs.appendFileSync(tickLog, JSON.stringify(row) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${row.at.slice(11, 16)}Z | +${row.sinceEmbargoMin} | ${row.found} | ${row.live} | ${row.pending.join(' ') || '-'} | ${row.pipelineActive ? 'yes' : 'no'} | ${acted.join('; ') || '-'} |\n`);
    }
    if (once || nowMs - embargoMs >= untilMin * MIN) break;
    await new Promise((res) => setTimeout(res, intervalMin * MIN));
  }
  return 0;
}

if (require.main === module) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '| tick | +min | found | live | waiting (outlet:stage:age) | pipeline | actions |\n|---|---|---|---|---|---|---|\n');
  main().then((c) => process.exit(c), (e) => { console.log(`::error::press-night watchdog: ${e && e.stack}`); process.exit(1); });
}
