// BRO-5935: a plan in data/pending-fixes/ that stays status=pending was never
// applied (dispatch never ran or failed) and nothing reported it. Pure so
// cloud-doctor and the test share one definition of "stale".
'use strict';
const fs = require('fs');
const path = require('path');

const STALE_PENDING_DAYS = 7;

/** Pure: plan objects -> [{ id, ageDays }] for pending plans older than maxDays, oldest first. */
function stalePlans(plans, { now = Date.now(), maxDays = STALE_PENDING_DAYS } = {}) {
  const out = [];
  for (const p of plans) {
    if (!p || p.status !== 'pending') continue;
    const created = Date.parse(p.createdAt);
    // No usable date means the age is unknown, so it cannot be called stale
    // (plans filed without createdAt, e.g. bro-4623-*, were flagged on day one).
    if (Number.isNaN(created)) continue;
    const ageDays = (now - created) / 864e5;
    if (ageDays > maxDays) out.push({ id: String(p.file || p.planId || p.issueNumber || '?'), ageDays });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
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
  const list = stale.slice(0, 6).map((s) => `${s.id} (${Math.floor(s.ageDays) + 'd'})`).join(', ');
  return `${stale.length} pending fix plan(s) older than ${STALE_PENDING_DAYS} days, never applied: ${list}${stale.length > 6 ? ', ...' : ''}`;
}

module.exports = { STALE_PENDING_DAYS, stalePlans, readPlans, describeStale };
