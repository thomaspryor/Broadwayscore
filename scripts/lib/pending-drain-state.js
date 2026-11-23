'use strict';
/**
 * Persistent state for the _pending intake drain (BRO-7930): the rotation cursor plus a short
 * run history that drives the two alerts (promoted 0 for N runs; _pending growing).
 *
 * Lives at the review-texts repo ROOT (.pending-drain-state.json): that repo is already pushed
 * by enrich-reviews (push-review-texts does git add -A), so no workflow change is needed, and it
 * is outside _pending/ so nothing that walks _pending counts it as a stub.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = '.pending-drain-state.json';
const MAX_HISTORY = 30;
const ZERO_PROMOTE_RUNS = 4;       // consecutive sweep runs that resolved nothing
const GROWTH_RUNS = 4;             // pending count rising across this many consecutive runs
const GROWTH_MIN_ABS = 50;         // ...by at least this many files in total

function statePath(root) { return path.join(root, STATE_FILE); }

function loadState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    const c = s.cursors && typeof s.cursors === 'object' ? s.cursors : {};
    return {
      cursors: Object.fromEntries(['recent', 'other', 'open_recent', 'open_other'].map(k => [k, typeof c[k] === 'string' ? c[k] : null])),
      turn: Number.isInteger(s.turn) ? s.turn : 0,
      history: Array.isArray(s.history) ? s.history : [],
    };
  } catch { return { cursors: { recent: null, other: null }, turn: 0, history: [] }; }
}

function saveState(root, state) {
  const out = { cursors: state.cursors || { recent: null, other: null }, turn: state.turn || 0, history: (state.history || []).slice(-MAX_HISTORY) };
  fs.writeFileSync(statePath(root), JSON.stringify(out, null, 2) + '\n');
}

/**
 * Pure. `history` rows: {at, scope, promoted, dropped, rejected, tagged, inspected, pending}.
 * "Resolved" = anything that leaves _pending: promoted, dropped as redundant, rejected, or
 * tagged-as-junk. A run that inspected files and resolved none is a zero run.
 * @returns {{zeroPromote: boolean, growth: boolean, zeroRuns: number, delta: number}}
 */
function evaluateDrainHealth(history) {
  const rows = (history || []).filter(r => r && r.scope !== 'dry');
  let zeroRuns = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if ((r.inspected || 0) > 0 && (r.promoted || 0) + (r.dropped || 0) + (r.rejected || 0) + (r.tagged || 0) === 0) zeroRuns++;
    else break;
  }
  const tail = rows.slice(-GROWTH_RUNS);
  let growth = false, delta = 0;
  if (tail.length === GROWTH_RUNS && tail.every(r => Number.isFinite(r.pending))) {
    delta = tail[tail.length - 1].pending - tail[0].pending;
    growth = delta >= GROWTH_MIN_ABS && tail.every((r, i) => i === 0 || r.pending >= tail[i - 1].pending);
  }
  return { zeroPromote: zeroRuns >= ZERO_PROMOTE_RUNS, growth, zeroRuns, delta };
}

/**
 * BRO-8089: open (unsettled) _pending stubs per era, counted at each sweep. A stub the drain tagged
 * (promoteSkippedReason / rssIdentityRejected) is settled; everything else still needs a decision.
 * @returns {{'2025-26':number,'2015-24':number,'pre-2015':number}}
 */
function countOpenByEra(pendingRoot) {
  const { isSettledPendingStub, showEra } = require('./pending-triage');
  const out = { '2025-26': 0, '2015-24': 0, 'pre-2015': 0 };
  let dirs = [];
  try { dirs = fs.readdirSync(pendingRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(pendingRoot, d.name)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(pendingRoot, d.name, f), 'utf8')); } catch { data = null; }
      if (data && isSettledPendingStub(data)) continue;
      out[showEra(d.name)]++;
    }
  }
  return out;
}

const OPEN_GROWTH_MIN_DAYS = 6;   // compare against the newest row at least this old (sweeps run weekly)
const OPEN_GROWTH_MIN_ABS = 25;   // ignore noise: an era must grow by at least this many open stubs

/**
 * Pure. Era whose open-stub count rose week over week. `history` rows carry `openByEra` (see countOpenByEra);
 * the latest row is compared with the newest row at least OPEN_GROWTH_MIN_DAYS older.
 * @returns {{firing:boolean, eras:Array<{era:string,from:number,to:number,delta:number}>}}
 */
function evaluateOpenGrowth(history) {
  const rows = (history || []).filter((r) => r && r.scope !== 'dry' && r.openByEra && Number.isFinite(Date.parse(r.at)));
  if (rows.length < 2) return { firing: false, eras: [] };
  const last = rows[rows.length - 1];
  const base = [...rows].reverse().find((r) => Date.parse(last.at) - Date.parse(r.at) >= OPEN_GROWTH_MIN_DAYS * 864e5);
  if (!base) return { firing: false, eras: [] };
  const eras = [];
  for (const era of Object.keys(last.openByEra)) {
    const from = base.openByEra[era] || 0, to = last.openByEra[era] || 0;
    if (to - from >= OPEN_GROWTH_MIN_ABS) eras.push({ era, from, to, delta: to - from });
  }
  return { firing: eras.length > 0, eras };
}

module.exports = { countOpenByEra, evaluateOpenGrowth, OPEN_GROWTH_MIN_ABS, OPEN_GROWTH_MIN_DAYS, STATE_FILE, loadState, saveState, evaluateDrainHealth, ZERO_PROMOTE_RUNS, GROWTH_RUNS, GROWTH_MIN_ABS };
