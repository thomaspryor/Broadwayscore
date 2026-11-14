'use strict';
/**
 * The skip check every competing writer makes before touching a show (BRO-4786).
 * Built on lease.js activeLeaseFor; reads the local copy of the lease file that
 * scripts/opening-night-lease.js `sync` fetches from the cross-machine store.
 *
 *  - No file = no lane has ever been armed = nothing leased.
 *  - Known state: a show is blocked while someone else holds a live lease on it.
 *  - Unknown state (the marker `sync` writes after it cannot reach the store, or a file that cannot be
 *    read or parsed), BRO-6648 + BRO-6672: fail toward publishing. A show waits only when its press night is
 *    tonight AND LANE_ONLY_MARKETS was read and covers it, i.e. the lane could be the one publishing it. The
 *    variable unset (the shadow hold), empty, a typo or unread = every show writes. Tonight = now is inside
 *    lane-only-markets' press-night window [embargo - 3h, embargo + 6h] (the publish view uses the same one; the
 *    latest lane lease, started embargo + 1h with a 270-min window and 30-min TTL, ends at + 6h). The variable comes
 *    from the marker (`sync` records the read it made) or this process's env (read-lane-only-vars).
 *    Unknown never deletes: `enforce` (revertableShowIds) reverts only under a KNOWN lease held by someone else.
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

const laneOnlyMarkets = () => require('./lane-only-markets'); // lazy: lane-only-markets requires this file

function readShows(file) {
  try { const d = JSON.parse(fs.readFileSync(file || showsFile(), 'utf8')); return Array.isArray(d) ? d : d.shows || []; } catch { return null; }
}

/** Shows whose openingDate press-night window (lane-only-markets inPressNightWindow) contains `now`. */
function tonightShows(shows, now) {
  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  return (shows || []).filter((s) => s && s.id && s.openingDate && laneOnlyMarkets().inPressNightWindow(s, s.openingDate, nowMs));
}

/** Show ids whose press night is tonight. Unreadable shows.json = []. */
function tonightShowIds({ now, file } = {}) {
  return tonightShows(readShows(file), now).map((s) => s.id);
}

/**
 * The local lease view: {unknown:false, state} or {unknown:true, tonight:[ids]|null, laneOnly:{ok,value}|null}
 * (tonight null = not computed; laneOnly null = the marker carries no read, so the env decides).
 */
function readView(f) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return { unknown: false, state: { leases: {} } };
    return { unknown: true, tonight: null, laneOnly: null };
  }
  if (parsed && parsed.unknown === true) {
    const lo = parsed.laneOnly && typeof parsed.laneOnly.ok === 'boolean' ? { ok: parsed.laneOnly.ok, value: String(parsed.laneOnly.value || '') } : null;
    return { unknown: true, tonight: Array.isArray(parsed.tonight) ? parsed.tonight : null, laneOnly: lo };
  }
  try { return { unknown: false, state: lease.readState(f) }; } catch { return { unknown: true, tonight: null, laneOnly: null }; }
}

/** True when the local lease file is the marker `sync` writes after it could not reach the store. */
function readUnknownMarker(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).unknown === true; } catch { return false; }
}

/**
 * Under an unknown view: {tonight, held}. tonight = every show whose press night is now (the marker's list from
 * `sync` plus shows.json now); held = those LANE_ONLY_MARKETS covers. A tonight id missing from shows.json is not
 * held (its market cannot be matched). Memoised per shows file, minute and variable read.
 */
const unknownMemo = new Map();
function unknownHolds(view, now, env) {
  // A marker that read the variable wins; an unread one (or none) defers to this job's env, which may have read it
  // since (read-lane-only-vars), so a failed read at sync time never masks a later good one.
  const fromEnv = laneOnlyMarkets().envInputs(env).onlyMarkets;
  const laneOnly = view.laneOnly && view.laneOnly.ok ? view.laneOnly : fromEnv.ok ? fromEnv : view.laneOnly || fromEnv;
  const key = `${showsFile(env)}@${Math.floor((now === undefined ? Date.now() : new Date(now).getTime()) / 60000)}|${JSON.stringify(view.tonight)}|${JSON.stringify(laneOnly)}`;
  if (!unknownMemo.has(key)) {
    const shows = readShows(showsFile(env)) || [];
    const byId = new Map(shows.filter((s) => s && s.id).map((s) => [s.id, s]));
    const tonight = [...new Set([...(view.tonight || []), ...tonightShows(shows, now).map((s) => s.id)])];
    const held = tonight.filter((id) => laneOnlyMarkets().coversShow(laneOnly, byId.get(id)));
    unknownMemo.set(key, { tonight, held, laneOnly });
  }
  return unknownMemo.get(key);
}

let warnedUnknown = false;
function warnUnknownOnce({ tonight, held, laneOnly }) {
  if (warnedUnknown) return;
  warnedUnknown = true;
  const lo = laneOnly.ok ? `LANE_ONLY_MARKETS=${laneOnly.value || '<unset>'}` : 'LANE_ONLY_MARKETS unread';
  console.warn(`::warning::opening-night lease state unknown (store unreachable): tonight [${tonight.join(', ') || 'none'}], ${lo}; ` +
    `wait [${held.join(', ') || 'none'}], every other show writes`);
}

/**
 * The shows a writer must not touch now. {unknown, shows, tonight?}: known = shows with a live lease held by
 * someone else; unknown = tonight's shows LANE_ONLY_MARKETS covers (`tonight` = all of tonight's, for the alert).
 */
function writeBlockedShowIds({ file, now, env = process.env } = {}) {
  const view = readView(file || leasesFile(env));
  if (view.unknown) { const u = unknownHolds(view, now, env); warnUnknownOnce(u); return { unknown: true, shows: u.held, tonight: u.tonight, laneOnly: u.laneOnly }; }
  const ignoreHolder = env.OPENING_NIGHT_LANE_HOLDER || undefined;
  const shows = new Set(Object.keys(view.state.leases).map((k) => k.split('|')[0]));
  return { unknown: false, shows: [...shows].filter((s) => lease.activeLeaseFor(view.state, s, { now, ignoreHolder })) };
}

/**
 * The shows `enforce` may revert (and so delete new files under): only a KNOWN live lease held by someone else.
 * Unknown reverts nothing (BRO-6672): the writers already skipped the held shows, and on an ephemeral runner a file
 * held back uncommitted is a file deleted. Whatever a writer still wrote is committed and published.
 */
function revertableShowIds(opts = {}) {
  const b = writeBlockedShowIds(opts);
  return { ...b, revert: b.unknown ? [] : b.shows };
}

/** Lease info when `show` must not be written now (see writeBlockedShowIds), else null. */
function leaseSkipReason(show, { file, now, env = process.env } = {}) {
  const view = readView(file || leasesFile(env));
  if (view.unknown) {
    const u = unknownHolds(view, now, env);
    warnUnknownOnce(u);
    return u.held.includes(show) ? { show, night: null, holder: 'unknown', expiresAt: null, unreadable: true, unknown: true } : null;
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

/**
 * Writer entry points call this once on the show ids they are about to write (BRO-6648 S1-T1..T5).
 * Returns the ids that may be written and prints one line per held-back show to stderr. `label` names the writer.
 */
function writableShowIds(showIds, { label = 'writer', ...opts } = {}) {
  const { kept, skipped } = partitionLeased(showIds, opts);
  // stderr: callers such as watch-aggregator-urls --list-active print show ids on stdout for a workflow to read
  for (const { lease: l } of skipped) console.error(`[${label}] skip ${describe(l)}`);
  return kept;
}

/**
 * Write the unknown marker (store unreachable) with tonight's shows and the LANE_ONLY_MARKETS read (lane-only-markets
 * readOnlyMarkets: job env, else a live read with REVIEW_TEXTS_TOKEN, else unread). Returns {tonight, held}.
 */
function markUnknown({ file, now, env = process.env, laneOnly } = {}) {
  const f = file || leasesFile(env);
  const tonight = tonightShowIds({ now, file: showsFile(env) });
  const lo = laneOnly || laneOnlyMarkets().readOnlyMarkets(env);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ leases: {}, unknown: true, tonight, laneOnly: lo, at: new Date(now === undefined ? Date.now() : now).toISOString() }) + '\n');
  fs.renameSync(tmp, f);
  return { tonight, held: unknownHolds({ tonight, laneOnly: lo }, now, env).held };
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

const describe = (l) => `${l.show} leased to ${l.holder}${l.expiresAt ? ` until ${l.expiresAt}` : ''}${l.unknown ? ' (lease store unknown, its press night is tonight and LANE_ONLY_MARKETS covers it, so it waits)' : ''}`;

module.exports = {
  readUnknownMarker, tonightShows, revertableShowIds, DEFAULT_LEASES_FILE, DEFAULT_SHOWS_FILE, leasesFile, showsFile, tonightShowIds, readView,
  writeBlockedShowIds, leaseSkipReason, partitionLeased, writableShowIds, markUnknown, leasedShowIds, revertLeasedChanges, describe,
};
