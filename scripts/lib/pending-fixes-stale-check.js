// BRO-5935: plans left pending, partial, or validation-failed need follow-up.
// A partial apply is still unresolved even though the executor will not retry it. Pure so
// cloud-doctor and the test share one definition of "stale".
// BRO-7092: a plan triaged against current data (scripts/triage-fix-plans.js
// writes `triage`) counts only while its triage still finds needed work, and
// carries that reason. A plan triaged as resolved/obsolete is withdrawn as
// "superseded" by the same script; an untriaged one counts with that reason.
'use strict';
const fs = require('fs');
const path = require('path');

const STALE_PENDING_DAYS = 7;
const UNRESOLVED_STATUSES = new Set(['pending', 'partial', 'validation-failed']);

/** Pure: plan objects -> [{ id, ageDays }] for unresolved plans older than maxDays, oldest first. */
function stalePlans(plans, { now = Date.now(), maxDays = STALE_PENDING_DAYS } = {}) {
  const out = [];
  for (const p of plans) {
    if (!p || !UNRESOLVED_STATUSES.has(p.status)) continue;
    const created = Date.parse(p.createdAt);
    // No usable date means the age is unknown, so it cannot be called stale
    // (plans filed without createdAt, e.g. bro-4623-*, were flagged on day one).
    if (Number.isNaN(created)) continue;
    const ageDays = (now - created) / 864e5;
    if (!(ageDays > maxDays)) continue;
    const reason = stillNeededReason(p);
    if (reason === null) continue;
    out.push({ id: String(p.file || p.planId || p.issueNumber || '?'), ageDays, reason });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Why an unresolved plan still needs work, or null when its triage found none.
 * A triage older than the plan's last run no longer describes it.
 */
function stillNeededReason(p) {
  const t = p.triage;
  const ranAfter = t && p.executedAt && Date.parse(p.executedAt) > Date.parse(t.at);
  if (!t || typeof t !== 'object' || ranAfter || Number.isNaN(Date.parse(t.at))) return 'not triaged against current data (node scripts/triage-fix-plans.js)';
  if (t.verdict !== 'still-needed') return null;
  return typeof t.stillNeededReason === 'string' && t.stillNeededReason.trim() ? t.stillNeededReason : 'triage found still-needed ops (see triage.ops)';
}

/** Reads every *.json in dir; unreadable files are skipped. */
function readPlans(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const plans = [];
  for (const n of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (p && typeof p === 'object') p.file = n.replace(/\.json$/, ''); // file name is the id people recognise; planId is often a uuid
      plans.push(p);
    } catch { /* skip */ }
  }
  return plans;
}

/** One-line WARN text, or null when nothing is stale. */
function describeStale(stale) {
  if (!stale.length) return null;
  const short = (r) => (r && r.length > 90 ? `${r.slice(0, 87)}...` : r);
  const list = stale.slice(0, 6).map((s) => `${s.id} (${Math.floor(s.ageDays) + 'd'}${s.reason ? `: ${short(s.reason)}` : ''})`).join(', ');
  return `${stale.length} unresolved fix plan(s) older than ${STALE_PENDING_DAYS} days with work still needed (pending, partial, or validation-failed): ${list}${stale.length > 6 ? ', ...' : ''}`;
}

module.exports = { STALE_PENDING_DAYS, stalePlans, stillNeededReason, readPlans, describeStale };
