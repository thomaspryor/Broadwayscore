'use strict';

/**
 * BRO-7196: every live review card on an opening-night show has an outlet display name, a critic, a publish date and
 * a pull quote. Wanted (2026-11-08) went live with raw outlet ids for names and no quote on any card; the lane now
 * holds such rows itself (lane-runner.js), and this check covers every other writer (ingest-urls, gather, a hand edit)
 * from the reviews.json rows the show page is generated from. One contract: scripts/lib/review-completeness.js.
 *
 * Advisory (warning) while it beds in (CLAUDE.md rule 19); it reads data only, no network.
 */
const { missingCardFields } = require('../review-completeness');

const name = 'review-cards-complete';
const ALERT_FIELDS = ['outlet', 'pullQuote'];
const description = 'Every live review card has outlet name, critic, publish date and pull quote';

const isLive = (r) => r && !r.wrongProduction && !r.wrongShow && !r.isRoundupArticle && !r.excluded
  && (r.assignedScore != null || r.compositeScore != null);

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const rows = ((context.reviewsDoc || {})[show.id] || []).filter(isLive);
  if (!rows.length) return { ok: true, severity: 'ok', message: 'No live reviews yet' };
  const gaps = rows
    .map((r) => ({ outletId: r.outletId, url: r.url, missing: missingCardFields(r) }))
    .filter((g) => g.missing.length);
  const counts = {};
  for (const g of gaps) for (const f of g.missing) counts[f] = (counts[f] || 0) + 1;
  const summary = Object.entries(counts).map(([f, n]) => `${n} no ${f}`).join(', ');
  // Outlet name and quote are the alert: every scored review can have both (Wanted had neither on any card). An unsigned
  // or undated review is common and legitimate across the catalogue, so those two are listed, not alerted on.
  const alerting = gaps.filter((g) => g.missing.some((f) => ALERT_FIELDS.includes(f)));
  if (!alerting.length) {
    return { ok: true, severity: 'ok', message: `All ${rows.length} review cards have outlet name and quote${summary ? ` (${summary})` : ''}`, details: gaps.length ? { gaps: gaps.slice(0, 25) } : undefined };
  }
  const message = `${alerting.length}/${rows.length} review card(s) missing outlet name or quote (${summary})`;
  return {
    ok: false,
    severity: 'warning',
    message,
    details: {
      gaps: alerting.slice(0, 25),
      // Self-declared remediation (BRO-219 pattern): alert, not a workflow. The quote comes from the next rebuild or
      // extract-pull-quotes, and an outlet id with no registry name needs a registry entry; a re-dispatch fixes neither.
      remediation: {
        kind: 'alert',
        key: `review-cards-complete:${show.id}`,
        conditionKey: `opening-night-review-cards-complete-${show.id}`,
        title: `Review cards missing outlet name or quote on ${show.title || show.id}`,
        description: message,
        severity: 'warning',
        reason: `${alerting.length} live review card(s) without an outlet display name or pull quote`,
      },
    },
  };
}

module.exports = { name, description, run };
