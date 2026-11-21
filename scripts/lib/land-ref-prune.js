'use strict';

/**
 * land-ref-prune.js — pure decisions for BRO-6103.
 *
 * land.yml deletes land/<name> only after a fast-forward, so every refusal
 * leaves a ref behind (247 on origin on 2026-10-24) and nothing pruned them.
 * They mislead cloud-worker-pick's resume logic and the Codex/land waiters.
 *
 * A ref is pruned only when losing it loses nothing or nobody wants it:
 *   merged    — its tip is already an ancestor of main (compare says
 *               behind/identical); the work is on main
 *   abandoned — idle past ABANDONED_AFTER_DAYS, no Land run in flight, and
 *               its card (if the name carries one) is not In Progress
 * Anything younger than MIN_AGE_DAYS is never touched, and every other ref is
 * kept. The script logs each deleted tip sha, so a delete is recoverable by
 * pushing the sha back.
 */

const MIN_AGE_DAYS = 2;
const ABANDONED_AFTER_DAYS = 14;
// A daily pass removes at most this many, so a wrong rule costs a bounded set.
const MAX_DELETES_PER_RUN = 100;

const daysSince = (iso, now) => (now - Date.parse(iso)) / 86400000;

/**
 * @param {object} p
 * @param {string} p.tipCommittedAt  ISO date of the ref's tip commit (null = unreadable)
 * @param {string|null} p.compareStatus  GitHub compare main...tip status: behind|identical|ahead|diverged
 * @param {number|null} p.runIdleDays  days since the ref's latest Land run last moved (null = none ever)
 * @param {boolean} p.openPr  an open pull request has this ref as head
 * @param {boolean} p.runInFlight  a Land run for this ref is queued or running
 * @param {string|null} p.cardStateType  Linear state type of the card the name carries, null when none/unreadable
 * @param {boolean} p.cardLookupFailed  the name carries a card but Linear could not be read
 * @param {number} [p.now]
 * @returns {{ prune: boolean, reason: string }}
 */
function decideLandRefPrune({ tipCommittedAt, compareStatus, runInFlight, cardStateType, cardLookupFailed, runIdleDays = null, openPr = false, now = Date.now() } = {}) {
  const keep = (reason) => ({ prune: false, reason });
  if (!tipCommittedAt || Number.isNaN(Date.parse(tipCommittedAt))) return keep('tip-date-unreadable');
  const age = daysSince(tipCommittedAt, now);
  if (age < MIN_AGE_DAYS) return keep('too-young');
  if (runInFlight) return keep('land-run-in-flight');
  if (compareStatus === 'behind' || compareStatus === 'identical') return openPr ? keep('open-pr') : { prune: true, reason: 'merged' };
  if (age < ABANDONED_AFTER_DAYS) return keep('recent-unmerged');
  if (cardLookupFailed) return keep('card-unreadable');
  // Only a finished (completed/canceled) or missing card releases unmerged work:
  // Todo, Backlog, Paused and In Progress cards may still want the ref.
  if (cardStateType && cardStateType !== 'completed' && cardStateType !== 'canceled') return keep('card-open');
  if (runIdleDays !== null && runIdleDays < ABANDONED_AFTER_DAYS) return keep('recent-land-run');
  if (openPr) return keep('open-pr');
  return { prune: true, reason: 'abandoned' };
}

module.exports = { decideLandRefPrune, MIN_AGE_DAYS, ABANDONED_AFTER_DAYS, MAX_DELETES_PER_RUN };
