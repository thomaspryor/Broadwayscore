'use strict';

/**
 * resolved-alert-card-sweep.js — BRO-4487. A card filed by owner-alert-router
 * should not outlive the condition it was filed for. resolveCondition() is a
 * synchronous, local ledger write with dozens of callers, so cancelling the
 * Linear card there would put a network round trip inside every caller; this
 * pure selector feeds a separate sweep (scripts/sweep-resolved-alert-cards.js)
 * instead. Measured 2026-10-01: 25 open router cards whose condition was
 * already resolved in data/audit/alert-ledger.json.
 *
 * Deliberately narrow (second-opinion, 2026-10-02): the router's duplicate
 * check matches a conditionKey anywhere in an issue's text, so the ledger can
 * point a condition at a human-filed design card (BRO-3030 is linked to 8
 * conditions). A card is only eligible when ALL hold:
 *   - the ledger condition is resolved and names the card,
 *   - no OPEN condition in the ledger names the same card,
 *   - the card's own description carries the router's auto-filed line for
 *     exactly this conditionKey (it was filed FOR this condition),
 *   - it is still waiting (backlog/unstarted), never started,
 *   - nobody has commented on it (no session or person has touched it).
 */

const AUTO_FILED_LINE = 'Auto-filed by owner-alert-router (condition: ';

/** PURE. Map identifier -> {resolved: [keys], open: [keys]} from the ledger. */
function cardConditionIndex(ledger) {
  const index = new Map();
  for (const [key, c] of Object.entries((ledger && ledger.conditions) || {})) {
    if (!c || !c.linearIdentifier) continue;
    const entry = index.get(c.linearIdentifier) || { resolved: [], open: [] };
    (c.status === 'open' ? entry.open : entry.resolved).push(key);
    index.set(c.linearIdentifier, entry);
  }
  return index;
}

/** PURE. Ledger-side candidates: cards whose every linked condition is resolved. */
function ledgerCandidates(ledger) {
  const out = [];
  for (const [identifier, e] of cardConditionIndex(ledger)) {
    if (e.open.length === 0 && e.resolved.length === 1) out.push({ identifier, conditionKey: e.resolved[0] });
  }
  return out;
}

const DAY_MS = 86400000;

// Opening-night routine logs ("Opening-night watch 2026-10-06"): one card per
// night, commented on during the night, never closed by the routine. Over
// once the night is LOG_DONE_DAYS old and nobody has touched the card since.
const LOG_TITLE_RE = /^Opening-night (watch|audit) (\d{4}-\d{2}-\d{2})$/;
const LOG_DONE_DAYS = 3;

/** PURE. Cancel reason for a finished routine log card, or null. */
function routineLogCancelReason(issue, now) {
  const m = String((issue && issue.title) || '').trim().match(LOG_TITLE_RE);
  if (!m) return null;
  const type = issue.state && issue.state.type;
  if (type !== 'backlog' && type !== 'unstarted') return null;
  const night = Date.parse(`${m[2]}T23:59:59Z`);
  const touched = Date.parse(issue.updatedAt || '');
  if (!Number.isFinite(night) || !Number.isFinite(touched)) return null;
  if ((now - night) / DAY_MS < LOG_DONE_DAYS || (now - touched) / DAY_MS < LOG_DONE_DAYS) return null;
  return `Routine ${m[1]} log for ${m[2]}: the night is over and the card has had no activity for ${LOG_DONE_DAYS}+ days. Sweep (BRO-4956 follow-up).`;
}

/**
 * PURE. Given the live issue for a ledger candidate, is it safe to cancel?
 * @returns {string|null} null when eligible, else the reason it is skipped
 */
function skipReason(issue, conditionKey) {
  if (!issue) return 'issue-not-found';
  const type = issue.state && issue.state.type;
  if (type !== 'backlog' && type !== 'unstarted') return `state-${type || 'unknown'}`;
  if (!String(issue.description || '').includes(`${AUTO_FILED_LINE}${conditionKey})`)) return 'not-filed-for-this-condition';
  // A repeat-filing note (linear-issue-create reuseOpenTwin) is not activity.
  const comments = ((issue.comments && issue.comments.nodes) || []).filter((c) => !/^Filed again on /.test(String((c && c.body) || '')));
  if (comments.length > 0) return 'has-comments';
  return null;
}

function cancelReason(conditionKey) {
  return `Alert condition ${conditionKey} has cleared (resolved in alert-ledger.json); this auto-filed card had no activity. BRO-4487 sweep.`;
}

module.exports = { AUTO_FILED_LINE, cardConditionIndex, ledgerCandidates, skipReason, cancelReason, routineLogCancelReason };
