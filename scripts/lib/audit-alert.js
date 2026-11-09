'use strict';
/**
 * audit-alert.js (BRO-7179, generalized in BRO-7181)
 *
 * Shared "advisory audit -> worker card" plumbing for audits that run in
 * data-health-check.yml under continue-on-error. Before this, a --strict audit
 * there only turned its step red, which nobody reads. With --alert, a finding
 * files (or refreshes) one worker card through owner-alert-router and a clean
 * run resolves the condition so the card closes.
 *
 * buildAuditAlert() is pure. Callers pass rows already reduced to ids, paths,
 * scores, outlet ids and published bylines: never review text, never reader
 * data. Each row is still clamped here so a malformed value cannot carry free
 * text into a card.
 *
 * routeAuditDecisions() does the I/O. It logs and never throws, so an alert
 * failure can never change an audit's own exit code.
 *
 * Missing input (no checkout, empty corpus) must produce NO decision for the
 * findings key: resolving there would close a real card during an outage.
 */

const DEFAULT_MAX_ROWS = 25;
const MAX_ROW_CHARS = 240;

/** Clamp one value for a card row: short single-line strings and scalars only. */
function clampCardValue(v) {
  if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v === undefined ? null : v);
  if (typeof v === 'string' && v.length <= 120 && !/\s{2}|\n/.test(v)) return JSON.stringify(v);
  return `<${typeof v}, not shown>`;
}

function clampRow(row) {
  const s = String(row == null ? '' : row).replace(/[\r\n]+/g, ' ');
  return s.length > MAX_ROW_CHARS ? `${s.slice(0, MAX_ROW_CHARS - 3)}...` : s;
}

/**
 * @param {object} o
 * @param {string} o.conditionKey  owner-alert-router condition key
 * @param {string[]} o.rows        one line per finding (ids/paths/numbers only)
 * @param {(n:number)=>string} o.title  card title for n findings
 * @param {string} o.intro         paragraph above the rows
 * @param {string} o.hint          what the worker does, and the done command
 * @param {string} [o.resolveReason]
 * @param {number} [o.maxRows]
 * @returns {{action:'resolve', conditionKey:string, reason:string}|{action:'route', alert:object}}
 */
function buildAuditAlert({ conditionKey, rows, title, intro, hint, resolveReason, maxRows = DEFAULT_MAX_ROWS }) {
  if (!conditionKey) throw new Error('buildAuditAlert: conditionKey required');
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return { action: 'resolve', conditionKey, reason: resolveReason || `${conditionKey}: clean` };
  }
  const shown = list.slice(0, maxRows).map((r) => `- ${clampRow(r)}`);
  const more = list.length - Math.min(list.length, maxRows);
  if (more > 0) shown.push(`- ...and ${more} more (run the audit for the full list)`);
  return {
    action: 'route',
    alert: {
      conditionKey,
      title: title(list.length),
      description: `${intro} This list is the snapshot at filing; run the audit for the current one.\n\n${shown.join('\n')}`,
      hint,
      severity: 'warning',
      disposition: 'auto',
      cooldownHours: 20,
      // No custom `verify`: the router's fallback (check-alert-condition-absent.js
      // on this key) is on verify-gate's allowlist, so the card stays dispatchable.
    },
  };
}

/**
 * Send one or more decisions. Never throws.
 * @param {Array|object} decisions
 * @param {string} label  script name for log lines
 * @param {{router?:object, log?:Function, error?:Function}} [deps]
 */
async function routeAuditDecisions(decisions, label, deps = {}) {
  const log = deps.log || console.log;
  const error = deps.error || console.error;
  const list = (Array.isArray(decisions) ? decisions : [decisions]).filter(Boolean);
  let router = deps.router;
  for (const d of list) {
    try {
      router = router || require('./owner-alert-router.js');
      if (d.action === 'resolve') {
        router.resolveCondition(d.conditionKey, { reason: d.reason });
        log(`alert: ${d.conditionKey} clear`);
      } else if (d.action === 'route') {
        const r = (await router.routeAlert(d.alert)) || {};
        log(`alert: ${d.alert.conditionKey} ${r.action || 'routed'}${r.linearIdentifier ? ` ${r.linearIdentifier}` : ''}${r.dispatchOk === false ? ` (card not filed: ${r.dispatchError || 'unknown error'})` : ''}`);
      }
    } catch (err) {
      error(`${label}: alert failed: ${err.message}`);
    }
  }
}

module.exports = { buildAuditAlert, routeAuditDecisions, clampCardValue, DEFAULT_MAX_ROWS };
