'use strict';
/**
 * The skip check every competing writer makes before touching a show (BRO-4786).
 * Built on lease.js activeLeaseFor; reads the local copy of the lease file that
 * scripts/opening-night-lease.js `sync` fetches from the cross-machine store.
 *
 *  - No file = no lane has ever been armed = nothing leased.
 *  - A file that exists but cannot be read or parsed = LEASED (unknown): a writer that cannot
 *    tell must wait, not write (lease.isShowLeased).
 *  - OPENING_NIGHT_LANE_HOLDER lets the lane's own writes through.
 */
const fs = require('fs');
const path = require('path');
const lease = require('./lease');

const DEFAULT_LEASES_FILE = path.join(__dirname, '../../../data/opening-night/leases.json');
const leasesFile = (env = process.env) => env.OPENING_NIGHT_LEASES_FILE || DEFAULT_LEASES_FILE;

/** Lease info when `show` is leased to someone other than this process, else null. */
function leaseSkipReason(show, { file, now, env = process.env } = {}) {
  const f = file || leasesFile(env);
  // `sync` could not read the shared store after retries: per-show callers cannot tell, so they wait.
  if (readUnknownMarker(f)) return { show, night: null, holder: 'unknown', expiresAt: null, unreadable: true };
  const ignoreHolder = env.OPENING_NIGHT_LANE_HOLDER || undefined;
  return lease.isShowLeased(f, show, { now, ignoreHolder });
}

/** True when the local lease file is the marker `sync` writes after it could not reach the store. */
function readUnknownMarker(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).unknown === true; } catch { return false; }
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

/** Every show id with a live lease (all nights). Unreadable file throws. */
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
 * push-review-texts refusal: undo every uncommitted change under a leased show's directory in
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

const describe = (l) => `${l.show} leased to ${l.holder}${l.expiresAt ? ` until ${l.expiresAt}` : ''}${l.unreadable ? ' (lease file unreadable, treating as leased)' : ''}`;

module.exports = { readUnknownMarker, DEFAULT_LEASES_FILE, leasesFile, leaseSkipReason, partitionLeased, leasedShowIds, revertLeasedChanges, describe };
