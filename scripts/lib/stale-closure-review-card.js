/**
 * Linear card text for a closed show that classify-stale-closures.js put in
 * its 'human-review' bucket (BRO-3490, Codex CDX-P0-3 follow-up). Filed by
 * scripts/notify-pending-commercial-linear.js from the --report-json the
 * classifier writes. Pure, so tests require it (CLAUDE.md §15).
 */

'use strict';

const DAY_MS = 86_400_000;

/** Short, stable class of a classifier reason; part of the dedup title. */
function reasonKind(reason) {
  const r = String(reason || '');
  if (r.startsWith('enhancement-deal')) return 'enhancement';
  if (r.startsWith('late-recoupment-signal')) return 'late-signal';
  if (r.includes('deep-research never ran')) return 'unresearched';
  return 'review';
}

/**
 * Stable title per show AND reason class; notify-pending-commercial-linear
 * dedups on it (exact title, open or closed). A new kind of escalation for
 * the same show (say a late recoupment signal after an enhancement-deal card
 * was closed) gets its own card instead of being swallowed by the old one.
 */
function buildClosureReviewTitle(slug, kind = 'review') {
  return `Closed show needs commercial review: ${slug} (stale-closure-review-${slug}-${kind})`;
}

/**
 * Pure: the classifier's human-review bucket -> report rows. Rows marked
 * needsResearch are left out: deep research picks those up on its own
 * (commercial-queue.js staleClosuresNeedingResearch), so only real judgment
 * calls (enhancement deals, late recoupment signals) become Linear cards.
 * @param {Array<{show:object, result:{reason:string}}>} bucket
 * @param {number} [nowMs]
 */
function buildClosureReviewItems(bucket, nowMs = Date.now()) {
  return (bucket || [])
    .filter((it) => it && it.show && it.show.slug && !(it.result && it.result.needsResearch))
    .map(({ show, result }) => {
      const closed = Date.parse(show.closingDate);
      return {
        slug: show.slug,
        title: show.title || show.slug,
        closingDate: show.closingDate || null,
        daysClosed: Number.isFinite(closed) ? Math.floor((nowMs - closed) / DAY_MS) : null,
        reason: (result && result.reason) || 'unknown',
        kind: reasonKind(result && result.reason),
      };
    });
}

function buildClosureReviewNotes(item) {
  return [
    '## Problem',
    '',
    `The daily stale-closure classifier (\`scripts/classify-stale-closures.js\`, workflow \`commercial-stale-closures.yml\`) cannot label **${item.title}** (\`${item.slug}\`) and escalated it for human review. Until someone acts, the show stays TBD on the commercial page.`,
    '',
    '## Details',
    '',
    `- Show slug: \`${item.slug}\``,
    `- Closing date: ${item.closingDate || 'unknown'}${item.daysClosed != null ? ` (${item.daysClosed} days ago when filed)` : ''}`,
    `- Classifier reason: ${item.reason}`,
    '',
    '## Suggested approach',
    '',
    '1. Read the classifier reason above and decide the designation by hand in `data/commercial.json` (set `humanReviewedDesignation: true` so the classifier leaves it alone).',
    '',
    '## Acceptance criteria',
    '',
    `Done when the show has a reviewed designation in commercial.json (not TBD, or humanReviewedDesignation set).`,
    '',
    `VERIFY: node scripts/check-review-item-resolved.js --closure=${item.slug}`,
    '',
    `Auto-filed by notify-pending-commercial-linear.js (stale-closure-review-${item.slug}-${item.kind || 'review'}).`,
  ].join('\n');
}

module.exports = { reasonKind, buildClosureReviewTitle, buildClosureReviewItems, buildClosureReviewNotes };
