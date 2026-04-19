'use strict';

const name = 't1-outlets-scored';
const description = 'Core T1 outlets are missing reviews or have unscored reviews after opening night';

/**
 * Core T1 outlets expected to review Broadway shows.
 * Not every T1 reviews every show, but if compositeScore exists and all three
 * are absent, something went wrong in discovery.
 */
const BROADWAY_CORE_T1 = ['nytimes', 'vulture', 'variety'];
const WEST_END_CORE_T1 = ['guardian', 'telegraph', 'times-uk'];

// Hours after opening before we flag missing T1 reviews (give critics time to publish)
const HOURS_AFTER_OPENING = 24;

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const { compositeScore } = show;

  // Only meaningful after compositeScore exists — before that, T1s may not have published
  if (compositeScore == null) {
    return { ok: true, severity: 'ok', message: 'No compositeScore yet — T1 check deferred' };
  }

  // Only flag if we're past the grace window
  const openingDate = show.openingDate ? new Date(show.openingDate) : null;
  if (openingDate) {
    const hoursOpen = (context.now - openingDate) / (1000 * 60 * 60);
    if (hoursOpen < HOURS_AFTER_OPENING) {
      return {
        ok: true,
        severity: 'ok',
        message: `Within ${HOURS_AFTER_OPENING}h of opening — T1 check deferred (${Math.round(hoursOpen)}h elapsed)`,
      };
    }
  }

  const reviews = context.reviewsDoc[show.id] || [];
  const market = show.market || (show.category === 'west-end' || show.category === 'off-west-end' ? 'west-end' : 'broadway');
  const coreT1 = market === 'west-end' ? WEST_END_CORE_T1 : BROADWAY_CORE_T1;

  // Find which core T1 outlets have reviews (any state — even unscored)
  const presentOutlets = new Set(reviews.map(r => r.outletId));
  const missing = coreT1.filter(id => !presentOutlets.has(id));

  // Find T1 reviews that exist but have no valid score
  const unscoredT1 = reviews.filter(r => {
    if (!coreT1.includes(r.outletId)) return false;
    if (r.wrongProduction === true || r.wrongShow === true) return false;
    return r.compositeScore == null && r.assignedScore == null;
  });

  if (missing.length === 0 && unscoredT1.length === 0) {
    const scored = reviews.filter(r => coreT1.includes(r.outletId)).length;
    return {
      ok: true,
      severity: 'ok',
      message: `All core T1 outlets present (${scored}/${coreT1.length}): ${coreT1.join(', ')}`,
    };
  }

  const problems = [];
  if (missing.length > 0) {
    problems.push(`Missing T1 reviews: ${missing.join(', ')} — run: node scripts/gather-reviews.js --show=${show.id} --force`);
  }
  if (unscoredT1.length > 0) {
    const ids = unscoredT1.map(r => r.outletId).join(', ');
    problems.push(`Unscored T1 reviews: ${ids} — run: node scripts/collect-review-texts.js --show=${show.id}`);
  }

  // Missing all 3 core T1s with a compositeScore is likely a pipeline failure — error
  const severity = missing.length === coreT1.length ? 'error' : 'warning';

  return {
    ok: false,
    severity,
    message: problems.join('\n'),
    details: { missing, unscoredT1: unscoredT1.map(r => ({ outletId: r.outletId, url: r.url })) },
  };
}

module.exports = { name, description, run, BROADWAY_CORE_T1, WEST_END_CORE_T1 };
