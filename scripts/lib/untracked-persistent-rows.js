'use strict';
// BRO-5168: tripwire for "a visitor-facing daily health row has been red for
// days and nothing is working on it". Until 2026-10-12 the only signals for a
// stalled fix loop read Mac-local ledgers, so CI could not see that the Mac's
// digest-autofix had stopped filing cards. This reads only what CI has: the
// tracked alert ledger (data/audit/alert-ledger.json) for how long each
// `health-check:<row>` incident has been open, and Linear's open issues for
// whether anything tracks it. The ledger's own linearIdentifier is not
// trusted on its own: it outlives the card (a closed July card still sat on
// "Quality: corpus drift" in October).
//
// Advisory: the row this feeds is warn-only (CLAUDE.md rule 19).

const { startNowHealthRowReason } = require('./start-now-filing.js');
const { currentIncidentOpenedAt, trackerIsClosed } = require('./owner-alert-router.js');
const { healthRowNameFromConditionKey } = require('./health-row-check-cmd.js');

const PERSISTENT_AFTER_HOURS = 96;
// The health check runs daily; a row seen within this window is still red.
const STILL_FAILING_WITHIN_HOURS = 30;
const OPEN_TITLE_RE = /^(?:Fix: )?BSC Daily: (.+)$/;

/** Does this open issue track the given health row? */
function issueTracksRow(issue, { name, conditionKey, linearIdentifier }) {
  if (!issue) return false;
  if (linearIdentifier && issue.identifier === linearIdentifier) return true;
  if (issue.description && String(issue.description).includes(conditionKey)) return true;
  const m = OPEN_TITLE_RE.exec(String(issue.title || '').trim());
  if (!m) return false;
  // digest-autofix folds "<condition> on <show>" rows into one
  // "BSC Daily: <condition>" card, and may add " (batch N)".
  const subject = m[1].replace(/ \(batch \d+\)$/, '').toLowerCase();
  const row = name.toLowerCase();
  return row === subject || row.startsWith(`${subject} on `);
}

/**
 * PURE. Visitor-facing health rows open past PERSISTENT_AFTER_HOURS, still
 * seen recently, that no open Linear issue tracks.
 * @param {{conditions?: object}} ledger alert-ledger.json content
 * @param {Array<{identifier:string,title:string,description?:string}>} openIssues
 * @param {number} nowMs
 * @returns {Array<{name:string, conditionKey:string, openHours:number, staleIdentifier:string|null}>}
 */
function findUntrackedPersistentRows(ledger, openIssues, nowMs) {
  const out = [];
  const conditions = (ledger && ledger.conditions) || {};
  for (const [conditionKey, cond] of Object.entries(conditions)) {
    const name = healthRowNameFromConditionKey(conditionKey);
    if (!name || !cond || cond.status !== 'open') continue;
    const lastSeenMs = Date.parse(cond.lastSeen || '');
    if (!Number.isFinite(lastSeenMs) || (nowMs - lastSeenMs) / 3600000 > STILL_FAILING_WITHIN_HOURS) continue;
    const openHours = (nowMs - Date.parse(currentIncidentOpenedAt(cond, nowMs))) / 3600000;
    if (!(openHours >= PERSISTENT_AFTER_HOURS)) continue;
    if (startNowHealthRowReason({ name }) !== null) continue;
    const linearIdentifier = cond.linearIdentifier || null;
    if ((openIssues || []).some((i) => issueTracksRow(i, { name, conditionKey, linearIdentifier }))) continue;
    out.push({ name, conditionKey, openHours: Math.round(openHours), staleIdentifier: linearIdentifier });
  }
  return out.sort((a, b) => b.openHours - a.openHours);
}

const ROW_NAME = 'Autofix: persistent visitor rows with no open card';

/**
 * The health-check row. `listOpenIssues` and `getIssue` are injectable; a
 * Linear failure reports the row as unmeasurable instead of passing. A row
 * whose ledger tracker was closed as a duplicate of a still-open card is
 * tracked (owner-alert-router.js trackerIsClosed follows the chain).
 */
async function untrackedPersistentRowsResult({ ledger, listOpenIssues, getIssue, nowMs = Date.now() }) {
  let openIssues;
  try {
    openIssues = await listOpenIssues();
  } catch (err) {
    return { name: ROW_NAME, status: 'warn', message: `Unmeasurable: could not list open Linear issues (${String(err.message || err).slice(0, 160)})` };
  }
  const rows = [];
  for (const r of findUntrackedPersistentRows(ledger, openIssues, nowMs)) {
    if (r.staleIdentifier && getIssue && !(await trackerIsClosed(r.staleIdentifier, getIssue))) continue;
    rows.push(r);
  }
  if (rows.length === 0) {
    return { name: ROW_NAME, status: 'pass', message: `Every visitor-facing row red for ${PERSISTENT_AFTER_HOURS}h+ has an open card` };
  }
  const list = rows.slice(0, 5).map((r) => `${r.name} (${Math.round(r.openHours / 24)}d${r.staleIdentifier ? `, ${r.staleIdentifier} closed` : ''})`).join('; ');
  return {
    name: ROW_NAME,
    status: 'warn',
    message: `${rows.length} visitor-facing row(s) red for ${PERSISTENT_AFTER_HOURS / 24}+ days with no open card: ${list}${rows.length > 5 ? '; ...' : ''}`,
    hint: 'The alert router files a new card once a completed card has been closed 7 days with its row still red (BRO-5168). It leaves a canceled card alone: reopen it, or fix the row. Otherwise check data/audit/alert-router-attempts.jsonl.',
  };
}

module.exports = { findUntrackedPersistentRows, untrackedPersistentRowsResult, issueTracksRow, PERSISTENT_AFTER_HOURS, ROW_NAME };
