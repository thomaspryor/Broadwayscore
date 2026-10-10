'use strict';

// Ground truth for the recoupment model (BRO-5002, BRO-4989). Every model
// change is scored against what was reported independently of the model:
//
//   reported-pct  estimatedRecoupmentPct [lo, hi] whose source is a report
//                 (trade press, filings, deep research, a grosses post), not
//                 our own inference ("Inferred:", "Estimated:")
//   recouped      recouped === true with a recoupedSource: truth is >= 100
//   failed        closed, recouped === false, designated Fizzle or Flop:
//                 truth is < 100 (the Fizzle/Flop split is not used; it can
//                 lean on older model output)
//
// A model central inside the truth range scores 0; outside, the distance to
// the nearest edge in points. Pure functions; the CLI is
// scripts/backtest-recoupment-ground-truth.js.

const OWN_INFERENCE = /^\s*(inferred|estimated)\b/i;

/**
 * @returns {null | { kind: 'reported-pct'|'recouped'|'failed', lo: number, hi: number, source: string, asOf?: string }}
 */
function groundTruth(comm, show, now = new Date()) {
  if (!comm) return null;
  const est = comm.estimatedRecoupmentPct;
  // Older records keep the range's basis in notes, not estimatedRecoupmentSource.
  const basis = comm.estimatedRecoupmentSource || comm.notes;
  if (Array.isArray(est) && est.length === 2 && est.every((v) => typeof v === 'number')
    && basis && !OWN_INFERENCE.test(basis)) {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(comm.estimatedRecoupmentDate || '') ? comm.estimatedRecoupmentDate : null;
    return { kind: 'reported-pct', lo: Math.min(...est), hi: Math.max(...est), source: String(basis), ...(asOf ? { asOf } : {}) };
  }
  if (comm.recouped === true && comm.recoupedSource) {
    return { kind: 'recouped', lo: 100, hi: Infinity, source: String(comm.recoupedSource) };
  }
  const closed = show && show.closingDate && new Date(show.closingDate) <= now;
  if (closed && comm.recouped === false && (comm.designation === 'Fizzle' || comm.designation === 'Flop')) {
    return { kind: 'failed', lo: -Infinity, hi: 99.99, source: `designation ${comm.designation}` };
  }
  return null;
}

/** Points outside the truth range; 0 when inside. */
function rangeError(pct, truth) {
  if (typeof pct !== 'number' || !truth) return null;
  if (pct < truth.lo) return truth.lo - pct;
  if (pct > truth.hi) return pct - truth.hi;
  return 0;
}

function category(show) {
  const type = show && show.type === 'play' ? 'play' : 'musical';
  const year = show && show.openingDate ? Number(String(show.openingDate).slice(0, 4)) : null;
  return { type, era: year != null && year < 2020 ? 'pre-2020' : '2020+' };
}

/**
 * @param {Array<{ kind: string, type: string, era: string, oldErr: number, newErr: number }>} rows
 * @returns per-group { n, oldMae, newMae, oldInside, newInside } for all, each kind, type and era
 */
function summarize(rows) {
  const groups = { all: rows };
  for (const r of rows) {
    for (const g of [`kind:${r.kind}`, `type:${r.type}`, `era:${r.era}`]) (groups[g] = groups[g] || []).push(r);
  }
  const round = (v) => Math.round(v * 10) / 10;
  const out = {};
  for (const [name, rs] of Object.entries(groups)) {
    const mae = (k) => (rs.length ? round(rs.reduce((a, r) => a + r[k], 0) / rs.length) : null);
    const median = (k) => {
      const v = rs.map((r) => r[k]).sort((a, b) => a - b);
      return v.length ? round(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
    };
    out[name] = {
      n: rs.length,
      oldMae: mae('oldErr'), newMae: mae('newErr'),
      oldMedian: median('oldErr'), newMedian: median('newErr'),
      oldInside: rs.filter((r) => r.oldErr === 0).length,
      newInside: rs.filter((r) => r.newErr === 0).length,
    };
  }
  return out;
}

/** Groups where the change is less accurate (higher error or fewer inside). */
function worseGroups(summary) {
  return Object.entries(summary)
    .filter(([, s]) => s.n > 0 && (s.newMae > s.oldMae || s.newInside < s.oldInside))
    .map(([name]) => name);
}

module.exports = { groundTruth, rangeError, category, summarize, worseGroups, OWN_INFERENCE };
