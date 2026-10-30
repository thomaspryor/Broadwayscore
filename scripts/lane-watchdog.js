#!/usr/bin/env node
'use strict';
/**
 * BRO-6621: the opening-night lane watchdog loop (opening-night-lane-watchdog.yml). Decision: decideWatchdog and
 * runWatchdogTick in scripts/lib/opening-night-lane/auto-fallback.js. Kept apart from scripts/lane-auto-fallback.js so
 * the starter and the night-wait job never load the alert router.
 *
 *   node scripts/lane-watchdog.js --show= --night= [--since=ISO] [--budget-min=330] [--fallback-done=1] [--lease-seen=1]
 *                                 [--progress=JSON] [--dry-run] [--now=]
 *       Ticks every 5 minutes for up to --budget-min. Writes result=stopped|fallback-quiet|fallback-paged|chain (plus
 *       fallback_done and lease_seen on chain) to $GITHUB_OUTPUT (and stdout). The workflow re-dispatches on chain and
 *       fails the run on fallback-paged. --lease-seen: an earlier hop saw the lane hold a live lease (a green lane run
 *       then counts as finished, not as a lane that never ran). --dry-run reads the real lease and run list but
 *       releases, claims, dispatches and pages nothing. --now= runs one tick at that time; dry-run only.
 *       --progress: the previous hop's observations (BRO-6669 stuck check), echoed back as progress on chain. Bad JSON
 *       starts fresh, which only delays a stuck verdict.
 *
 * BRO-6669: from lane start, each tick first observes the live site (its review count, and which census reviews it
 * lacks) and refreshes the census every 15 min (scripts/lib/press-night-census.js: aggregator archive plus the live BWW
 * roundup, minus the probe's exclusions and the outlets CI cannot fetch). decideWatchdog then judges stuck-but-alive.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const af = require('./lib/opening-night-lane/auto-fallback');
const { loadShows, findShow, readVarsLive, output, arg, flag } = require('./lane-auto-fallback');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROD_BASE = 'https://broadwayscorecard.com/data/shows';
const CENSUS_REFRESH_MIN = 15;
const FETCH_TIMEOUT_MS = 60000;

/** Parse --progress; anything but a JSON object for this show and night starts fresh. */
function parseProgress(raw, key) {
  if (!raw) return { key };
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      if (p.key === key) return p;
      console.log(`::warning::--progress is for ${p.key || 'an unknown night'}, not ${key}; starting the stuck check fresh`);
      return { key };
    }
  } catch (_) { /* fall through */ }
  console.log('::warning::--progress is not a JSON object; starting the stuck check fresh');
  return { key };
}

/**
 * Observer for the stuck check: live review count, and the census judged against the live site. The census is
 * rebuilt at most every 15 min (the BWW roundup URL is kept once found). Every failure reads as "unknown" (null), never
 * as evidence. Returns {liveCount, census:{count, missing}|null, note}.
 */
function createObserver(show, night, { embargoMs }) {
  let cache = null; // {census (kept), builtAt, url}
  return async (nowMs) => {
    let prod = null;
    try {
      const res = await fetch(`${PROD_BASE}/${show.id}.json`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      prod = await res.json();
    } catch (e) { console.log(`::warning::live site read failed (${String(e.message).slice(0, 120)})`); }
    if (!cache || nowMs - cache.builtAt >= CENSUS_REFRESH_MIN * 60 * 1000) {
      try {
        const { buildPressNightCensus } = require('./lib/press-night-census');
        const market = show.market === 'west-end' ? 'west-end' : (show.market || 'broadway');
        const { census, note } = await buildPressNightCensus({ showId: show.id, market, show, bwwUrl: cache && cache.url, timeoutMs: FETCH_TIMEOUT_MS });
        // The probe's exclusions (BRO-6070): reviews the rebuild keeps off the site never count as missing.
        // The lane writes tonight's review files (and their exclusion flags) after this job checked them out, so pull
        // the show's folder first; a stale copy would count reviews the lane rightly kept off the site as missing.
        refreshReviewTexts();
        const state = require('./lib/press-night-review-state');
        const pn = require('./lib/press-night-record');
        const files = state.readReviewFileState(show.id, show);
        const excluded = files.available
          ? state.censusExclusions(census, files.files, { windowStartMs: embargoMs - pn.DEFAULT_GATES.nightStartH * 3600000, night })
          : [];
        cache = { census: pn.filterCensus(census, excluded), builtAt: nowMs, url: census.bwwRoundupUrl || (cache && cache.url) || null };
        console.log(`census: ${cache.census.count} reviews (${note})${excluded.length ? `, ${excluded.length} excluded` : ''}`);
      } catch (e) {
        // Wait out the refresh interval before trying again, so a failing source is not re-fetched (and paid for) every tick.
        cache = { ...(cache || { census: null, url: null }), builtAt: nowMs };
        console.log(`::warning::census build failed (${String(e.message).slice(0, 120)}); keeping the last one`);
      }
    }
    if (!prod) return { liveCount: null, census: null };
    const { decodeSlimShow } = require('./show-status');
    const liveCount = decodeSlimShow(prod).reviews.length;
    if (!cache || !cache.census || !cache.census.count) return { liveCount, census: null };
    const { censusVerdict, CI_UNFETCHABLE_OUTLETS } = require('./lib/review-census');
    const { deployedOutletIds } = require('./lib/deployed-coverage-diff');
    const v = censusVerdict(cache.census, deployedOutletIds(prod), { suppressed: CI_UNFETCHABLE_OUTLETS });
    return { liveCount, census: { count: cache.census.count, missing: v.missing.map((e) => e.outletId) } };
  };
}

/** Fast-forward the job's data/review-texts checkout (the workflow's sparse clone) to the lane's latest writes. */
function refreshReviewTexts() {
  const dir = path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(path.join(dir, '.git'))) return;
  try {
    execFileSync('git', ['-C', dir, 'pull', '--ff-only', '-q'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  } catch (e) { console.log(`::warning::review-texts refresh failed (${String(e.message).slice(0, 120)}); using the checked-out copy`); }
}

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
      if (dryRun) { console.log('dry-run: would release the lease'); return { ok: true, released: false }; }
      const store = require('./lib/opening-night-lane/lease-store');
      try {
        return store.casTransition({ repoDir: process.cwd(), message: `opening-night lease: watchdog released ${id}|${night} (BRO-6621/BRO-6669)` }, fn);
      } catch (e) { return { ok: false, reason: `release write failed: ${String(e.message).slice(0, 120)}` }; }
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
  let progress = parseProgress(arg('progress'), `${show.id}|${night}`);
  const times = af.nightTimes(show, night);
  const observe = times && createObserver(show, night, times);
  for (;;) {
    const nowMs = oneTickAt ? Date.parse(oneTickAt) : Date.now();
    // Observe first, then decide once (BRO-6669). Nothing to observe before lane start or after the fallback.
    if (observe && !fallbackDone && nowMs >= times.laneStartMs && nowMs < times.watchEndMs) {
      progress = af.updateProgress(progress, await observe(nowMs), nowMs);
      const c = progress.census;
      console.log(`observed: live ${progress.liveCount ?? '?'}${c ? `, census ${c.count}, missing ${c.missing.length}` : ', no census yet'}`);
    }
    const r = af.runWatchdogTick({ show, night, now: oneTickAt || undefined, sinceMs, fallbackDone, leaseSeen, holder, claimFailures, progress }, ports);
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
      output('progress', JSON.stringify(progress));
      output('result', 'chain');
      return 0;
    }
    await sleep(af.TICK_MIN * 60 * 1000);
  }
}

async function page(d, { id, night, runUrl, dryRun }) {
  const stuck = d.kind === 'stuck-but-alive';
  const what = stuck ? 'is stuck (alive, publishing nothing)' : 'is dead';
  console.log(`::error::opening-night lane for ${id} (${night}) ${what}: ${d.reason}. The old path was dispatched once.`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Lane auto fallback for ${id} (${night}): ${d.reason}. Old path dispatched; paged (digest).\n`);
  if (dryRun) { console.log('page=dry-run'); return; }
  try {
    const { routeAlert } = require('./lib/owner-alert-router');
    const res = await routeAlert({
      severity: 'error', disposition: 'digest', cooldownHours: 12,
      conditionKey: `opening-night-lane-auto-fallback:${id}:${night}`,
      title: stuck
        ? `Opening-night lane stuck for ${id} (${night}); the old path took over`
        : `Opening-night lane died for ${id} (${night}); the old path took over`,
      description: stuck
        ? `The lane watchdog found the lane alive but stuck (${d.reason}). It released lane ${d.holder}'s lease and dispatched the old path (opening-night-orchestrator.yml for this show) once. The lane run will also go red with lease-lost at its next heartbeat; that is the same event. Run: ${runUrl || 'unknown'}`
        : `The lane watchdog found the lane dead (${d.reason}). It released the dead lease${d.release ? '' : ' (none was held)'} and dispatched the old path (opening-night-orchestrator.yml for this show) once. Run: ${runUrl || 'unknown'}`,
      url: runUrl || undefined,
    });
    console.log(`page=${(res && res.action) || 'sent'}`);
  } catch (e) { console.log(`::warning::digest row failed (${String(e.message).slice(0, 120)}); the red run still reports it`); }
}

watchdog().then((code) => process.exit(code), (e) => { console.log(`::error::lane-watchdog: ${e && e.message}`); process.exit(1); });
