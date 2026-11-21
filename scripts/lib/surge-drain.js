'use strict';

/**
 * surge-drain.js — what an unattended clear sweep does when more files are
 * confirmed than its surge threshold allows (BRO-5672).
 *
 * clear-stale-wrong-production-flags.js used to REFUSE the whole batch above
 * the threshold, after spending ~18 minutes of Sonnet calls on it. Scheduled
 * weekly with a real backlog (319 candidates on 2026-10-17), that meant every
 * run verified the same files, wrote nothing and went red, so the backlog
 * never shrank. The threshold exists to bound blast radius if the predicate or
 * verifier regresses; clearing the newest `threshold` files per run keeps that
 * bound and still makes progress. --force-bulk still lifts it.
 */

/**
 * @param {Array<{c: {data: {publishDate?: string}}}>} decisions confirmed clears
 * @param {number} threshold max clears per run
 * @param {boolean} forceBulk
 * @param {(d: object) => number} [priority] lower sorts (and is applied) first
 * @returns {{apply: Array, deferred: Array}}
 */
function splitSurge(decisions, threshold, forceBulk, priority) {
  // A copy, never the caller's array: mutating the input once emptied the apply list.
  if (forceBulk || decisions.length <= threshold) return { apply: decisions.slice(), deferred: [] };
  const ts = (d) => Date.parse(d && d.c && d.c.data && d.c.data.publishDate) || 0;
  // `priority` (lower first) keeps a class the caller must not starve ahead of
  // newest-first, e.g. prior-run candidates, which are old by definition.
  const pri = typeof priority === 'function' ? priority : () => 0;
  const ordered = decisions.slice().sort((a, b) => pri(a) - pri(b) || ts(b) - ts(a));
  return { apply: ordered.slice(0, threshold), deferred: ordered.slice(threshold) };
}

module.exports = { splitSurge };
