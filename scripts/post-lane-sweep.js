#!/usr/bin/env node
'use strict';
/**
 * BRO-7160: one post-lane sweep slot for one Broadway press night. Run by press-night-clock.yml when a sw1/sw2/sw3/swv
 * event is due (rules: scripts/lib/post-lane-sweep.js).
 *
 *   node scripts/post-lane-sweep.js --show=ID --night=YYYY-MM-DD --slot=sw1|sw2|sw3|swv [--embargo-at=ISO] [--now=ISO] [--dry-run]
 *   node scripts/post-lane-sweep.js --plan --show=ID [--night=..] [--embargo-at=ISO]   -> prints every slot time
 *
 * A dispatch is claimed once per show, night and slot on the lane fallback branch (claim -> dispatch -> mark, through
 * press-night-watchdog.js claimThenDispatch), so a re-seeded clock or a second runner never sends it twice.
 * --dry-run reads nothing remote and dispatches nothing: it prints the plan and the decision for unread inputs.
 * Kill switch: POST_LANE_SWEEP_DISABLED=true (repo variable, passed in by the workflow).
 * Exit: 0 done or skipped, 1 a dispatch failed after retries, 2 bad arguments.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sweep = require('./lib/post-lane-sweep');

const argv = process.argv.slice(2);
const arg = (k) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : ''; };
const flag = (k) => argv.includes(`--${k}`);
const ROOT = path.join(__dirname, '..');
const log = (s) => console.log(s);

function showsList() {
  try { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')); return Array.isArray(raw) ? raw : raw.shows || []; } catch (_) { return []; }
}
function gh(args, timeout = 30000) { return execFileSync('gh', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }); }

function embargoFor(showId, night) {
  const given = arg('embargo-at');
  if (given) return given;
  const show = showsList().find((s) => (s.id || s.slug) === showId);
  if (!show) return '';
  const { defaultEmbargoAt } = require('./lib/press-night-record');
  return defaultEmbargoAt(night ? { ...show, openingDate: night } : show) || '';
}

function pollerRuns() {
  try { return JSON.parse(gh(['run', 'list', `--workflow=${sweep.POLLER_WORKFLOW}`, '--limit', '60', '--json', 'status,conclusion,displayTitle,createdAt,databaseId'])); } catch (e) {
    log(`::warning::could not list poller runs (${String(e.message).split('\n')[0].slice(0, 100)})`);
    return null;
  }
}
function leaseState() {
  try { const store = require('./lib/opening-night-lane/lease-store'); return store.readRemote({ repoDir: ROOT, remote: 'origin', branch: store.DEFAULT_BRANCH }).state; } catch (_) { return null; }
}

function dispatchOnce(showId) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { gh(sweep.dispatchArgs(showId), 60000); return 'ok'; } catch (e) { last = e; if (i < 2) execFileSync('sleep', [String(5 * (i + 1))]); }
  }
  throw last;
}

function claimAndDispatch(showId, night, kind) {
  const store = require('./lib/opening-night-lane/lease-store');
  const af = require('./lib/opening-night-lane/auto-fallback');
  const wd = require('./lib/press-night-watchdog');
  const id = sweep.claimId(showId, kind);
  const holder = sweep.claimHolder(showId, night, kind);
  const cas = (what, fn) => store.casTransition({ repoDir: ROOT, branch: af.FALLBACK_BRANCH, message: `post-lane sweep ${what} ${id}|${night} (BRO-7160)` }, fn);
  const now = () => new Date().toISOString();
  return wd.claimThenDispatch({
    claim: () => cas('claim', (s) => af.claimFallback(s, { show: id, night, holder, now: now() })),
    dispatch: () => dispatchOnce(showId),
    mark: () => cas('dispatched', (s) => af.markFallbackDispatched(s, { show: id, night, holder, now: now() })),
    unclaim: () => cas('unclaim', (s) => wd.releaseClaim(s, { show: id, night, holder })),
  });
}

function main() {
  const showId = arg('show');
  const night = arg('night');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(showId) || (night && !/^\d{4}-\d{2}-\d{2}$/.test(night))) {
    console.error('usage: post-lane-sweep.js --show=ID --night=YYYY-MM-DD --slot=sw1|sw2|sw3|swv [--embargo-at=ISO] [--now=ISO] [--dry-run] | --plan');
    return 2;
  }
  const embargoAt = embargoFor(showId, night);
  const embargoMs = Date.parse(embargoAt);
  if (!Number.isFinite(embargoMs)) { console.error(`no embargo time for ${showId} (pass --embargo-at=ISO)`); return 2; }
  const slots = sweep.planSlots(embargoMs);
  log(`Post-lane sweep for ${showId} ${night || ''} (embargo ${new Date(embargoMs).toISOString()}):`);
  for (const s of slots) log(`  ${s.kind}  ${s.atIso}  (embargo +${Math.round((s.atMs - embargoMs) / 60000)} min)`);
  if (flag('plan')) return 0;

  const kind = arg('slot');
  if (!sweep.isSweepKind(kind) || !night) { console.error('--slot=sw1|sw2|sw3|swv and --night are required'); return 2; }
  const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
  const dry = flag('dry-run');
  const disabled = String(process.env.POST_LANE_SWEEP_DISABLED || '').trim().toLowerCase() === 'true';
  const inputs = { showId, kind, embargoMs, nowMs, disabled, leaseState: dry ? null : leaseState(), runs: dry ? null : pollerRuns() };
  const d = kind === 'swv' ? sweep.decideVerify(inputs) : sweep.decideSweep(inputs);
  log(`Slot ${kind} at ${new Date(nowMs).toISOString()}: ${d.action} (${d.reason})`);
  if (d.action !== 'dispatch' && d.action !== 'redispatch') return 0;
  if (dry) { log(`DRY RUN: would run gh ${sweep.dispatchArgs(showId).join(' ')}`); return 0; }
  const r = claimAndDispatch(showId, night, kind);
  if (r.sent) { log(`Dispatched a targeted poller run for ${showId} (fast_path, force_serp).`); return 0; }
  if (r.spent) { log(`Slot ${kind} for ${showId} ${night} was already dispatched by another runner.`); return 0; }
  log(`::warning::post-lane sweep ${kind} for ${showId} not sent (${r.reason || 'dispatch failed'})`);
  return r.reason && /in-flight|contended/.test(r.reason) ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
