'use strict';

const name = 'orphan-scoresource';
const description = 'Flags reviews in reviews.json with scoreSource=null — indicates syndication/dedup orphans';

/**
 * Balusters postmortem CLASS 3 — syndicate orphans.
 *
 * On Balusters opening, both chicagotribune--chris-jones.json and
 * nydailynews--chris-jones.json landed with near-identical text. Rebuild
 * correctly fingerprint-deduped, but the losing file ended up in reviews.json
 * with scoreSource=null. Because the UI filters by scoreSource presence, this
 * wasn't visible — but it means we have an "alive" review record that no
 * extractor ever owned. Generalizes beyond known-pair list to catch any future
 * syndication we haven't mapped.
 *
 * Severity: warning for any orphan, error at 3+.
 */
function run(show, context) {
  const reviews = context.reviewsDoc[show.id] || [];
  if (reviews.length === 0) {
    return { ok: true, severity: 'ok', message: 'No reviews yet — skipping orphan scoreSource check' };
  }

  const orphans = reviews.filter(r => {
    if (r.scoreSource) return false;
    // Reviews that intentionally have no score (pre-opening placeholders, duplicateOf
    // routing) also have no scoreSource. Only flag when we have some signal that this
    // file should have contributed: it has an assignedScore OR fullText OR an excerpt
    // but still shows scoreSource=null.
    const looksScorable =
      Number.isFinite(r.assignedScore) ||
      (typeof r.fullText === 'string' && r.fullText.length >= 100) ||
      !!r.dtliExcerpt || !!r.bwwExcerpt || !!r.showScoreExcerpt;
    return looksScorable;
  });

  if (orphans.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `No orphaned reviews (${reviews.length} scored reviews, all have scoreSource)`,
    };
  }

  const severity = orphans.length >= 3 ? 'error' : 'warning';
  const top = orphans.slice(0, 5)
    .map(r => `  - ${r.outletId || 'unknown'} / ${r.criticName || 'Unknown'} (score=${r.assignedScore ?? 'null'})`)
    .join('\n');

  return {
    ok: false,
    severity,
    message: `${orphans.length} review(s) have scoreSource=null but look scorable — likely syndicate/dedup orphans:\n${top}${orphans.length > 5 ? `\n  ... and ${orphans.length - 5} more` : ''}`,
    details: {
      orphanCount: orphans.length,
      totalReviews: reviews.length,
      orphans: orphans.map(r => ({
        outletId: r.outletId,
        criticName: r.criticName,
        url: r.url,
        assignedScore: r.assignedScore ?? null,
      })),
    },
  };
}

module.exports = { name, description, run };
