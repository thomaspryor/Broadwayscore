'use strict';
/**
 * gap-terminal.js — the ONE definition of "this review's full text cannot be
 * recovered" (BRO-7171 Stage 4, zero-gap plan terminal state).
 *
 * A terminal review is still scored and published at its excerpt / stub
 * weight: terminal only stops the gap engine and the collector from retrying
 * it, and stops the gap metric from counting it as open. Nothing here drops a
 * review.
 *
 * Record (on the review file, PROTECTED in review-write-guard):
 *   textUnrecoverable: {
 *     reason,          one of TERMINAL_REASONS
 *     decidedAt,       ISO time
 *     decidedBy,       'gap-terminal-auto' | 'owner'
 *     approvedBy,      owner reply quote (required unless the reason is AUTO)
 *     evidence[],      non-empty, human-readable proof lines
 *     urlAtDecision,   the file's url when decided (null for no-url files)
 *     policyVersion,   TERMINAL_POLICY_VERSION
 *   }
 * The record is valid only while the file still carries urlAtDecision; a url
 * change also clears it (url-change-invariant URL_DERIVED_FIELDS). Clearing it
 * by hand needs `textUnrecoverableClearReason` (write-guard breadcrumb).
 *
 * Policy (owner standard: no gaps; recent shows never written off):
 *   - shows opened within 730 days are NEVER terminal, whoever decides;
 *   - AUTO reasons need no approval but need their evidence:
 *       OUTLET_DEFUNCT  the outlet's domain no longer resolves (DNS) AND the
 *                       Wayback Machine has no capture of the review url
 *       NEVER_ONLINE    print-only outlet (registry accessModel 'print')
 *   - every other reason needs the owner's approval (approvedBy).
 */

const TERMINAL_POLICY_VERSION = 1;
const AUTO_REASONS = Object.freeze(['OUTLET_DEFUNCT', 'NEVER_ONLINE']);
const OWNER_REASONS = Object.freeze(['PAYWALL_NO_ACCESS', 'URL_DEAD_NO_ARCHIVE', 'NOT_FINDABLE']);
const TERMINAL_REASONS = Object.freeze([...AUTO_REASONS, ...OWNER_REASONS]);

/**
 * Is this review's terminal record valid right now? Pure.
 * @param {object} review
 * @param {{recency?: 'recent'|'historic'|null}} [ctx] recency from the show dates when known
 * @returns {{valid:boolean, reason:string}}
 */
function validateTerminal(review, { recency = null } = {}) {
  const t = review && review.textUnrecoverable;
  if (!t || typeof t !== 'object') return { valid: false, reason: 'no_record' };
  if (!TERMINAL_REASONS.includes(t.reason)) return { valid: false, reason: 'unknown_reason' };
  if (!t.decidedAt || !Number.isFinite(Date.parse(t.decidedAt))) return { valid: false, reason: 'no_decided_at' };
  if (!Array.isArray(t.evidence) || !t.evidence.some((e) => typeof e === 'string' && e.trim())) return { valid: false, reason: 'no_evidence' };
  if (t.policyVersion !== TERMINAL_POLICY_VERSION) return { valid: false, reason: 'policy_version' };
  if (!AUTO_REASONS.includes(t.reason) && !(typeof t.approvedBy === 'string' && t.approvedBy.trim())) {
    return { valid: false, reason: 'owner_approval_missing' };
  }
  if ((t.urlAtDecision || null) !== (review.url || null)) return { valid: false, reason: 'url_changed' };
  if (recency === 'recent') return { valid: false, reason: 'recent_show' };
  return { valid: true, reason: t.reason };
}

/** Build a record (the CLI's only constructor). */
function buildTerminalRecord({ review, reason, evidence, decidedBy, approvedBy = null, nowIso = new Date().toISOString() }) {
  const rec = {
    reason, decidedAt: nowIso, decidedBy, evidence: [...evidence],
    urlAtDecision: (review && review.url) || null, policyVersion: TERMINAL_POLICY_VERSION,
  };
  if (approvedBy) rec.approvedBy = approvedBy;
  return rec;
}

// No outlet is written off by rule (owner challenge 2026-11-09: 14 Telegraph
// reviews were sent as "subscription cancelled" with zero attempts logged, and
// the cookie session and Bright Data both still returned the full text).
// PAYWALL_NO_ACCESS needs a logged failure on EVERY route that can open a
// paywalled page we hold a url for; BROWSER_SESSION only where the outlet has a
// subscriber adapter. auth_failed is a failure here: the claim is "no access".
const PAYWALL_ACCESS_ROUTES = Object.freeze(['REFETCH_FREE', 'PAID_FETCH', 'ARCHIVE']);
const PAYWALL_CLASSES = new Set(['PAYWALL_PAGE', 'PAYWALL_TRUNCATED']);
const ACCESS_FAILED = new Set(['rejected', 'no_evidence', 'auth_failed']);

// Driver skip reasons that do not expire: a strategy turned off on measured
// yield, no url / no adapter for it, a stored url that names another show, or
// every url-finding method already run. Anything else (cooldown,
// browser_unavailable, no_serp_key, url_find_cooldown, ...) is waiting.
const PERMANENT_SKIPS = /^(?:disabled|disabled_recent|no_url|no_adapter|url_names_other_(?:show|venue)|url_find_exhausted)$/;

const { liveRows } = require('./gap-recovery-ledger');

/** Evidence lines for the paywall routes, or the routes still untried. Pure. */
function paywallRouteEvidence(tries, routes) {
  const evidence = [];
  const missing = [];
  for (const route of routes) {
    const hit = [...tries].reverse().find((t) => t.strategy === route && ACCESS_FAILED.has(t.outcome));
    if (hit) evidence.push(`${route}: ${hit.outcome} (${hit.reason || '?'}) ${String(hit.ts || '').slice(0, 10)} run ${hit.runId || '?'}`);
    else missing.push(route);
  }
  return { evidence, missing };
}

/**
 * Sort the driver's no-route rows into terminal candidates. Pure.
 * Only HISTORIC rows the driver has nothing left to try are considered; a row
 * goes to a group only when its evidence exists, otherwise it stays open
 * ('no_evidence_yet').
 * @param {Array} planRows   driver dry-run candidates ({reviewKey, gapClass, subclass, recency, strategy, outletId, url})
 * @param {Map<string, Array>} attemptsByKey ledger rows per reviewKey
 * @param {{deadHosts?: Map<string,string>, hostFor?: (row)=>string|null}} [io] DNS results gathered by the caller
 * @returns {{auto: Array<{row, reason, evidence}>, owner: Record<string, Array<{row, evidence}>>, open: Record<string, number>}}
 */
function groupTerminalCandidates(planRows, attemptsByKey, { deadHosts = new Map(), hostFor = () => null, hasAdapter = () => false } = {}) {
  const auto = [];
  const owner = { PAYWALL_NO_ACCESS: [], URL_DEAD_NO_ARCHIVE: [], NOT_FINDABLE: [] };
  const open = {};
  const bump = (k) => { open[k] = (open[k] || 0) + 1; };
  for (const row of planRows) {
    if (row.recency === 'recent' || row.recency == null) { bump('recent_never_terminal'); continue; }
    if (row.strategy) { bump('route_left_to_try'); continue; }
    // "Nothing to try right now" is not "nothing left": a cooldown, a missing
    // browser or key, or a record another owner holds keeps the row open.
    const skips = Array.isArray(row.skipped) ? row.skipped : [];
    const owned = skips.find((k) => k.strategy === 'ANY');
    if (owned) { bump(`owned:${owned.reason}`); continue; }
    if (skips.some((k) => !PERMANENT_SKIPS.test(String(k.reason || '')))) { bump('waiting_on_retry'); continue; }
    // A garbage page: the terminal reason would mask scraper_garbage and let
    // the scorer read the garbage text (incomplete-reason.js priority order).
    if (row.gapClass === 'GARBAGE_PAGE') { bump('no_evidence_yet:GARBAGE_PAGE'); continue; }
    // Same for a saved not-found page routed as URL_DEAD (text-gap-classify).
    if (row.subclass === 'saved_error_page') { bump('no_evidence_yet:saved_error_page'); continue; }
    // A reopen (url corrected, text changed) resets the evidence (ledger liveRows).
    const tries = liveRows(attemptsByKey.get(row.reviewKey) || []);
    const archiveEmpty = tries.find((t) => t.strategy === 'ARCHIVE' && t.outcome === 'no_evidence' && /archive_empty/.test(t.reason || ''));
    const host = hostFor(row);
    if (host && deadHosts.has(host) && (!row.url || archiveEmpty)) {
      auto.push({ row, reason: 'OUTLET_DEFUNCT', evidence: [
        `dns: ${host} ${deadHosts.get(host)}`,
        row.url ? `wayback: no capture of ${row.url} (ledger ${archiveEmpty.runId || '?'})` : 'no url on file',
      ] });
      continue;
    }
    if (row.url && PAYWALL_CLASSES.has(row.gapClass)) {
      const routes = hasAdapter(row) ? [...PAYWALL_ACCESS_ROUTES, 'BROWSER_SESSION'] : [...PAYWALL_ACCESS_ROUTES];
      const p = paywallRouteEvidence(tries, routes);
      if (!p.missing.length) { owner.PAYWALL_NO_ACCESS.push({ row, evidence: p.evidence }); continue; }
    }
    if (row.gapClass === 'URL_DEAD' && archiveEmpty) {
      owner.URL_DEAD_NO_ARCHIVE.push({ row, evidence: [`url dead (${row.subclass || 'url_dead'})`, `wayback: no capture (ledger ${archiveEmpty.runId || '?'})`] });
      continue;
    }
    if (row.gapClass === 'NO_URL') {
      const prog = require('./gap-url-find').urlFindProgress(tries);
      if (!prog.missing.length) {
        const urlNote = row.subclass === 'INVENTED_URL' ? 'url on file was invented by the deleted web-search step' : `no url on file (${row.subclass || 'NO_URL'})`;
        owner.NOT_FINDABLE.push({ row, evidence: [urlNote, ...prog.evidence] });
        continue;
      }
    }
    bump(`no_evidence_yet:${row.gapClass}`);
  }
  return { auto, owner, open };
}

module.exports = { PAYWALL_ACCESS_ROUTES, paywallRouteEvidence, groupTerminalCandidates, TERMINAL_POLICY_VERSION, AUTO_REASONS, OWNER_REASONS, TERMINAL_REASONS, validateTerminal, buildTerminalRecord };
