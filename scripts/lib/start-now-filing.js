'use strict';
// BRO-5168: which daily health rows may be filed as START-NOW cards, and the
// text both filers put on them. Shared by digest-autofix.js (Mac) and
// owner-alert-router.js's dispatchCard (CI) so the two cannot drift.
//
// A START-NOW card is Todo at High with a `START-NOW:` line, so the cloud
// worker (cloud-worker-pick.js) takes it ahead of its queue without waiting
// for the Mac dispatcher. That only makes sense for a row a worker can fix on
// its own. digest-audience.js classifies unknown names as 'visitors' on
// purpose (a wrong 'visitors' there costs one noisy digest line), so this
// module adds the rows that need the owner's money or the owner's Mac.

const { classifyHealthCheck } = require('./digest-audience.js');
const { hasPlaybookAction } = require('./playbook-copy.js');

// Rows whose fix is a purchase, a credential rotation or a cookie refresh on
// the owner's Mac (health-check.js AUTO_FIX_PLAYBOOK: "consider upgrading",
// "On your Mac ..."). A worker can only re-diagnose these.
const OWNER_OR_MAC_ROW_RE = /^(?:Credits|Secrets|Cookies):|^Revenue: affiliate health$/;

// Same shape digest-autofix.js isRowAcknowledged reads (scrapingbee-ack.js /
// scrapingdog-ack.js suffix).
const ACKNOWLEDGED_ROW_RE = /acknowledged:.*\[expires\s+(\d{4}-\d{2}-\d{2})\]/i;

// linear-issue-create.js's refusal text when a START-NOW card would never be
// picked; matched on a thrown error's message (and a CLI's stderr).
const START_NOW_REFUSED_RE = /START-NOW card would never be picked/;

/**
 * PURE. Why this health row may NOT be filed START-NOW, or null if it may.
 * @param {{name:string, message?:string}} row
 * @param {string} [today] YYYY-MM-DD, for the acknowledgement expiry
 * @returns {null|'internal'|'owner-or-mac'|'acknowledged'}
 */
function startNowHealthRowReason(row, today, { allowInternal = false } = {}) {
  const name = String((row && row.name) || '');
  // allowInternal (BRO-6478): the caller holds a playbook entry marked workerFixable, so a queue-health row is a
  // worker's job too. The owner-or-mac and acknowledged checks still apply.
  if (!allowInternal && classifyHealthCheck({ name }) !== 'visitors') return 'internal';
  if (OWNER_OR_MAC_ROW_RE.test(name)) return 'owner-or-mac';
  const ack = ACKNOWLEDGED_ROW_RE.exec(String((row && row.message) || ''));
  if (ack && ack[1] > (today || new Date().toISOString().slice(0, 10))) return 'acknowledged';
  return null;
}

/** The leading START-NOW line. `who` names what else may run it first. */
function startNowLine(who, { internal = false } = {}) {
  const what = internal ? 'daily health row about the work queue itself (a playbook entry marks it workerFixable)' : 'visitor-facing daily health row (digest-audience.js)';
  return `START-NOW: ${what}. Any worker may take it once ${who} has not claimed it.`;
}

/**
 * PURE. health-check.js routes only rows whose playbook entry has a
 * humanAction or ownerText/workerInstruction (playbook-copy.js
 * hasPlaybookAction); every other failing row reached no tracker at all from CI, so
 * while the Mac was down nothing filed a card for it (BRO-5168). This picks
 * the failing rows a worker could fix that have no route yet.
 * @param {Array<{name:string,status:string,message?:string}>} rows
 * @param {{getPlaybookEntry:(name:string)=>object|null, today?:string}} deps
 */
function selectUnroutedVisitorRows(rows, { getPlaybookEntry, today } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || !r.name || (r.status !== 'error' && r.status !== 'warn')) return false;
    const entry = getPlaybookEntry ? getPlaybookEntry(r.name) : null;
    if (entry && (entry.workflow || hasPlaybookAction(entry))) return false;
    return startNowHealthRowReason(r, today) === null;
  });
}

module.exports = { startNowHealthRowReason, startNowLine, selectUnroutedVisitorRows, START_NOW_REFUSED_RE, OWNER_OR_MAC_ROW_RE };
