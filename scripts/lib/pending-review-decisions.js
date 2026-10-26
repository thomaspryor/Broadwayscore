/**
 * BRO-6336: record a person's review of commercial-pending-review.json entries.
 * Each reviewed entry leaves the pending queue and lands in commercial-pending-archive.json under its
 * show slug with the outcome and the reason, so it is not reviewed twice. Never touches commercial.json
 * (figures that were confirmed go in through a data/pending-fixes plan).
 *
 * decisions: { "<pending key>": { outcome: "applied"|"rejected"|"duplicate"|"unverifiable", reason: "<10+ chars>" } }
 */
'use strict';

const { writeArchiveRecord } = require('./commercial-claim-triage');

const OUTCOMES = ['applied', 'rejected', 'duplicate', 'unverifiable'];

/** Problems with a decisions map against the pending file; [] when it is safe to apply. */
function decisionProblems(pending, decisions) {
  const problems = [];
  const shows = (pending && pending.shows) || {};
  for (const [key, d] of Object.entries(decisions || {})) {
    if (!Object.prototype.hasOwnProperty.call(shows, key)) problems.push(`${key}: not in the pending file`);
    else if (!d || !OUTCOMES.includes(d.outcome)) problems.push(`${key}: outcome must be one of ${OUTCOMES.join('/')}`);
    else if (typeof d.reason !== 'string' || d.reason.trim().length < 10) problems.push(`${key}: reason needs 10+ characters`);
  }
  return problems;
}

/**
 * Moves every decided entry from pending.shows to archive.shows (mutates both). slugFor(key, entry) names the
 * archive record. Returns { moved, counts } with counts per outcome.
 */
function applyDecisions({ pending, archive, decisions, slugFor, now = new Date().toISOString(), reviewedBy = null }) {
  const problems = decisionProblems(pending, decisions);
  if (problems.length) throw new Error(problems.join('; '));
  const counts = {};
  let moved = 0;
  for (const [key, d] of Object.entries(decisions)) {
    const entry = pending.shows[key];
    const slug = slugFor(key, entry) || key;
    writeArchiveRecord(archive, slug, {
      ...entry,
      ...(slug !== key ? { pendingKey: key } : {}),
      archivedAt: now,
      archivedReason: `reviewed-${d.outcome}`,
      archivedDetail: d.reason.trim(),
      ...(reviewedBy ? { reviewedBy } : {}),
    });
    delete pending.shows[key];
    counts[d.outcome] = (counts[d.outcome] || 0) + 1;
    moved++;
  }
  if (moved) { pending.lastUpdated = now; archive.lastUpdated = now; }
  return { moved, counts };
}

module.exports = { OUTCOMES, decisionProblems, applyDecisions };
