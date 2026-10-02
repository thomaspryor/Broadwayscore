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

/**
 * PURE. Given the live issue for a ledger candidate, is it safe to cancel?
 * @returns {string|null} null when eligible, else the reason it is skipped
 */
function skipReason(issue, conditionKey) {
  if (!issue) return 'issue-not-found';
  const type = issue.state && issue.state.type;
  if (type !== 'backlog' && type !== 'unstarted') return `state-${type || 'unknown'}`;
  if (!String(issue.description || '').includes(`${AUTO_FILED_LINE}${conditionKey})`)) return 'not-filed-for-this-condition';
  const comments = (issue.comments && issue.comments.nodes) || [];
  if (comments.length > 0) return 'has-comments';
  return null;
}

function cancelReason(conditionKey) {
  return `Alert condition ${conditionKey} has cleared (resolved in alert-ledger.json); this auto-filed card had no activity. BRO-4487 sweep.`;
}

module.exports = { AUTO_FILED_LINE, cardConditionIndex, ledgerCandidates, skipReason, cancelReason };
