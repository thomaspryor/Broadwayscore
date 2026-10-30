'use strict';
/**
 * The skip check every competing writer makes before touching a show (BRO-4786).
 * Built on lease.js activeLeaseFor; reads the local copy of the lease file that
 * scripts/opening-night-lease.js `sync` fetches from the cross-machine store.
 *
 *  - No file = no lane has ever been armed = nothing leased.
 *  - Known state: a show is blocked while someone else holds a live lease on it.
 *  - Unknown state (the marker `sync` writes after it cannot reach the store, or a file that cannot be
 *    read or parsed), BRO-6648: only TONIGHT's shows wait (press night window, the same window
 *    lane-only-markets uses); every other show writes. The marker carries the `tonight` list `sync`
 *    computed; an unparsable file computes it from shows.json here. Unreadable shows.json = nothing tonight.
 *  - OPENING_NIGHT_LANE_HOLDER lets the lane's own writes through.
 *
 * Writers ask writeBlockedShowIds / leaseSkipReason / partitionLeased (one policy). leasedShowIds is the
 * PUBLISH view (rebuild, census): unknown names no show, so the old path publishes, matching
 * lane-only-markets oldPathStandsDown.
 */
const fs = require('fs');
const path = require('path');
const lease = require('./lease');

const DEFAULT_LEASES_FILE = path.join(__dirname, '../../../data/opening-night/leases.json');
const DEFAULT_SHOWS_FILE = path.join(__dirname, '../../../data/shows.json');
const leasesFile = (env = process.env) => env.OPENING_NIGHT_LEASES_FILE || DEFAULT_LEASES_FILE;
const showsFile = (env = process.env) => env.OPENING_NIGHT_SHOWS_FILE || DEFAULT_SHOWS_FILE;

/** Show ids whose press night (openingDate) window contains `now`. Unreadable shows.json = []. */
function tonightShowIds({ now, file } = {}) {
  let shows;
  try { const d = JSON.parse(fs.readFileSync(file || showsFile(), 'utf8')); shows = Array.isArray(d) ? d : d.shows || []; } catch { return []; }
  const { inPressNightWindow } = require('./lane-only-markets'); // lazy: lane-only-markets requires this file
  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  return shows.filter((s) => s && s.id && s.openingDate && inPressNightWindow(s, s.openingDate, nowMs)).map((s) => s.id);
}

/** The local lease view: {unknown:false, state} or {unknown:true, tonight:[ids]|null} (null = not computed). */
function readView(f) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return { unknown: false, state: { leases: {} } };
    return { unknown: true, tonight: null };
  }
  if (parsed && parsed.unknown === true) return { unknown: true, tonight: Array.isArray(parsed.tonight) ? parsed.tonight : null };
  try { return { unknown: false, state: lease.readState(f) }; } catch { return { unknown: true, tonight: null }; }
}

/** True when the local lease file is the marker `sync` writes after it could not reach the store. */
function readUnknownMarker(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).unknown === true; } catch { return false; }
}

const tonightMemo = new Map();
function tonightFor(view, now, env) {
  if (view.tonight) return view.tonight;
  const key = `${showsFile(env)}@${Math.floor((now === undefined ? Date.now() : new Date(now).getTime()) / 60000)}`;
  if (!tonightMemo.has(key)) tonightMemo.set(key, tonightShowIds({ now, file: showsFile(env) }));
  return tonightMemo.get(key);
}

let warnedUnknown = false;
function warnUnknownOnce(tonight) {
  if (warnedUnknown) return;
  warnedUnknown = true;
  console.warn(`::warning::opening-night lease state unknown (store unreachable): tonight's show(s) wait [${tonight.join(', ') || 'none'}], every other show writes`);
}

/**
 * The shows a writer must not touch now. {unknown, shows}: known = shows with a live lease held by
 * someone else; unknown = tonight's shows.
 */
function writeBlockedShowIds({ file, now, env = process.env } = {}) {
  const view = readView(file || leasesFile(env));
  if (view.unknown) { const tonight = tonightFor(view, now, env); warnUnknownOnce(tonight); return { unknown: true, shows: tonight }; }
  const ignoreHolder = env.OPENING_NIGHT_LANE_HOLDER || undefined;
  const shows = new Set(Object.keys(view.state.leases).map((k) => k.split('|')[0]));
  return { unknown: false, shows: [...shows].filter((s) => lease.activeLeaseFor(view.state, s, { now, ignoreHolder })) };
}

/** Lease info when `show` must not be written now (see writeBlockedShowIds), else null. */
function leaseSkipReason(show, { file, now, env = process.env } = {}) {
  const view = readView(file || leasesFile(env));
  if (view.unknown) {
    const tonight = tonightFor(view, now, env);
    warnUnknownOnce(tonight);
    return tonight.includes(show) ? { show, night: null, holder: 'unknown', expiresAt: null, unreadable: true, unknown: true } : null;
  }
  return lease.activeLeaseFor(view.state, show, { now, ignoreHolder: env.OPENING_NIGHT_LANE_HOLDER || undefined });
}

/** Split show ids into {kept, skipped:[{show, lease}]}. */
function partitionLeased(showIds, opts = {}) {
  const kept = [];
  const skipped = [];
  for (const show of showIds) {
    const l = leaseSkipReason(show, opts);
    if (l) skipped.push({ show, lease: l }); else kept.push(show);
  }
  return { kept, skipped };
}

/** PUBLISH view: every show id with a live lease (all nights). Unknown names none (old path publishes). Unreadable file throws. */
function leasedShowIds({ file, now, env = process.env } = {}) {
  const f = file || leasesFile(env);
  if (!fs.existsSync(f)) return [];
  if (readUnknownMarker(f)) { console.warn('::warning::opening-night lease state unknown (sync failed); cannot name leased shows'); return []; }
  const state = lease.readState(f);
  const ignoreHolder = env.OPENING_NIGHT_LANE_HOLDER || undefined;
  const shows = new Set(Object.keys(state.leases).map((k) => k.split('|')[0]));
  return [...shows].filter((s) => lease.activeLeaseFor(state, s, { now, ignoreHolder }));
}

/**
 * push-review-texts refusal: undo every uncommitted change under a blocked show's directory in
 * the review-texts checkout `repoDir` (tracked edits restored from HEAD, new files deleted),
 * so the commit that follows cannot carry them. Returns the reverted paths.
 */
function revertLeasedChanges(repoDir, shows) {
  const { execFileSync } = require('child_process');
  const leased = new Set(shows);
  if (!leased.size) return [];
  const run = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const reverted = [];
  const inHead = (f) => { try { run(['cat-file', '-e', `HEAD:${f}`]); return true; } catch { return false; } };
  const isLeased = (f) => { const seg = f.split('/'); return leased.has(seg[0] === '_pending' ? seg[1] : seg[0]); }; // _pending/<show>/ mirrors a show dir
  const undo = (f) => {
    if (inHead(f)) { run(['reset', '--quiet', 'HEAD', '--', f]); run(['checkout', '--', f]); } // tracked: restore from HEAD
    else { run(['rm', '--quiet', '--cached', '-f', '--ignore-unmatch', '--', f]); fs.rmSync(path.join(repoDir, f), { force: true }); } // new (untracked or staged add): remove
    reverted.push(f);
  };
  const entries = run(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    const source = (status[0] === 'R' || status[0] === 'C') ? entries[++i] : null; // rename/copy: next token is the old path
    if (isLeased(file)) undo(file);
    if (source && isLeased(source)) undo(source);
  }
  return reverted;
}

const describe = (l) => `${l.show} leased to ${l.holder}${l.expiresAt ? ` until ${l.expiresAt}` : ''}${l.unknown ? ' (lease store unknown and its press night is tonight, so it waits)' : ''}`;

module.exports = {
  readUnknownMarker, DEFAULT_LEASES_FILE, DEFAULT_SHOWS_FILE, leasesFile, showsFile, tonightShowIds, readView,
  writeBlockedShowIds, leaseSkipReason, partitionLeased, leasedShowIds, revertLeasedChanges, describe,
};
