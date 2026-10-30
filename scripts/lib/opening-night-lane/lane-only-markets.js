'use strict';
/**
 * LANE_ONLY_MARKETS (BRO-6620, cutover card 6): for the markets it lists, the opening-night lane alone publishes
 * press night. The old path's press-night roles stand down for those shows: the Express retry dispatch
 * (scripts/express-retry-queue.js dispatch-due) and the poller's rebuild + deploy (opening-night-poller.yml
 * `lane_only` step). Manual Express runs, the 08:00 UTC day-after Express fire and day-after sweeps are untouched.
 *
 * Fail toward publishing. lease-guard.js answers "may I WRITE this show?" and treats an unknown lease as leased
 * (wait). This module answers "may the old path PUBLISH?" and treats every unknown as yes. The old path stands down
 * only on positive evidence that a lane holds the night right now:
 *   1. LANE_ONLY_MARKETS was read (read-actions-variable.sh exit 0; a failed read keeps the old path on);
 *   2. it names the show's market or category, matched like LANE_STANDDOWN ("broadway" covers Off-Broadway, whose
 *      market is broadway; "off-broadway" covers only that category). Unlike LANE_STANDDOWN a typo or "all" matches
 *      nothing, so a typo leaves the old path on;
 *   3. the synced lease state is known and holds a live lease for the show;
 *   4. now is inside that night's press-night window, [embargo - 3h, embargo + 6h];
 *   5. the lease holder has not left a stood-down marker (lane exit 3, written by opening-night-lane-live.yml).
 *      A marker from a different holder is ignored: the second of two armed starters exits 3 with held-by-other
 *      while the first is still publishing, and that must not bring the old path back mid-night;
 *   6. LANE_STANDDOWN was read and does not cover the show.
 * When the lane releases its lease (every exit path does) or the lease expires (30 min after a crash), rule 3
 * brings the old path back on its next tick. Emptying the variable does the same. A lane that is alive but not
 * publishing keeps the old path off until its step ends; the auto fallback for that is BRO-6621.
 */
const fs = require('fs');
const path = require('path');
const { parseStanddown, tokensMatchShow, standsDown } = require('./standdown');
const { defaultEmbargoAt, marketEmbargoAt } = require('../press-night-record');

const VARIABLE = 'LANE_ONLY_MARKETS';
const WINDOW_BEFORE_MIN = 180;
const WINDOW_AFTER_MIN = 360;
const MIN = 60 * 1000;
const DEFAULT_MARKERS_DIR = path.join(__dirname, '../../../data/opening-night/lane-stood-down');

/** {tokens, unknown}. Pure. */
function parseOnlyMarkets(value) {
  const p = parseStanddown(value, { unknown: 'ignore' });
  return { tokens: p.tokens, unknown: p.unknown };
}

/** The live lease on `show` (any night) with its raw fields, or null. Pure. */
function liveLeaseFor(leaseState, show, nowMs) {
  for (const [key, l] of Object.entries((leaseState && leaseState.leases) || {})) {
    const [leaseShow, night] = key.split('|');
    if (leaseShow !== show || !l) continue;
    if (!(Date.parse(l.expiresAt) > nowMs)) continue;
    return { night, holder: l.holder, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt };
  }
  return null;
}

/** ISO embargo for `night`: the show's own (override included) on its opening night, else the market hour. */
function embargoForNight(show, night) {
  try {
    if (show.openingDate === night) return defaultEmbargoAt(show);
    return marketEmbargoAt({ ...show, openingDate: night });
  } catch { return null; }
}

function inPressNightWindow(show, night, nowMs) {
  const at = Date.parse(embargoForNight(show, night) || '');
  if (!Number.isFinite(at)) return false;
  return nowMs >= at - WINDOW_BEFORE_MIN * MIN && nowMs <= at + WINDOW_AFTER_MIN * MIN;
}

const markerKey = (show, night) => `${show}__${night}`;

/**
 * Decide for one show. Pure.
 * @param {{onlyMarkets:{ok:boolean,value?:string}, standdown:{ok:boolean,value?:string}, show:object,
 *          leaseState:object|null, markers:Object<string,{holder:string}>|null, now?:Date|number|string}} input
 *   leaseState null or `{unknown:true}` = unknown. markers null = unreadable.
 * @returns {{standDown:boolean, reason:string, night?:string, holder?:string}}
 */
function oldPathStandsDown({ onlyMarkets, standdown, show, leaseState, markers, now }) {
  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  const on = (reason) => ({ standDown: false, reason });
  if (!onlyMarkets || !onlyMarkets.ok) return on('LANE_ONLY_MARKETS unreadable');
  if (!show || !show.id) return on('show unknown');
  if (!tokensMatchShow(parseOnlyMarkets(onlyMarkets.value).tokens, show)) return on('market not lane-only');
  if (!leaseState || leaseState.unknown) return on('lease state unknown');
  const l = liveLeaseFor(leaseState, show.id, nowMs);
  if (!l) return on('no live lane lease');
  if (!inPressNightWindow(show, l.night, nowMs)) return on(`outside the ${l.night} press-night window`);
  if (markers === null || markers === undefined) return on('stood-down markers unreadable');
  const m = markers[markerKey(show.id, l.night)];
  if (m && m.holder === l.holder) return on(`lane ${l.holder} stood down (exit 3)`);
  if (!standdown || !standdown.ok) return on('LANE_STANDDOWN unreadable');
  if (standsDown(standdown.value, show)) return on('LANE_STANDDOWN covers the show');
  return { standDown: true, reason: `lane ${l.holder} holds ${show.id} ${l.night}`, night: l.night, holder: l.holder };
}

/** Read every marker file. Missing dir = {} (no markers); any unreadable file = null (treated as "lane stood down"). */
function readMarkers(dir = DEFAULT_MARKERS_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e && e.code === 'ENOENT' ? {} : null; }
  const out = {};
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try { out[n.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; }
  }
  return out;
}

/** Write the lane's exit-3 marker. Returns the file path. */
function writeMarker({ show, night, holder, runId, at, dir = DEFAULT_MARKERS_DIR }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(show || ''))) throw new Error(`marker: bad show id "${show}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(night || ''))) throw new Error(`marker: bad night "${night}"`);
  if (!holder) throw new Error('marker: holder is required');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${markerKey(show, night)}.json`);
  fs.writeFileSync(file, JSON.stringify({ show, night, holder, exit: 3, runId: runId || null, at: at || new Date().toISOString() }, null, 2) + '\n');
  return file;
}

/** Lease state from the synced file: null when missing-but-unreadable, {unknown:true} marker passes through. */
function readLeaseState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e && e.code === 'ENOENT' ? { leases: {} } : null; }
}

/**
 * Poller gate: suppress the run's rebuild + deploy only when there is at least one action show and every one of
 * them stands down. A mixed run proceeds (it republishes the lane's show too; that is the publishing side).
 */
function pollerSuppress(showIds, decide) {
  const ids = [...new Set((showIds || []).filter(Boolean))];
  if (!ids.length) return { suppress: false, decisions: [] };
  const decisions = ids.map((id) => ({ id, ...decide(id) }));
  return { suppress: decisions.every((d) => d.standDown), decisions };
}

/**
 * Variable inputs from the environment a workflow step sets after read-actions-variable.sh:
 * LANE_ONLY_MARKETS + LANE_ONLY_MARKETS_READ=ok, LANE_STANDDOWN + LANE_STANDDOWN_READ=ok. Anything but "ok" = unread.
 */
function envInputs(env = process.env) {
  return {
    onlyMarkets: { ok: env.LANE_ONLY_MARKETS_READ === 'ok', value: env.LANE_ONLY_MARKETS || '' },
    standdown: { ok: env.LANE_STANDDOWN_READ === 'ok', value: env.LANE_STANDDOWN || '' },
  };
}

/** A per-show-id decider over the synced lease file and the marker dir, read once. `findShow(id)` -> show|null. */
function createDecider({ findShow, env = process.env, leasesFile, markersDir, now } = {}) {
  const inputs = envInputs(env);
  const leaseState = readLeaseState(leasesFile || require('./lease-guard').leasesFile(env));
  const markers = readMarkers(markersDir);
  const unknown = inputs.onlyMarkets.ok ? parseOnlyMarkets(inputs.onlyMarkets.value).unknown : [];
  return {
    unknownTokens: unknown,
    decide: (id) => oldPathStandsDown({ ...inputs, show: findShow(id), leaseState, markers, now }),
  };
}

module.exports = {
  envInputs, createDecider,
  VARIABLE, WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN, DEFAULT_MARKERS_DIR,
  parseOnlyMarkets, liveLeaseFor, embargoForNight, inPressNightWindow, markerKey,
  oldPathStandsDown, readMarkers, writeMarker, readLeaseState, pollerSuppress,
};
