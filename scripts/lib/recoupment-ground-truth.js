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

/** Groups with at least minN rows whose mean error rose or in-range count fell. */
function worseGroups(summary, { minN = 1 } = {}) {
  return Object.entries(summary)
    .filter(([, s]) => s.n >= Math.max(1, minN) && (s.newMae > s.oldMae || s.newInside < s.oldInside))
    .map(([name]) => name);
}

const fmtTruth = (truth) => truth.map((v) => (Number.isFinite(v) ? v : (v > 0 ? '+inf' : '-inf'))).join('..');
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * GitHub-markdown before/after report (CI step summary).
 * @param {{ title: string, summary: object, rows: object[], worse: string[], limit?: number }} r
 * @returns {string}
 */
function formatMarkdown({ title, summary, rows, worse, limit = 15 }) {
  const out = [`### ${title}`, '', '| group | n | old MAE | new MAE | old median | new median | old inside | new inside |', '|---|--:|--:|--:|--:|--:|--:|--:|'];
  for (const [g, s] of Object.entries(summary)) out.push(`| ${g} | ${s.n} | ${s.oldMae} | ${s.newMae} | ${s.oldMedian} | ${s.newMedian} | ${s.oldInside} | ${s.newInside} |`);
  const moved = rows.filter((r) => r.oldErr !== r.newErr).sort((a, b) => Math.abs(b.newErr - b.oldErr) - Math.abs(a.newErr - a.oldErr));
  out.push('');
  if (!moved.length) out.push('No row moved.');
  else {
    out.push(`Error changed on ${moved.length}${moved.length > limit ? ` (top ${limit})` : ''}:`, '', '| show | kind | truth | old % | new % | old error | new error |', '|---|---|---|--:|--:|--:|--:|');
    for (const r of moved.slice(0, limit)) out.push(`| ${r.slug} | ${r.kind} | ${fmtTruth(r.truth)} | ${r.oldPct} | ${r.newPct} | ${r1(r.oldErr)} | ${r1(r.newErr)} |`);
  }
  out.push('', worse.length ? `**Worse in:** ${worse.join(', ')}` : 'No group got worse.', '');
  return out.join('\n');
}

module.exports = { groundTruth, rangeError, category, summarize, worseGroups, formatMarkdown, fmtTruth, OWN_INFERENCE };
