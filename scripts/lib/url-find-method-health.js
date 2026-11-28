/**
 * url-find-method-health.js: pure URL_FIND method-outage detector (BRO-8000).
 * No requires on purpose: the morning digest / nightly row load this file and
 * must not pull scraper.js or playwright (tests/unit/morning-digest-action.test.mjs).
 */
'use strict';

// Statuses a finished method may carry (mirror of gap-url-find METHOD_DONE).
const METHOD_DONE = new Set(['no_candidates', 'not_applicable', 'candidates_refused']);
/**
 * BRO-8000 class guard: per URL_FIND method, the share of runs in the last day
 * whose status was an error or a blocked route. A method that fails most of
 * its runs is an outage, not "nothing found". Pure. Returns
 * [{method, runs, errored, rate, lastError}] for methods over `threshold`
 * (default >50%) with at least `minRuns` runs.
 */
const METHOD_FAIL_STATUS = new Set(['error', 'archive_auth_required']);
function urlFindMethodErrorRates(rows, { nowMs = Date.now(), hours = 24, threshold = 0.5, minRuns = 5 } = {}) {
  const since = nowMs - hours * 3600000;
  const by = {};
  for (const r of rows || []) {
    if (!r || r.strategy !== 'URL_FIND') continue;
    const t = Date.parse(r.ts || '');
    if (!Number.isFinite(t) || t < since) continue;
    const ms = (r.detail && r.detail.methods) || {};
    const errs = (r.detail && r.detail.methodErrors) || {};
    for (const [m, st] of Object.entries(ms)) {
      if (st === 'skipped_paid' || st === 'not_run') continue;
      const b = by[m] || (by[m] = { method: m, runs: 0, errored: 0, blocked: 0, lastError: null });
      b.runs++;
      if (METHOD_FAIL_STATUS.has(st) || (errs[m] && !METHOD_DONE.has(st))) { b.errored++; if (st === 'archive_auth_required' || /^archive_auth_required/.test(String(errs[m] || ''))) b.blocked = (b.blocked || 0) + 1; b.lastError = errs[m] || st; }
    }
  }
  return Object.values(by).map((b) => ({ ...b, rate: b.runs ? b.errored / b.runs : 0 }))
    // The 403 is per publisher, so a typed block can sit under 50% across all hosts: any 5+ typed blocks a day alert too.
    .filter((b) => b.runs >= minRuns && (b.rate > threshold || b.blocked >= minRuns)).sort((a, b) => b.rate - a.rate);
}


module.exports = { urlFindMethodErrorRates, METHOD_FAIL_STATUS };
