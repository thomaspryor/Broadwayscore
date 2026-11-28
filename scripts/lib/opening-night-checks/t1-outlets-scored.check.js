'use strict';

const { editionGroupKey } = require('../review-normalization');

const name = 't1-outlets-scored';
const description = 'Core T1 outlets are missing reviews or have unscored reviews after opening night';

/**
 * Core T1 outlets expected to review Broadway shows.
 * Not every T1 reviews every show, but if compositeScore exists and all three
 * are absent, something went wrong in discovery.
 */
const BROADWAY_CORE_T1 = ['nytimes', 'vulture', 'variety'];
const WEST_END_CORE_T1 = ['guardian', 'telegraph', 'times-uk'];

/**
 * Core T1 outlets a show is expected to be reviewed by (BRO-8447).
 * The Telegraph and The Times do not cover Off-West-End, fringe or regional
 * runs (Hackney Empire panto "Jack and the Beanstalk" was flagged missing both),
 * so the West End list applies only to category 'west-end'. Anything that is not
 * a mainstream West End or Broadway-market show has no core T1 expectation.
 */
function coreT1ForShow(show) {
  const market = show.market || (show.category === 'west-end' ? 'west-end' : 'broadway');
  // UK fringe/regional runs are not covered by the nationals; a regional show tagged to the broadway market keeps its list.
  if (show.category === 'off-west-end' || (show.category === 'regional' && market !== 'broadway')) return [];
  return market === 'west-end' ? WEST_END_CORE_T1 : BROADWAY_CORE_T1;
}

// An edition split (The Sunday Times out of times-uk, BRO-5137) fills its
// parent's slot: a show reviewed only by the Sunday Times has its Times review.
function coreSlot(outletId) {
  return editionGroupKey(outletId);
}

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
  const coreT1 = coreT1ForShow(show);
  // Find which core T1 outlets have reviews (any state — even unscored)
  const presentOutlets = new Set(reviews.map(r => coreSlot(r.outletId)));
  const missing = coreT1.filter(id => !presentOutlets.has(id));
  // No expectation (off-west-end/regional UK) still flags T1 reviews that exist but are unscored.
  const watchT1 = coreT1.length === 0 ? WEST_END_CORE_T1 : coreT1;

  // Find T1 reviews that exist but have no valid score
  const unscoredT1 = reviews.filter(r => {
    if (!watchT1.includes(coreSlot(r.outletId))) return false;
    if (r.wrongProduction === true || r.wrongShow === true) return false;
    return r.compositeScore == null && r.assignedScore == null;
  });

  if (coreT1.length === 0 && unscoredT1.length === 0) {
    return { ok: true, severity: 'ok', message: `No core T1 expectation for category ${show.category}` };
  }
  if (missing.length === 0 && unscoredT1.length === 0) {
    const scored = reviews.filter(r => coreT1.includes(coreSlot(r.outletId))).length;
    return {
      ok: true,
      severity: 'ok',
      message: `All core T1 outlets present (${scored}/${coreT1.length}): ${coreT1.join(', ')}`,
    };
  }

  const problems = [];
  const remediation = [];
  if (missing.length > 0) {
    problems.push(`Missing T1 reviews: ${missing.join(', ')} — run: node scripts/gather-reviews.js --show=${show.id} --force`);
    // Self-declared remediation (task #1132, extending #389). gather-reviews.yml
    // takes a comma-separated `shows` input — single-show scoped, same as the
    // manual --show=ID command it replaces.
    remediation.push({
      kind: 'workflow',
      key: `t1-missing:${show.id}`,
      workflow: 'gather-reviews.yml',
      inputs: { shows: show.id },
      reason: `missing T1 outlets: ${missing.join(', ')}`,
    });
  }
  if (unscoredT1.length > 0) {
    const ids = unscoredT1.map(r => r.outletId).join(', ');
    problems.push(`Unscored T1 reviews: ${ids} — run: node scripts/collect-review-texts.js --show=${show.id}`);
    remediation.push({
      kind: 'workflow',
      key: `t1-unscored:${show.id}`,
      workflow: 'collect-review-texts.yml',
      inputs: { show_filter: show.id },
      reason: `unscored T1 outlets: ${ids}`,
    });
  }

  // Missing all 3 core T1s with a compositeScore is likely a pipeline failure — error
  const severity = coreT1.length > 0 && missing.length === coreT1.length ? 'error' : 'warning';

  return {
    ok: false,
    severity,
    message: problems.join('\n'),
    details: {
      missing,
      unscoredT1: unscoredT1.map(r => ({ outletId: r.outletId, url: r.url })),
      remediation,
    },
  };
}

module.exports = { name, description, run, coreT1ForShow, BROADWAY_CORE_T1, WEST_END_CORE_T1 };
