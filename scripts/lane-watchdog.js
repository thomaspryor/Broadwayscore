#!/usr/bin/env node
'use strict';
/**
 * BRO-6621: the opening-night lane watchdog loop (opening-night-lane-watchdog.yml). Decision: decideWatchdog and
 * runWatchdogTick in scripts/lib/opening-night-lane/auto-fallback.js. Kept apart from scripts/lane-auto-fallback.js so
 * the starter and the night-wait job never load the alert router.
 *
 *   node scripts/lane-watchdog.js --show= --night= [--since=ISO] [--budget-min=330] [--fallback-done=1] [--lease-seen=1]
 *                                 [--dry-run] [--now=]
 *       Ticks every 5 minutes for up to --budget-min. Writes result=stopped|fallback-quiet|fallback-paged|chain (plus
 *       fallback_done and lease_seen on chain) to $GITHUB_OUTPUT (and stdout). The workflow re-dispatches on chain and
 *       fails the run on fallback-paged. --lease-seen: an earlier hop saw the lane hold a live lease (a green lane run
 *       then counts as finished, not as a lane that never ran). --dry-run reads the real lease and run list but
 *       releases, claims, dispatches and pages nothing. --now= runs one tick at that time; dry-run only.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const { execFileSync } = require('child_process');
const af = require('./lib/opening-night-lane/auto-fallback');
const { loadShows, findShow, readVarsLive, output, arg, flag } = require('./lane-auto-fallback');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lane night run status from `gh run list`: active | success | failure | none | unknown. */
function laneRunStatus(show, night) {
  try {
    const out = execFileSync('gh', ['run', 'list', '--workflow=opening-night-lane-live.yml', '--limit=100',
      '--json', 'displayTitle,status,conclusion,createdAt'], { encoding: 'utf8', timeout: 60000 });
    const title = af.nightRunTitle(show, night);
    const runs = JSON.parse(out).filter((r) => r.displayTitle === title);
    if (!runs.length) return { status: 'none' };
    const active = runs.filter((r) => r.status !== 'completed').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (active.length) return { status: 'active', createdAt: active[0].createdAt };
    const last = runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return { status: last.conclusion === 'success' ? 'success' : 'failure', createdAt: last.createdAt };
  } catch (e) {
    console.log(`::warning::lane run list failed (${String(e.message).slice(0, 120)})`);
    return { status: 'unknown' };
  }
}

function readLeaseState() {
  try { return require('./lib/opening-night-lane/lease-store').readRemote({ repoDir: process.cwd() }).state; } catch (e) {
    console.log(`::warning::lease state unreadable (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

async function watchdog() {
  const shows = loadShows();
  const id = arg('show');
  const night = arg('night');
  const show = findShow(shows, id);
  if (!show) { console.log(`::error::lane-watchdog: show ${id} is not in shows.json`); return 1; }
  const dryRun = flag('dry-run');
  const oneTickAt = arg('now');
  if (oneTickAt && !dryRun) { console.log('::error::lane-watchdog: --now is for dry runs only'); return 1; }
  const holder = `watchdog:${process.env.GITHUB_RUN_ID || process.pid}`;
  const sinceMs = Date.parse(arg('since') || '') || Date.now();
  const budgetMs = Number(arg('budget-min') || af.WAIT_JOB_BUDGET_MIN) * 60 * 1000;
  const runUrl = process.env.RUN_URL || '';
  const market = show.market === 'west-end' ? 'west-end' : 'broadway';
  const t0 = Date.now();
  let pending = null; // the fallback decision to page, set by ports.page
  const ports = {
    readLeaseState,
    laneRunStatus: () => laneRunStatus(id, night),
    readVars: () => readVarsLive(),
    release: (fn) => {
      if (dryRun) { console.log('dry-run: would release the dead lease'); return { ok: true, released: false }; }
      const store = require('./lib/opening-night-lane/lease-store');
      return store.casTransition({ repoDir: process.cwd(), message: `opening-night lease: watchdog released dead ${id}|${night} (BRO-6621)` }, fn);
    },
    claim: (fn) => {
      if (dryRun) { console.log('dry-run: would claim the night\'s fallback'); return { ok: true }; }
      const store = require('./lib/opening-night-lane/lease-store');
      try {
        return store.casTransition({ repoDir: process.cwd(), branch: af.FALLBACK_BRANCH, message: `opening-night lane fallback claim ${id}|${night} (BRO-6621)` }, fn);
      } catch (e) { return { ok: false, reason: `claim write failed: ${String(e.message).slice(0, 120)}` }; }
    },
    dispatchOldPath: () => {
      if (dryRun) { console.log(`dry-run: would dispatch opening-night-orchestrator.yml show_id=${id} market=${market}`); return true; }
      try {
        execFileSync('gh', ['workflow', 'run', 'opening-night-orchestrator.yml', '-f', `show_id=${id}`, '-f', `market=${market}`], { stdio: 'inherit', timeout: 60000 });
        return true;
      } catch (e) { console.log(`::warning::old-path dispatch failed (${String(e.message).slice(0, 120)})`); return false; }
    },
    page: (d) => { pending = d; },
    log: (s) => console.log(s),
  };
  let fallbackDone = flag('fallback-done');
  let leaseSeen = flag('lease-seen');
  let claimFailures = 0;
  for (;;) {
    const r = af.runWatchdogTick({ show, night, now: oneTickAt || undefined, sinceMs, fallbackDone, leaseSeen, holder, claimFailures }, ports);
    if (r.dispatched) fallbackDone = true;
    if (r.leaseLive) leaseSeen = true;
    if (typeof r.claimFailures === 'number') claimFailures = r.claimFailures;
    if (r.done || oneTickAt) {
      if (pending) await page(pending, { id, night, runUrl, dryRun });
      const result = r.action === 'fallback' ? (pending ? 'fallback-paged' : 'fallback-quiet') : (r.done ? 'stopped' : 'waiting');
      output('result', result);
      return 0;
    }
    if (Date.now() - t0 + af.TICK_MIN * 60 * 1000 > budgetMs) {
      output('fallback_done', fallbackDone ? 'true' : 'false');
      output('lease_seen', leaseSeen ? 'true' : 'false');
      output('result', 'chain');
      return 0;
    }
    await sleep(af.TICK_MIN * 60 * 1000);
  }
}

async function page(d, { id, night, runUrl, dryRun }) {
  console.log(`::error::opening-night lane for ${id} (${night}) is dead: ${d.reason}. The old path was dispatched once.`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Lane auto fallback for ${id} (${night}): ${d.reason}. Old path dispatched; paged (digest).\n`);
  if (dryRun) { console.log('page=dry-run'); return; }
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    const res = await routeAlert({
      severity: 'error', disposition: 'digest', cooldownHours: 12,
      conditionKey: `opening-night-lane-auto-fallback:${id}:${night}`,
      title: `Opening-night lane died for ${id} (${night}); the old path took over`,
      description: `The lane watchdog found the lane dead (${d.reason}). It released the dead lease${d.release ? '' : ' (none was held)'} and dispatched the old path (opening-night-orchestrator.yml for this show) once. Run: ${runUrl || 'unknown'}`,
      url: runUrl || undefined,
    });
    console.log(`page=${(res && res.action) || 'sent'}`);
  } catch (e) { console.log(`::warning::digest row failed (${String(e.message).slice(0, 120)}); the red run still reports it`); }
}

watchdog().then((code) => process.exit(code), (e) => { console.log(`::error::lane-watchdog: ${e && e.message}`); process.exit(1); });
