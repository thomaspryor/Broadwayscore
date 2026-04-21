'use strict';

const name = 'assigned-score-schema';
const description = 'Every review in reviews.json has a numeric assignedScore (catches schema drift like "2/4 stars" string)';

function run(show, context) {
  const reviews = context.reviewsDoc[show.id] || [];
  if (reviews.length === 0) {
    return { ok: true, severity: 'ok', message: 'No reviews yet — skipping schema check' };
  }

  const violations = [];
  for (const review of reviews) {
    const score = review.assignedScore;
    // Null is allowed (represents "not yet scored"). The readiness gate already
    // filters on assignedScore != null before counting for broadcast eligibility.
    if (score === null || score === undefined) continue;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      violations.push({
        outletId: review.outletId,
        criticName: review.criticName,
        assignedScore: score,
        assignedScoreType: typeof score,
        url: review.url,
      });
    }
  }

  if (violations.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All ${reviews.length} review(s) have numeric assignedScore`,
    };
  }

  return {
    ok: false,
    severity: 'error',
    message: violations.map(v =>
      `${v.outletId}/${v.criticName}: assignedScore is ${v.assignedScoreType} (${JSON.stringify(v.assignedScore)}), expected number — ${v.url}`
    ).join('\n'),
    details: { violations, showId: show.id },
  };
}

module.exports = { name, description, run };
